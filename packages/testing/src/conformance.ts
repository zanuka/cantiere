import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type AdapterContext,
  AGENT_ENV_KEYS,
  type AgentMode,
  type AgentSession,
  type CommandSpec,
  checkAdapterShape,
  type HarnessAdapter,
  type McpServerSpec,
  STATE_HINT_KINDS,
} from "@cantiere/adapters";
import { type Task, TaskSchema } from "@cantiere/core";

export interface ConformanceOptions {
  /** Task used for every check. Defaults to a synthetic task whose harness is the adapter id. */
  task?: Task;
  /** MCP servers given to adapters that declare `mcpConfig`. */
  mcpServers?: McpServerSpec[];
  /**
   * Real output your harness produces, so `detectState` can be checked against it. Each key is
   * optional; `asking` output must yield an `asking` hint and `working` output a `working` hint.
   */
  samples?: { working?: string; asking?: string };
  /** Milliseconds allowed for the process-based checks. Default 10000. */
  timeoutMs?: number;
}

export type CheckStatus = "pass" | "fail" | "skip";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  /** For a failure, what is wrong and what to change. For a skip, why. */
  message?: string;
}

export interface ConformanceReport {
  adapterId: string;
  results: CheckResult[];
  passed: boolean;
}

interface Check {
  name: string;
  /** A reason to skip, or undefined to run. */
  skipWhen?: string | undefined;
  run: () => Promise<void> | void;
}

class Failure extends Error {}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Failure(message);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function snapshotTree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out[`${path.relative(root, full)}/`] = "dir";
        await walk(full);
      } else {
        out[path.relative(root, full)] = await readFile(full, "utf8");
      }
    }
  }
  await walk(root);
  return out;
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function validateCommand(spec: CommandSpec, label: string): void {
  assert(spec && typeof spec === "object", `${label} must return {argv, env, cwd}`);
  assert(
    Array.isArray(spec.argv) &&
      spec.argv.length > 0 &&
      spec.argv.every((a) => typeof a === "string" && a.length > 0 && !a.includes("\0")),
    `${label}.argv must be a non-empty array of non-empty strings with no NUL bytes`,
  );
  assert(
    spec.env &&
      typeof spec.env === "object" &&
      Object.values(spec.env).every((v) => typeof v === "string"),
    `${label}.env must be an object of string values (a complete environment, not a delta)`,
  );
  assert(typeof spec.cwd === "string", `${label}.cwd must be a string`);
}

function validateHints(hints: unknown, label: string): asserts hints is Array<{ kind: string }> {
  assert(
    Array.isArray(hints),
    `${label} must return an array of hints (empty when nothing is detected)`,
  );
  for (const h of hints as Array<{ kind?: unknown }>) {
    assert(
      typeof h === "object" &&
        h !== null &&
        (STATE_HINT_KINDS as readonly unknown[]).includes(h.kind),
      `${label} returned a hint with kind ${JSON.stringify((h as { kind?: unknown })?.kind)}; allowed: ${STATE_HINT_KINDS.join(", ")}`,
    );
  }
}

/** A real child process standing in for a session: whatever is written to it comes back on stdout. */
async function withEchoSession<T>(
  timeoutMs: number,
  body: (session: AgentSession, waitFor: (text: string) => Promise<string>) => Promise<T>,
): Promise<T> {
  const child = spawn(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  let seen = "";
  const listeners: Array<() => void> = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d: string) => {
    seen += d;
    for (const l of listeners) l();
  });
  const session: AgentSession = {
    taskId: "conformance",
    write: (data) =>
      new Promise((resolve, reject) => child.stdin.write(data, (e) => (e ? reject(e) : resolve()))),
  };
  const waitFor = (text: string) =>
    new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Failure(
              `the session never received ${JSON.stringify(text)} within ${timeoutMs}ms; got ${JSON.stringify(seen)}`,
            ),
          ),
        timeoutMs,
      );
      const check = () => {
        if (seen.includes(text)) {
          clearTimeout(timer);
          resolve(seen);
        }
      };
      listeners.push(check);
      check();
    });
  try {
    return await body(session, waitFor);
  } finally {
    child.stdin.end();
    child.kill();
  }
}

function syntheticTask(adapter: HarnessAdapter, repo: string, worktree: string): Task {
  return TaskSchema.parse({
    schemaVersion: 1,
    id: "01k3m9x2q7a4b",
    title: "conformance task",
    prompt: "Say hello.",
    kind: "agent",
    repo,
    baseRef: "main",
    branch: "cantiere/conformance",
    worktreePath: worktree,
    harness: typeof adapter?.id === "string" && adapter.id ? adapter.id : "unknown",
    createdAt: "2026-11-15T12:00:00.000Z",
    labels: [],
    source: "manual",
  });
}

/**
 * Runs every conformance check against `adapter` and returns a report; it never throws for a failing
 * adapter. Framework-neutral: use `@cantiere/testing/vitest` to register the checks as tests, or the
 * `cantiere-adapter-conformance` binary to run them from a shell.
 */
export async function runAdapterConformance(
  adapter: HarnessAdapter,
  options: ConformanceOptions = {},
): Promise<ConformanceReport> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const root = await mkdtemp(path.join(tmpdir(), "cantiere-conformance-"));
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "worktree");
  const results: CheckResult[] = [];
  try {
    await mkdir(repo, { recursive: true });
    await mkdir(worktree, { recursive: true });
    const task = options.task ?? syntheticTask(adapter, repo, worktree);
    const caps = adapter.capabilities;
    const modes: AgentMode[] = [];
    if (caps?.headless) modes.push("headless");
    if (caps?.interactive) modes.push("interactive");
    const mcpServers: McpServerSpec[] = options.mcpServers ?? [
      { name: "conformance-server", command: "node", args: ["server.js"], env: { EXAMPLE: "1" } },
    ];
    const ctxFor = (mode: AgentMode, extra: Partial<AdapterContext> = {}): AdapterContext => ({
      repo,
      worktree,
      reportBinary: "/opt/cantiere/bin/cantiere",
      eventsPath: path.join(repo, ".cantiere", "tasks", task.id, "events.jsonl"),
      mode,
      ...extra,
    });
    const mode = modes[0] ?? "headless";

    const checks: Check[] = [
      {
        name: "shape: id, apiVersion, capabilities and methods are well-formed",
        run() {
          const problems = checkAdapterShape(adapter);
          assert(problems.length === 0, problems.join("; "));
        },
      },
      {
        name: "buildCommand: returns a valid {argv, env, cwd} in every supported mode",
        skipWhen: modes.length === 0 ? "no supported mode declared" : undefined,
        run() {
          for (const m of modes) {
            const spec = adapter.buildCommand(deepFreeze(clone(task)), deepFreeze(ctxFor(m)));
            validateCommand(spec, `buildCommand (${m})`);
            assert(
              spec.cwd === worktree,
              `buildCommand (${m}).cwd must be the worktree ${worktree}, got ${spec.cwd}`,
            );
          }
        },
      },
      {
        name: "buildCommand: passes the full CANTIERE_* environment contract",
        run() {
          const ctx = ctxFor(mode);
          const spec = adapter.buildCommand(clone(task), ctx);
          const expected: Record<string, string> = {
            CANTIERE_TASK: task.id,
            CANTIERE_REPO: ctx.repo,
            CANTIERE_WORKTREE: ctx.worktree,
            CANTIERE_REPORT: ctx.reportBinary,
            CANTIERE_EVENTS: ctx.eventsPath,
          };
          for (const key of AGENT_ENV_KEYS) {
            assert(
              spec.env[key] === expected[key],
              `env.${key} must be ${JSON.stringify(expected[key])}, got ${JSON.stringify(spec.env[key])}`,
            );
          }
        },
      },
      {
        name: "buildCommand: the contract cannot be overridden through baseEnv",
        run() {
          const ctx = ctxFor(mode, {
            baseEnv: {
              CANTIERE_TASK: "spoofed",
              CANTIERE_WORKTREE: "/spoofed",
              CUSTOM_PASSTHROUGH: "yes",
            },
          });
          const spec = adapter.buildCommand(clone(task), ctx);
          assert(
            spec.env.CANTIERE_TASK === task.id,
            "baseEnv must not override CANTIERE_TASK; set contract variables after baseEnv",
          );
          assert(
            spec.env.CANTIERE_WORKTREE === worktree,
            "baseEnv must not override CANTIERE_WORKTREE",
          );
          assert(
            spec.env.CUSTOM_PASSTHROUGH === "yes",
            "baseEnv entries (for example credentials already in the user's shell) must be passed through",
          );
        },
      },
      {
        name: "buildCommand: is deterministic and does not mutate its inputs",
        run() {
          const frozenTask = deepFreeze(clone(task));
          const frozenCtx = deepFreeze(
            ctxFor(mode, { mcpServers: caps?.mcpConfig ? mcpServers : [] }),
          );
          const a = adapter.buildCommand(frozenTask, frozenCtx);
          const b = adapter.buildCommand(frozenTask, frozenCtx);
          assert(
            JSON.stringify(a) === JSON.stringify(b),
            "buildCommand must return the same command for the same input",
          );
        },
      },
      {
        name: "buildCommand: rejects a mode the adapter does not support with an actionable error",
        skipWhen: caps?.headless && caps?.interactive ? "adapter supports both modes" : undefined,
        run() {
          const unsupported: AgentMode = caps?.headless ? "interactive" : "headless";
          let message = "";
          try {
            adapter.buildCommand(clone(task), ctxFor(unsupported));
          } catch (e) {
            message = e instanceof Error ? e.message : String(e);
          }
          assert(
            message.length > 0,
            `buildCommand must throw when asked for ${unsupported} mode but capabilities.${unsupported} is false`,
          );
        },
      },
      {
        name: "prepareWorkspace: dry run reports changes and writes nothing",
        async run() {
          const before = await snapshotTree(root);
          const planned = await adapter.prepareWorkspace(
            worktree,
            ctxFor(mode, { dryRun: true, mcpServers: caps?.mcpConfig ? mcpServers : [] }),
          );
          assert(
            Array.isArray(planned),
            "prepareWorkspace must return an array of planned writes (empty when there are none)",
          );
          const after = await snapshotTree(root);
          assert(
            JSON.stringify(before) === JSON.stringify(after),
            "prepareWorkspace wrote to disk although ctx.dryRun was set",
          );
        },
      },
      {
        name: "prepareWorkspace: writes only inside the worktree, and what it reports",
        async run() {
          const before = await snapshotTree(repo);
          const planned = await adapter.prepareWorkspace(
            worktree,
            ctxFor(mode, { mcpServers: caps?.mcpConfig ? mcpServers : [] }),
          );
          for (const w of planned) {
            assert(
              path.isAbsolute(w.path) && isInside(worktree, w.path),
              `planned write ${w.path} must be an absolute path inside the worktree`,
            );
            await stat(w.path).catch(() => {
              throw new Failure(`prepareWorkspace reported ${w.path} but did not write it`);
            });
          }
          const afterRepo = await snapshotTree(repo);
          assert(
            JSON.stringify(before) === JSON.stringify(afterRepo),
            "prepareWorkspace changed the primary repository; an adapter may only write in the task worktree",
          );
          const tree = await snapshotTree(root);
          const outside = Object.keys(tree).filter(
            (p) =>
              !p.startsWith("worktree/") &&
              !p.startsWith("repo/") &&
              p !== "worktree/" &&
              p !== "repo/",
          );
          assert(
            outside.length === 0,
            `prepareWorkspace wrote outside the worktree: ${outside.join(", ")}`,
          );
        },
      },
      {
        name: "prepareWorkspace: is idempotent",
        async run() {
          const ctx = ctxFor(mode, { mcpServers: caps?.mcpConfig ? mcpServers : [] });
          await adapter.prepareWorkspace(worktree, ctx);
          const first = await snapshotTree(worktree);
          await adapter.prepareWorkspace(worktree, ctx);
          const second = await snapshotTree(worktree);
          assert(
            JSON.stringify(first) === JSON.stringify(second),
            "running prepareWorkspace twice produced different files; it must be idempotent",
          );
        },
      },
      {
        name: "prepareWorkspace: writes the MCP server list when mcpConfig is declared",
        skipWhen: caps?.mcpConfig ? undefined : "mcpConfig not declared",
        async run() {
          const planned = await adapter.prepareWorkspace(worktree, ctxFor(mode, { mcpServers }));
          const written = await Promise.all(
            planned.map((w) => readFile(w.path, "utf8").catch(() => "")),
          );
          const spec = adapter.buildCommand(clone(task), ctxFor(mode, { mcpServers }));
          const haystack = [...written, ...spec.argv, ...Object.values(spec.env)].join("\n");
          for (const s of mcpServers) {
            assert(
              haystack.includes(s.name),
              `MCP server "${s.name}" appears in neither the files from prepareWorkspace nor the command from buildCommand`,
            );
          }
        },
      },
      {
        name: "deliver: steering text reaches a running session",
        skipWhen: caps?.steerInput ? undefined : "steerInput not declared",
        async run() {
          await withEchoSession(timeoutMs, async (session, waitFor) => {
            await adapter.deliver(session, "steer-marker-4711");
            await waitFor("steer-marker-4711");
          });
        },
      },
      {
        name: "deliver: rejects with an actionable error when steerInput is not declared",
        skipWhen: caps?.steerInput ? "steerInput declared" : undefined,
        async run() {
          await withEchoSession(timeoutMs, async (session) => {
            let message = "";
            try {
              await adapter.deliver(session, "hello");
            } catch (e) {
              message = e instanceof Error ? e.message : String(e);
            }
            assert(
              message.length > 0,
              "deliver must reject when capabilities.steerInput is false (throw UnsupportedCapabilityError)",
            );
          });
        },
      },
      {
        name: "detectState: tolerates empty, garbage and huge output",
        skipWhen: adapter.detectState ? undefined : "detectState not implemented (optional)",
        run() {
          const detect = adapter.detectState as (o: string) => unknown;
          for (const [label, output] of [
            ["empty output", ""],
            ["binary garbage", "\u0000\u001b[31m�\n{not json"],
            ["a partial line", '{"type":'],
            ["a 2 MB line", "x".repeat(2_000_000)],
          ] as const) {
            let hints: unknown;
            try {
              hints = detect(output);
            } catch (e) {
              throw new Failure(
                `detectState threw on ${label}: ${e instanceof Error ? e.message : String(e)}; it must never throw`,
              );
            }
            validateHints(hints, `detectState on ${label}`);
          }
        },
      },
      {
        name: "detectState: recognises the supplied sample output",
        skipWhen: !adapter.detectState
          ? "detectState not implemented (optional)"
          : options.samples?.asking || options.samples?.working
            ? undefined
            : "no samples supplied (pass options.samples)",
        run() {
          const detect = adapter.detectState as (o: string) => Array<{ kind: string }>;
          if (options.samples?.asking !== undefined) {
            const hints = detect(options.samples.asking);
            validateHints(hints, "detectState(asking sample)");
            assert(
              hints.some((h) => h.kind === "asking"),
              "detectState did not return an 'asking' hint for the asking sample",
            );
          }
          if (options.samples?.working !== undefined) {
            const hints = detect(options.samples.working);
            validateHints(hints, "detectState(working sample)");
            assert(
              hints.some((h) => h.kind === "working"),
              "detectState did not return a 'working' hint for the working sample",
            );
          }
        },
      },
      {
        name: "resumeCommand: returns a valid command carrying the environment contract",
        skipWhen: caps?.resume ? undefined : "resume not declared",
        run() {
          const resume = adapter.resumeCommand;
          assert(resume, "capabilities.resume is true but resumeCommand is missing");
          const ctx = ctxFor(mode, { resumeToken: "session-123" });
          const spec = resume.call(adapter, clone(task), ctx);
          validateCommand(spec, "resumeCommand");
          assert(
            spec.cwd === worktree,
            `resumeCommand.cwd must be the worktree ${worktree}, got ${spec.cwd}`,
          );
          for (const key of AGENT_ENV_KEYS) {
            assert(typeof spec.env[key] === "string", `resumeCommand env is missing ${key}`);
          }
        },
      },
    ];

    for (const check of checks) {
      if (check.skipWhen !== undefined) {
        results.push({ name: check.name, status: "skip", message: check.skipWhen });
        continue;
      }
      try {
        await check.run();
        results.push({ name: check.name, status: "pass" });
      } catch (e) {
        results.push({
          name: check.name,
          status: "fail",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  return {
    adapterId: typeof adapter?.id === "string" ? adapter.id : "(unknown)",
    results,
    passed: results.every((r) => r.status !== "fail"),
  };
}

/** Plain-text report for terminals and CI logs. */
export function formatConformanceReport(report: ConformanceReport): string {
  const mark = { pass: "ok  ", fail: "FAIL", skip: "skip" } as const;
  const lines = [`Adapter "${report.adapterId}":`];
  for (const r of report.results) {
    lines.push(`  ${mark[r.status]} ${r.name}${r.message ? `\n       ${r.message}` : ""}`);
  }
  const failed = report.results.filter((r) => r.status === "fail").length;
  lines.push(report.passed ? "Conformant." : `${failed} check(s) failed.`);
  return lines.join("\n");
}

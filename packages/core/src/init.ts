import { constants } from "node:fs";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.js";
import { type DefaultBranchSource, detectDefaultBranch, runGit, runGitRaw } from "./git.js";
import { SCHEMA_VERSION } from "./schema-version.js";
import { STATE_DIR_NAME, StoreConfigSchema, stateDirFor } from "./store.js";
import { primaryCheckoutOf } from "./worktree.js";

export const SESSION_HOSTS = ["tmux", "process"] as const;
export type SessionHost = (typeof SESSION_HOSTS)[number];

/** `.cantiere/config.json`: the store's `schemaVersion` plus the per-repo settings `init` writes. */
export const CantiereConfigSchema = StoreConfigSchema.extend({
  /** Plain harness name; the preflight only checks that this binary is on PATH. */
  harness: z.string().min(1),
  /** `tmux` hosts interactive agents; `process` runs detached with log capture (ADR 0004). */
  sessionHost: z.enum(SESSION_HOSTS),
  maxConcurrentAgents: z.number().int().positive(),
  /** Absolute directory holding task worktrees, outside the primary checkout. */
  worktreeRoot: z.string().min(1),
  baseBranch: z.string().min(1),
  /** Commands a task must pass before it can land; run in order. Empty means no automated gate. */
  gateCommands: z.array(z.string().min(1)),
  /** Prefix of task branches. */
  branchPrefix: z.string().min(1),
});
export type CantiereConfig = z.infer<typeof CantiereConfigSchema>;

export const DEFAULT_HARNESS = "claude";
export const DEFAULT_SESSION_HOST: SessionHost = "tmux";
export const DEFAULT_MAX_CONCURRENT_AGENTS = 4;
export const DEFAULT_BRANCH_PREFIX = "cantiere/";

/** Subdirectories of `.cantiere/` the store expects; created up front so a fresh yard is complete. */
const RUNTIME_SUBDIRS = ["tasks", "locks"] as const;

/** The line added to `.git/info/exclude`; it covers every runtime directory under `.cantiere/`. */
export const EXCLUDE_ENTRY = `/${STATE_DIR_NAME}/`;
const EXCLUDE_ALIASES = new Set([
  EXCLUDE_ENTRY,
  STATE_DIR_NAME,
  `/${STATE_DIR_NAME}`,
  `${STATE_DIR_NAME}/`,
]);
const EXCLUDE_COMMENT = "# Cantiere runtime state (added by `cantiere init`)";

/** `init` cannot proceed; the message says what is wrong and what to do about it. */
export class InitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InitError";
  }
}

export interface InitOptions {
  /** Any directory inside the repository (or one of its worktrees). */
  cwd: string;
  harness?: string;
  sessionHost?: SessionHost;
  maxConcurrentAgents?: number;
  baseBranch?: string;
  /** Environment used to resolve binaries on PATH. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export type PlannedWriteKind = "mkdir" | "write-config" | "write-exclude";

export interface PlannedWrite {
  kind: PlannedWriteKind;
  path: string;
  detail: string;
}

export interface PreflightCheck {
  name: string;
  ok: boolean;
  /** Resolved binary path when found. */
  path?: string;
  /** What is wrong and how to fix it; only set when `ok` is false. */
  fix?: string;
}

export type ConfigStatus = "create" | "fill" | "unchanged";

export interface InitPlan {
  /** The primary checkout; `.cantiere/` lives directly inside it. */
  root: string;
  stateDir: string;
  configPath: string;
  excludePath: string;
  /** The config that is, or will be, on disk. An existing file is never altered beyond `fill`. */
  config: CantiereConfig;
  configStatus: ConfigStatus;
  baseBranchSource: DefaultBranchSource | "flag" | "existing-config";
  writes: PlannedWrite[];
  preflight: PreflightCheck[];
  warnings: string[];
}

export interface InitResult {
  plan: InitPlan;
  /** True when anything was written. False for a re-run that found everything in place. */
  changed: boolean;
}

/** Finds `binary` on `PATH` (or checks it directly when it contains a path separator). */
export async function findExecutable(
  binary: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const candidates = binary.includes(path.sep)
    ? [path.resolve(binary)]
    : (env.PATH ?? "")
        .split(path.delimiter)
        .filter((dir) => dir !== "")
        .map((dir) => path.join(dir, binary));
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; try the next PATH entry.
    }
  }
  return undefined;
}

async function resolveRoot(cwd: string): Promise<string> {
  const top = await runGitRaw(cwd, ["rev-parse", "--show-toplevel"]).catch((error: Error) => {
    throw new InitError(`${error.message} Install git, then run \`cantiere init\` again.`);
  });
  if (top.code !== 0) {
    throw new InitError(
      `${cwd} is not inside a git repository, so there is nothing to set up. ` +
        "Run `cantiere init` from inside a repository (or run `git init` first).",
    );
  }
  try {
    return await primaryCheckoutOf(top.stdout.trim());
  } catch (error) {
    throw new InitError(
      `${(error as Error).message} Run \`cantiere init\` from a normal checkout.`,
    );
  }
}

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function exists(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

function describeIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/** Reads and validates an existing config. A bare store seed (only `schemaVersion`) is fillable. */
async function readExistingConfig(
  configPath: string,
  text: string,
): Promise<{ parsed: CantiereConfig } | { seed: Record<string, unknown> }> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new InitError(
      `${configPath} is not valid JSON (${(error as Error).message}). ` +
        "Fix or delete it, then run `cantiere init` again. Cantiere will not overwrite it.",
    );
  }
  const keys =
    json && typeof json === "object" && !Array.isArray(json) ? Object.keys(json) : undefined;
  if (keys?.length === 1 && keys[0] === "schemaVersion") {
    const seed = StoreConfigSchema.safeParse(json);
    if (seed.success) return { seed: seed.data };
  }
  const parsed = CantiereConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new InitError(
      `${configPath} is not a valid Cantiere config (${describeIssues(parsed.error)}). ` +
        "Fix those fields by hand, then run `cantiere init` again. Cantiere will not overwrite it.",
    );
  }
  if (parsed.data.schemaVersion > SCHEMA_VERSION) {
    throw new InitError(
      `${configPath} has schemaVersion ${parsed.data.schemaVersion}, newer than this Cantiere supports (${SCHEMA_VERSION}). Upgrade Cantiere first.`,
    );
  }
  return { parsed: parsed.data };
}

function excludeHasEntry(text: string): boolean {
  return text.split(/\r?\n/).some((line) => EXCLUDE_ALIASES.has(line.trim()));
}

function appendExclude(text: string | undefined): string {
  const base = text ?? "";
  const separator = base === "" || base.endsWith("\n") ? "" : "\n";
  return `${base}${separator}${EXCLUDE_COMMENT}\n${EXCLUDE_ENTRY}\n`;
}

/**
 * Works out what `init` would do without writing anything: detects the repository and its default
 * branch, runs the preflight, and lists the writes still needed. An existing config is kept as it
 * is (its values win over flags), so re-running never loses an edit.
 */
export async function planInit(options: InitOptions): Promise<InitPlan> {
  const env = options.env ?? process.env;
  const root = await resolveRoot(options.cwd);
  const stateDir = stateDirFor(root);
  const configPath = path.join(stateDir, "config.json");
  const excludePath = (
    await runGit(root, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"])
  ).stdout.trim();

  const warnings: string[] = [];
  const existingText = await readIfExists(configPath);
  const existing =
    existingText === undefined ? undefined : await readExistingConfig(configPath, existingText);

  let config: CantiereConfig;
  let configStatus: ConfigStatus;
  let baseBranchSource: InitPlan["baseBranchSource"];
  if (existing && "parsed" in existing) {
    config = existing.parsed;
    configStatus = "unchanged";
    baseBranchSource = "existing-config";
    const flagNames = {
      harness: "harness",
      sessionHost: "session-host",
      maxConcurrentAgents: "max-agents",
      baseBranch: "base-branch",
    } as const;
    const ignored = (Object.keys(flagNames) as (keyof typeof flagNames)[])
      .filter((key) => options[key] !== undefined && options[key] !== config[key])
      .map((key) => flagNames[key]);
    if (ignored.length > 0) {
      warnings.push(
        `${configPath} already exists, so --${ignored.join(", --")} had no effect. Edit the file to change it.`,
      );
    }
  } else {
    let baseBranch = options.baseBranch;
    baseBranchSource = "flag";
    if (baseBranch === undefined) {
      const detected = await detectDefaultBranch(root);
      baseBranch = detected.name;
      baseBranchSource = detected.source;
    }
    const resolved = await runGitRaw(root, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${baseBranch}^{commit}`,
    ]);
    if (resolved.code !== 0) {
      warnings.push(
        `Base branch "${baseBranch}" has no commits yet. Make a first commit (or pass --base-branch) before dispatching tasks.`,
      );
    }
    const worktreeRoot = path.join(path.dirname(root), `${path.basename(root)}.worktrees`);
    config = CantiereConfigSchema.parse({
      ...(existing ? existing.seed : {}),
      schemaVersion: SCHEMA_VERSION,
      harness: options.harness ?? DEFAULT_HARNESS,
      sessionHost: options.sessionHost ?? DEFAULT_SESSION_HOST,
      maxConcurrentAgents: options.maxConcurrentAgents ?? DEFAULT_MAX_CONCURRENT_AGENTS,
      worktreeRoot,
      baseBranch,
      gateCommands: [],
      branchPrefix: DEFAULT_BRANCH_PREFIX,
    });
    configStatus = existing ? "fill" : "create";
  }

  const writes: PlannedWrite[] = [];
  if (!(await exists(stateDir))) {
    writes.push({ kind: "mkdir", path: stateDir, detail: "create the runtime directory" });
  }
  for (const sub of RUNTIME_SUBDIRS) {
    const dir = path.join(stateDir, sub);
    if (!(await exists(dir))) writes.push({ kind: "mkdir", path: dir, detail: "create directory" });
  }
  if (configStatus !== "unchanged") {
    writes.push({
      kind: "write-config",
      path: configPath,
      detail: configStatus === "fill" ? "fill in the empty store config" : "write default settings",
    });
  }
  const excludeText = await readIfExists(excludePath);
  if (excludeText === undefined || !excludeHasEntry(excludeText)) {
    writes.push({
      kind: "write-exclude",
      path: excludePath,
      detail: `append ${EXCLUDE_ENTRY} (keeps runtime state out of git without touching .gitignore)`,
    });
  }

  const preflight: PreflightCheck[] = [];
  const gitVersion = await runGitRaw(root, ["--version"]);
  preflight.push({
    name: "git",
    ok: gitVersion.code === 0,
    path: "git",
    ...(gitVersion.code === 0 ? {} : { fix: "Install git and put it on PATH." }),
  });
  const binaries = [config.harness, ...(config.sessionHost === "tmux" ? ["tmux"] : [])];
  for (const binary of binaries) {
    const found = await findExecutable(binary, env);
    const fix =
      binary === "tmux"
        ? "Install tmux (for example `brew install tmux`), or pass --session-host process for headless agents."
        : `Install ${binary} and put it on PATH, or pass --harness <name> for a different one.`;
    preflight.push(
      found ? { name: binary, ok: true, path: found } : { name: binary, ok: false, fix },
    );
  }

  return {
    root,
    stateDir,
    configPath,
    excludePath,
    config,
    configStatus,
    baseBranchSource,
    writes,
    preflight,
    warnings,
  };
}

/** Performs the writes in `plan`. Refuses when the preflight failed; `plan` itself is unchanged. */
export async function applyInit(plan: InitPlan): Promise<InitResult> {
  const failed = plan.preflight.filter((check) => !check.ok);
  if (failed.length > 0) {
    throw new InitError(
      `Preflight failed, nothing was written:\n${failed.map((c) => `  - ${c.name}: ${c.fix}`).join("\n")}`,
    );
  }
  for (const write of plan.writes) {
    if (write.kind === "mkdir") await mkdir(write.path, { recursive: true });
  }
  for (const write of plan.writes) {
    if (write.kind === "write-config") {
      await writeFileAtomic(write.path, `${JSON.stringify(plan.config, null, 2)}\n`);
    } else if (write.kind === "write-exclude") {
      // Re-read at write time so an entry added since planning is not duplicated.
      const current = await readIfExists(write.path);
      if (current !== undefined && excludeHasEntry(current)) continue;
      await mkdir(path.dirname(write.path), { recursive: true });
      await writeFileAtomic(write.path, appendExclude(current));
    }
  }
  return { plan, changed: plan.writes.length > 0 };
}

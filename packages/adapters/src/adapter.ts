import type { Task } from "@cantiere/core";

/**
 * Version of the harness adapter interface. It is a single integer: it changes only for a
 * breaking change, and the runtime refuses an adapter whose `apiVersion` differs from its own.
 * See docs/adapters.md for the breaking-change policy.
 */
export const ADAPTER_API_VERSION = 1;

/** The ways a harness can be hosted (see ADR 0004): `headless` runs to completion, `interactive` is a terminal UI. */
export const AGENT_MODES = ["headless", "interactive"] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

/** What a harness can do. The runtime only relies on a feature the adapter declares. */
export interface AdapterCapabilities {
  /** Can run a prompt to completion without a human (for example `claude -p`, `codex exec`). */
  readonly headless: boolean;
  /** Can run as a terminal UI that accepts input while running. */
  readonly interactive: boolean;
  /** Can continue an earlier session; requires `resumeCommand`. */
  readonly resume: boolean;
  /** Accepts text sent to a running session through `deliver`. */
  readonly steerInput: boolean;
  /** Can be given MCP servers through `prepareWorkspace` and/or `buildCommand`. */
  readonly mcpConfig: boolean;
  /** Can emit machine-readable output that `detectState` can read. */
  readonly jsonOutput: boolean;
}

export const CAPABILITY_KEYS = [
  "headless",
  "interactive",
  "resume",
  "steerInput",
  "mcpConfig",
  "jsonOutput",
] as const satisfies readonly (keyof AdapterCapabilities)[];

/** An MCP server the agent should be able to call (for example a Strumentario server, ADR 0006). */
export interface McpServerSpec {
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

/** Environment variables every agent receives. Values are absolute paths (or the task id). */
export interface AgentEnv {
  /** The task id. */
  CANTIERE_TASK: string;
  /** Absolute path of the primary repository (never to be modified by the agent). */
  CANTIERE_REPO: string;
  /** Absolute path of the task's isolated worktree; the agent's working directory. */
  CANTIERE_WORKTREE: string;
  /** Absolute path of the `cantiere` binary, used by the agent to report status. */
  CANTIERE_REPORT: string;
  /** Absolute path of the task's events.jsonl. The agent may read it, and must not write it. */
  CANTIERE_EVENTS: string;
}

export const AGENT_ENV_KEYS = [
  "CANTIERE_TASK",
  "CANTIERE_REPO",
  "CANTIERE_WORKTREE",
  "CANTIERE_REPORT",
  "CANTIERE_EVENTS",
] as const satisfies readonly (keyof AgentEnv)[];

/** What the runtime knows when it asks an adapter to act. Adapters must not mutate it. */
export interface AdapterContext {
  readonly repo: string;
  readonly worktree: string;
  /** Path of the `cantiere` binary (becomes `CANTIERE_REPORT`). */
  readonly reportBinary: string;
  /** Path of the task's events.jsonl (becomes `CANTIERE_EVENTS`). */
  readonly eventsPath: string;
  readonly mode: AgentMode;
  readonly mcpServers?: readonly McpServerSpec[];
  /** Harness-native session id to continue, for `resumeCommand`. */
  readonly resumeToken?: string;
  /** Extra environment to pass through, such as credentials the user's shell already has. */
  readonly baseEnv?: Readonly<Record<string, string>>;
  /** When true, `prepareWorkspace` must report what it would write and write nothing. */
  readonly dryRun?: boolean;
}

/** A process to start. `cwd` is the worktree; `env` is the complete environment (not a delta). */
export interface CommandSpec {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}

/** A file `prepareWorkspace` wrote, or would write when `ctx.dryRun` is set. Paths are absolute, inside the worktree. */
export interface PlannedWorkspaceWrite {
  readonly path: string;
  readonly action: "create" | "update" | "unchanged";
  readonly description?: string;
}

/** A live agent session as the session host sees it. The adapter never owns the process. */
export interface AgentSession {
  readonly taskId: string;
  /** Sends raw text to the agent's input (stdin, or the terminal for a tmux host). */
  write(data: string): Promise<void>;
}

/** What `detectState` thinks the agent is doing, from raw output. Hints are advisory; reported status wins. */
export type StateHint =
  | { readonly kind: "working"; readonly detail?: string }
  | { readonly kind: "asking"; readonly question: string }
  | { readonly kind: "idle"; readonly detail?: string }
  | { readonly kind: "error"; readonly detail: string }
  | { readonly kind: "session"; readonly token: string };

export const STATE_HINT_KINDS = ["working", "asking", "idle", "error", "session"] as const;

export interface HarnessAdapter {
  /** Matches the `harness` field of config and tasks. */
  readonly id: string;
  /** Must equal {@link ADAPTER_API_VERSION} of the runtime loading it. */
  readonly apiVersion: number;
  readonly capabilities: AdapterCapabilities;

  /** The process to start for this task. Pure: no I/O, no mutation, same input gives same output. */
  buildCommand(task: Task, ctx: AdapterContext): CommandSpec;

  /**
   * Writes harness config into the worktree (for example an MCP server list). Idempotent, writes only
   * inside `worktree`, and with `ctx.dryRun` writes nothing and reports what it would.
   */
  prepareWorkspace(worktree: string, ctx: AdapterContext): Promise<PlannedWorkspaceWrite[]>;

  /** Sends a steering message to a running session. Rejects with an actionable error unless `steerInput`. */
  deliver(session: AgentSession, message: string): Promise<void>;

  /** Reads raw output and returns hints. Pure, never throws, tolerates partial or non-text input. */
  detectState?(output: string): StateHint[];

  /** The process that continues an earlier session. Present exactly when `capabilities.resume`. */
  resumeCommand?(task: Task, ctx: AdapterContext): CommandSpec;
}

/** The five variables of the environment contract, derived from the runtime context. */
export function buildAgentEnv(task: Pick<Task, "id">, ctx: AdapterContext): AgentEnv {
  return {
    CANTIERE_TASK: task.id,
    CANTIERE_REPO: ctx.repo,
    CANTIERE_WORKTREE: ctx.worktree,
    CANTIERE_REPORT: ctx.reportBinary,
    CANTIERE_EVENTS: ctx.eventsPath,
  };
}

/**
 * Complete child environment: `ctx.baseEnv` first, then the contract variables, which an adapter or
 * the user's environment can never override.
 */
export function buildCommandEnv(
  task: Pick<Task, "id">,
  ctx: AdapterContext,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return { ...ctx.baseEnv, ...extra, ...buildAgentEnv(task, ctx) };
}

export class UnsupportedCapabilityError extends Error {
  constructor(adapterId: string, capability: keyof AdapterCapabilities, hint: string) {
    super(`Adapter "${adapterId}" does not support ${capability}. ${hint}`);
    this.name = "UnsupportedCapabilityError";
  }
}

/** Whether the runtime can load an adapter built for `apiVersion`. */
export function isSupportedApiVersion(apiVersion: unknown): boolean {
  return apiVersion === ADAPTER_API_VERSION;
}

/** Structural problems with an adapter object; empty means it is well-formed. Used by the loader and conformance. */
export function checkAdapterShape(value: unknown): string[] {
  const problems: string[] = [];
  if (typeof value !== "object" || value === null) return ["adapter must be an object"];
  const a = value as Record<string, unknown>;
  if (typeof a.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(a.id)) {
    problems.push('id must be a lowercase string such as "claude-code" (letters, digits, dashes)');
  }
  if (!isSupportedApiVersion(a.apiVersion)) {
    problems.push(
      `apiVersion is ${JSON.stringify(a.apiVersion)} but this runtime implements ${ADAPTER_API_VERSION}; rebuild the adapter against the current @cantiere/adapters`,
    );
  }
  const caps = a.capabilities as Record<string, unknown> | undefined;
  if (typeof caps !== "object" || caps === null) {
    problems.push("capabilities must be an object");
  } else {
    for (const key of CAPABILITY_KEYS) {
      if (typeof caps[key] !== "boolean") problems.push(`capabilities.${key} must be a boolean`);
    }
    if (caps.headless === false && caps.interactive === false) {
      problems.push("capabilities must enable headless, interactive or both");
    }
  }
  for (const method of ["buildCommand", "prepareWorkspace", "deliver"] as const) {
    if (typeof a[method] !== "function") problems.push(`${method} must be a function`);
  }
  for (const method of ["detectState", "resumeCommand"] as const) {
    if (a[method] !== undefined && typeof a[method] !== "function") {
      problems.push(`${method} must be a function when present`);
    }
  }
  if (caps && typeof caps === "object") {
    if (caps.resume === true && typeof a.resumeCommand !== "function") {
      problems.push("capabilities.resume is true but resumeCommand is missing");
    }
    if (caps.resume === false && a.resumeCommand !== undefined) {
      problems.push("resumeCommand is defined but capabilities.resume is false");
    }
  }
  return problems;
}

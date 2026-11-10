import { z } from "zod";

/**
 * Lifecycle states. `running`, `blocked`, `needs-decision` and `done` are the
 * agent-reported vocabulary (working, blocked, needs a decision, done).
 */
export const TASK_STATES = [
  "queued",
  "provisioning",
  "running",
  "blocked",
  "needs-decision",
  "done",
  "landing",
  "landed",
  "failed",
  "cancelled",
  "abandoned",
] as const;

export const TaskStateSchema = z.enum(TASK_STATES);
export type TaskState = z.infer<typeof TaskStateSchema>;

/** Agent-reported vocabulary mapped onto lifecycle states. */
export const REPORTED_STATUS_TO_STATE = {
  working: "running",
  blocked: "blocked",
  "needs-decision": "needs-decision",
  done: "done",
} as const satisfies Record<string, TaskState>;

/** Facts a guard may check; supplied by the caller (supervisor, land flow) at transition time. */
export interface TransitionContext {
  /** Worktree and branch exist for the task. */
  provisioned?: boolean;
  /** A human (or an opted-in project policy) approved the action. */
  approved?: boolean;
  /** Why the task failed, was cancelled or abandoned. */
  reason?: string;
}

interface Rule {
  to: TaskState;
  /** Returns an actionable message when the guard rejects, otherwise undefined. */
  guard?: (ctx: TransitionContext) => string | undefined;
}

const needsReason = (what: string) => (ctx: TransitionContext) =>
  ctx.reason?.trim()
    ? undefined
    : `Recording ${what} requires a reason; pass { reason } describing why.`;

const needsProvisioned = (ctx: TransitionContext) =>
  ctx.provisioned
    ? undefined
    : "The task has no worktree and branch yet; provision them before running.";

const needsApproval = (what: string) => (ctx: TransitionContext) =>
  ctx.approved
    ? undefined
    : `${what} is an explicit gate; it needs approval (pass { approved: true }).`;

const fail: Rule = { to: "failed", guard: needsReason("a failure") };
const cancel: Rule = { to: "cancelled", guard: needsReason("a cancellation") };
const abandon: Rule = {
  to: "abandoned",
  guard: (ctx) =>
    needsApproval("Abandoning a task (its worktree becomes removable)")(ctx) ??
    needsReason("an abandonment")(ctx),
};

/** The transition table. Anything not listed is illegal. */
export const TRANSITIONS: Record<TaskState, readonly Rule[]> = {
  queued: [{ to: "provisioning" }, cancel],
  provisioning: [{ to: "running", guard: needsProvisioned }, fail, cancel],
  running: [{ to: "blocked" }, { to: "needs-decision" }, { to: "done" }, fail, cancel],
  blocked: [{ to: "running" }, { to: "needs-decision" }, fail, cancel],
  "needs-decision": [{ to: "running" }, { to: "blocked" }, fail, cancel],
  done: [{ to: "landing", guard: needsApproval("Landing") }, cancel, abandon],
  // A landing that does not complete returns to done so it can be retried or reviewed.
  landing: [{ to: "landed" }, { to: "done" }, fail],
  landed: [],
  failed: [{ to: "queued" }, abandon],
  cancelled: [{ to: "queued" }, abandon],
  abandoned: [],
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: TaskState,
    readonly to: TaskState,
    detail: string,
  ) {
    super(`Illegal task transition ${from} -> ${to}: ${detail}`);
    this.name = "IllegalTransitionError";
  }
}

/** Legal target states from `from`, ignoring guards. */
export function nextStates(from: TaskState): TaskState[] {
  return TRANSITIONS[from].map((rule) => rule.to);
}

/** Returns the target state, or throws IllegalTransitionError explaining what to do. */
export function transition(from: TaskState, to: TaskState, ctx: TransitionContext = {}): TaskState {
  const rule = TRANSITIONS[from].find((r) => r.to === to);
  if (!rule) {
    const allowed = nextStates(from);
    throw new IllegalTransitionError(
      from,
      to,
      allowed.length
        ? `allowed from ${from}: ${allowed.join(", ")}.`
        : `${from} is terminal; no further transitions.`,
    );
  }
  const rejection = rule.guard?.(ctx);
  if (rejection) throw new IllegalTransitionError(from, to, rejection);
  return to;
}

export function canTransition(
  from: TaskState,
  to: TaskState,
  ctx: TransitionContext = {},
): boolean {
  try {
    transition(from, to, ctx);
    return true;
  } catch {
    return false;
  }
}

export function isTerminal(state: TaskState): boolean {
  return TRANSITIONS[state].length === 0;
}

/** Only landed and abandoned work may have its worktree removed (never lose work). */
export function permitsWorktreeRemoval(state: TaskState): boolean {
  return state === "landed" || state === "abandoned";
}

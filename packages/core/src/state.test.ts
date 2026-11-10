import { describe, expect, it } from "vitest";
import {
  canTransition,
  IllegalTransitionError,
  isTerminal,
  nextStates,
  permitsWorktreeRemoval,
  REPORTED_STATUS_TO_STATE,
  TASK_STATES,
  type TaskState,
  TRANSITIONS,
  type TransitionContext,
  transition,
} from "./state.js";

/** Context satisfying every guard. */
const FULL: TransitionContext = { provisioned: true, approved: true, reason: "because" };

const LEGAL: ReadonlyArray<readonly [TaskState, TaskState]> = [
  ["queued", "provisioning"],
  ["queued", "cancelled"],
  ["provisioning", "running"],
  ["provisioning", "failed"],
  ["provisioning", "cancelled"],
  ["running", "blocked"],
  ["running", "needs-decision"],
  ["running", "done"],
  ["running", "failed"],
  ["running", "cancelled"],
  ["blocked", "running"],
  ["blocked", "needs-decision"],
  ["blocked", "failed"],
  ["blocked", "cancelled"],
  ["needs-decision", "running"],
  ["needs-decision", "blocked"],
  ["needs-decision", "failed"],
  ["needs-decision", "cancelled"],
  ["done", "landing"],
  ["done", "cancelled"],
  ["done", "abandoned"],
  ["landing", "landed"],
  ["landing", "done"],
  ["landing", "failed"],
  ["failed", "queued"],
  ["failed", "abandoned"],
  ["cancelled", "queued"],
  ["cancelled", "abandoned"],
];

const legalKey = new Set(LEGAL.map(([a, b]) => `${a}>${b}`));
const ALL_PAIRS = TASK_STATES.flatMap((a) => TASK_STATES.map((b) => [a, b] as const));
const ILLEGAL = ALL_PAIRS.filter(([a, b]) => !legalKey.has(`${a}>${b}`));

describe("transition table", () => {
  it("lists exactly the expected legal transitions", () => {
    const actual = TASK_STATES.flatMap((from) => nextStates(from).map((to) => `${from}>${to}`));
    expect(actual.sort()).toEqual([...legalKey].sort());
  });

  it.each(LEGAL)("allows %s -> %s with full context", (from, to) => {
    expect(transition(from, to, FULL)).toBe(to);
  });

  it.each(ILLEGAL)("rejects %s -> %s even with full context", (from, to) => {
    expect(() => transition(from, to, FULL)).toThrow(IllegalTransitionError);
    expect(canTransition(from, to, FULL)).toBe(false);
  });

  it("covers every pair of states", () => {
    expect(LEGAL.length + ILLEGAL.length).toBe(TASK_STATES.length ** 2);
  });

  it("treats landed and abandoned as the only terminal states", () => {
    expect(TASK_STATES.filter(isTerminal).sort()).toEqual(["abandoned", "landed"]);
  });

  it("names allowed targets in the error", () => {
    expect(() => transition("queued", "done")).toThrow(
      /allowed from queued: provisioning, cancelled/,
    );
    expect(() => transition("landed", "queued")).toThrow(/terminal/);
  });
});

describe("guards", () => {
  it("requires a provisioned worktree to run", () => {
    expect(() => transition("provisioning", "running", {})).toThrow(/provision/);
  });

  it("requires approval to land", () => {
    expect(() => transition("done", "landing", {})).toThrow(/approval/);
    expect(transition("done", "landing", { approved: true })).toBe("landing");
  });

  it.each([
    ["running", "failed"],
    ["queued", "cancelled"],
    ["done", "cancelled"],
    ["landing", "failed"],
  ] as const)("requires a reason for %s -> %s", (from, to) => {
    expect(() => transition(from, to, { approved: true })).toThrow(/reason/);
    expect(() => transition(from, to, { reason: "  " })).toThrow(/reason/);
  });

  it("requires approval and a reason to abandon", () => {
    expect(() => transition("failed", "abandoned", { reason: "x" })).toThrow(/approval/);
    expect(() => transition("failed", "abandoned", { approved: true })).toThrow(/reason/);
    expect(transition("failed", "abandoned", { approved: true, reason: "x" })).toBe("abandoned");
  });

  it("guards are reachable only through legal edges", () => {
    for (const from of TASK_STATES) {
      for (const rule of TRANSITIONS[from]) expect(TASK_STATES).toContain(rule.to);
    }
  });
});

describe("worktree removal", () => {
  it.each(TASK_STATES)("%s", (state) => {
    expect(permitsWorktreeRemoval(state)).toBe(state === "landed" || state === "abandoned");
  });
});

describe("reported vocabulary", () => {
  it("maps working, blocked, needs-decision and done onto states", () => {
    expect(REPORTED_STATUS_TO_STATE).toEqual({
      working: "running",
      blocked: "blocked",
      "needs-decision": "needs-decision",
      done: "done",
    });
  });
});

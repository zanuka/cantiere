import { existsSync } from "node:fs";
import { z } from "zod";
import { EVENT_TYPES } from "./events.js";
import { runGit, runGitRaw } from "./git.js";
import type { CantiereStore } from "./store.js";
import { TaskIdSchema } from "./task.js";

/**
 * Event recorded in the task's event log when work lands in the base branch. The land flow (not
 * this module) writes it; these predicates only read it. A squash merge leaves no ancestry link
 * between the branch and the base, so this record is how it is recognised.
 */
export const LAND_EVENT = "task.landed";

export const LandEventDataSchema = z.looseObject({
  method: z.enum(["merge", "squash", "rebase"]),
  /** The branch tip that was landed. */
  branchTip: z.string().min(7),
  /** The commit on the base branch that contains the work (the squash or merge commit). */
  mergeCommit: z.string().min(7),
});
export type LandEventData = z.infer<typeof LandEventDataSchema>;

/** What the predicates need to know about a task's git state. */
export interface GitTarget {
  /** The primary checkout (or any worktree of the repo). */
  repoRoot: string;
  /** The task's worktree; may be absent when only the branch is left. */
  worktreePath?: string;
  branch: string;
  /** The branch work lands on, for example `main`. */
  baseRef: string;
}

async function revParse(cwd: string, rev: string): Promise<string | undefined> {
  const result = await runGitRaw(cwd, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

/** The commit the task branch points at, or undefined if the branch was deleted. */
export function branchTip(target: GitTarget): Promise<string | undefined> {
  return revParse(target.repoRoot, `refs/heads/${target.branch}`);
}

/** Where the worktree's HEAD is, and whether it is detached from any branch. */
export async function worktreeHead(
  worktreePath: string,
): Promise<{ sha: string; detached: boolean }> {
  const sha = (await runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
  const symbolic = await runGitRaw(worktreePath, ["symbolic-ref", "--quiet", "HEAD"]);
  return { sha, detached: symbolic.code !== 0 };
}

/**
 * Commits that exist only on a detached HEAD matter as much as branch commits: an agent that
 * checks out a commit and keeps working has work no branch references.
 */
async function detachedHead(target: GitTarget): Promise<string | undefined> {
  if (!target.worktreePath || !existsSync(target.worktreePath)) return undefined;
  const head = await worktreeHead(target.worktreePath);
  return head.detached ? head.sha : undefined;
}

/**
 * True when the worktree has uncommitted work: modified or staged tracked files, or untracked
 * files (ignored files do not count). A missing worktree is an error, not "clean": it must not be
 * read as permission to delete anything.
 */
export async function isDirty(worktreePath: string): Promise<boolean> {
  if (!existsSync(worktreePath)) {
    throw new Error(
      `Worktree ${worktreePath} does not exist, so its state is unknown. ` +
        "Run `git worktree list` in the repository to find it, or recreate it before cleanup.",
    );
  }
  const status = await runGit(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]);
  return status.stdout.trim() !== "";
}

/**
 * True when the branch (or a detached HEAD in its worktree) has commits that the base does not
 * contain. A deleted branch with no detached HEAD has none to find, so this is false; use
 * {@link isLanded} (which treats a missing branch as unproven) for safety decisions.
 */
export async function hasCommitsNotInBase(target: GitTarget): Promise<boolean> {
  const base = await revParse(target.repoRoot, target.baseRef);
  if (!base) throw new Error(`baseRef "${target.baseRef}" does not resolve in ${target.repoRoot}.`);
  const tips = [await branchTip(target), await detachedHead(target)].filter(
    (tip): tip is string => tip !== undefined,
  );
  if (tips.length === 0) return false;
  const count = await runGit(target.repoRoot, ["rev-list", "--count", `^${base}`, ...tips]);
  return Number(count.stdout.trim()) > 0;
}

export type LandedVia = "ancestor" | "equivalent-patches" | "land-event";

export type LandedVerdict =
  | { landed: true; via: LandedVia }
  | { landed: false; reason: "branch-missing" | "not-merged" | "detached-head-not-merged" };

async function readLandEvents(store: CantiereStore, taskId: string): Promise<LandEventData[]> {
  const { events } = await store.readEvents(taskId);
  const out: LandEventData[] = [];
  for (const event of events) {
    if (event.type !== LAND_EVENT) continue;
    const parsed = LandEventDataSchema.safeParse(event.data);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await runGitRaw(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
  return result.code === 0;
}

/** Every commit of `tip` not in base has an equivalent patch in base (rebase-style merge). */
async function patchesInBase(cwd: string, base: string, tip: string): Promise<boolean> {
  const cherry = await runGit(cwd, ["cherry", base, tip]);
  return cherry.stdout.split("\n").every((line) => line === "" || line.startsWith("-"));
}

export interface IsLandedOptions {
  store: CantiereStore;
  taskId: string;
  target: GitTarget;
}

/**
 * Has this task's work landed in the base? Conservative by design: only positive proof says yes.
 *
 * - the tip is reachable from the base (merge or fast-forward, including after a rebase),
 * - every commit has a patch-equivalent commit in the base (rebase merge with new SHAs),
 * - or a recorded land event names this exact tip and its merge commit is in the base (squash).
 *
 * A deleted branch counts only through the land event; a detached HEAD must be landed too.
 */
export async function isLanded(options: IsLandedOptions): Promise<LandedVerdict> {
  const { store, taskId, target } = options;
  TaskIdSchema.parse(taskId);
  const base = await revParse(target.repoRoot, target.baseRef);
  if (!base) throw new Error(`baseRef "${target.baseRef}" does not resolve in ${target.repoRoot}.`);
  const landEvents = await readLandEvents(store, taskId);

  const landedTip = async (tip: string): Promise<LandedVia | undefined> => {
    if (await isAncestor(target.repoRoot, tip, base)) return "ancestor";
    const recorded = landEvents.find(
      (event) => event.branchTip === tip || tip.startsWith(event.branchTip),
    );
    if (recorded) {
      const merge = await revParse(target.repoRoot, recorded.mergeCommit);
      if (merge && (await isAncestor(target.repoRoot, merge, base))) return "land-event";
    }
    if (
      (await revParse(target.repoRoot, tip)) &&
      (await patchesInBase(target.repoRoot, base, tip))
    ) {
      return "equivalent-patches";
    }
    return undefined;
  };

  const tip = await branchTip(target);
  // A deleted branch is proven only by the latest land event, which still names the landed tip.
  const subject = tip ?? [...landEvents].reverse()[0]?.branchTip;
  if (!subject) return { landed: false, reason: "branch-missing" };
  const via = await landedTip(subject);
  if (!via) return { landed: false, reason: tip ? "not-merged" : "branch-missing" };

  const detached = await detachedHead(target);
  if (detached && !(await landedTip(detached))) {
    return { landed: false, reason: "detached-head-not-merged" };
  }
  return { landed: true, via };
}

export type AbandonedVerdict = { abandoned: true; reason: string } | { abandoned: false };

/**
 * Is the task abandoned with a recorded reason? Reads the event log, the source of truth: the
 * latest transition must be to `abandoned` and carry a non-empty reason. (The state machine
 * already refuses an abandonment without approval and a reason; this re-checks the record.)
 */
export async function isAbandonedWithReason(
  store: CantiereStore,
  taskId: string,
): Promise<AbandonedVerdict> {
  const { events } = await store.readEvents(taskId);
  const transitions = events.filter((event) => event.type === EVENT_TYPES.taskTransitioned);
  const last = transitions.at(-1);
  if (!last) return { abandoned: false };
  if (last.data.to !== "abandoned") return { abandoned: false };
  const reason = typeof last.data.reason === "string" ? last.data.reason.trim() : "";
  return reason === "" ? { abandoned: false } : { abandoned: true, reason };
}

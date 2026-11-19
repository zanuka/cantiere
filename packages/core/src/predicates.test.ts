import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commitFile,
  git,
  isolateGitEnv,
  makeSandbox,
  makeTask,
  type Sandbox,
} from "./git.fixture.js";
import {
  type CreatedWorktree,
  createWorktree,
  type GitTarget,
  hasCommitsNotInBase,
  isAbandonedWithReason,
  isDirty,
  isLanded,
  LAND_EVENT,
  type Task,
} from "./index.js";

vi.setConfig({ testTimeout: 30_000 });

let sb: Sandbox;
beforeEach(async () => {
  isolateGitEnv();
  sb = await makeSandbox();
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(sb.base, { recursive: true, force: true });
});

interface Fixture {
  task: Task;
  wt: CreatedWorktree;
  target: GitTarget;
}

async function start(): Promise<Fixture> {
  const task = makeTask();
  await sb.store.createTask(task);
  const wt = await createWorktree({
    store: sb.store,
    task,
    repoRoot: sb.repo,
    config: { worktreeRoot: sb.worktrees },
  });
  return {
    task,
    wt,
    target: {
      repoRoot: sb.repo,
      worktreePath: wt.worktreePath,
      branch: wt.branch,
      baseRef: "main",
    },
  };
}

async function recordLand(f: Fixture, method: "merge" | "squash" | "rebase", mergeCommit: string) {
  await sb.store.append(f.task.id, {
    type: LAND_EVENT,
    actor: "cantiere",
    data: { method, branchTip: await git(sb.repo, "rev-parse", f.wt.branch), mergeCommit },
  });
}

const landed = (f: Fixture) => isLanded({ store: sb.store, taskId: f.task.id, target: f.target });

describe("predicates", () => {
  it("fresh worktree: clean, nothing to land, trivially landed", async () => {
    const f = await start();
    expect(await isDirty(f.wt.worktreePath)).toBe(false);
    expect(await hasCommitsNotInBase(f.target)).toBe(false);
    expect(await landed(f)).toEqual({ landed: true, via: "ancestor" });
  });

  it("clean and merged", async () => {
    const f = await start();
    await commitFile(f.wt.worktreePath, "a.txt", "a");
    await git(sb.repo, "merge", "--quiet", "--no-ff", "-m", "merge", f.wt.branch);
    expect(await isDirty(f.wt.worktreePath)).toBe(false);
    expect(await hasCommitsNotInBase(f.target)).toBe(false);
    expect(await landed(f)).toEqual({ landed: true, via: "ancestor" });
  });

  it("dirty: modified tracked, staged and untracked files all count; ignored do not", async () => {
    const f = await start();
    const wt = f.wt.worktreePath;
    expect(await isDirty(wt)).toBe(false);
    writeFileSync(path.join(wt, "untracked.txt"), "u");
    expect(await isDirty(wt)).toBe(true);
    rmSync(path.join(wt, "untracked.txt"));
    writeFileSync(path.join(wt, "README.md"), "changed\n");
    expect(await isDirty(wt)).toBe(true);
    await git(wt, "add", "README.md");
    expect(await isDirty(wt)).toBe(true);
    await git(wt, "commit", "--quiet", "-m", "commit it");
    expect(await isDirty(wt)).toBe(false);
    await commitFile(wt, ".gitignore", "ignored.txt\n");
    writeFileSync(path.join(wt, "ignored.txt"), "i");
    expect(await isDirty(wt)).toBe(false);
  });

  it("a missing worktree is an error, never 'clean'", async () => {
    const f = await start();
    await git(sb.repo, "worktree", "remove", "--force", f.wt.worktreePath);
    await expect(isDirty(f.wt.worktreePath)).rejects.toThrow(/does not exist/);
  });

  it("committed but not merged", async () => {
    const f = await start();
    await commitFile(f.wt.worktreePath, "a.txt", "a");
    expect(await isDirty(f.wt.worktreePath)).toBe(false);
    expect(await hasCommitsNotInBase(f.target)).toBe(true);
    expect(await landed(f)).toEqual({ landed: false, reason: "not-merged" });
  });

  it("squash-merged: recognised only through the recorded land event", async () => {
    const f = await start();
    await commitFile(f.wt.worktreePath, "a.txt", "a", "one");
    await commitFile(f.wt.worktreePath, "b.txt", "b", "two");
    await git(sb.repo, "merge", "--squash", f.wt.branch);
    await git(sb.repo, "commit", "--quiet", "-m", "squash");
    // Git sees no ancestry, so without the record the work is not proven landed.
    expect(await hasCommitsNotInBase(f.target)).toBe(true);
    expect(await landed(f)).toEqual({ landed: false, reason: "not-merged" });

    await recordLand(f, "squash", await git(sb.repo, "rev-parse", "main"));
    expect(await landed(f)).toEqual({ landed: true, via: "land-event" });
  });

  it("a land event does not vouch for commits added after it, or for a merge not in the base", async () => {
    const f = await start();
    await commitFile(f.wt.worktreePath, "a.txt", "a");
    await git(sb.repo, "merge", "--squash", f.wt.branch);
    await git(sb.repo, "commit", "--quiet", "-m", "squash");
    await recordLand(f, "squash", await git(sb.repo, "rev-parse", "main"));
    await commitFile(f.wt.worktreePath, "later.txt", "later");
    expect(await landed(f)).toEqual({ landed: false, reason: "not-merged" });

    // A recorded merge commit that never reached the base proves nothing.
    const g = await start();
    await commitFile(g.wt.worktreePath, "g.txt", "g");
    await git(sb.repo, "checkout", "--quiet", "-b", "elsewhere");
    await git(sb.repo, "merge", "--squash", g.wt.branch);
    await git(sb.repo, "commit", "--quiet", "-m", "squash elsewhere");
    const stray = await git(sb.repo, "rev-parse", "HEAD");
    await git(sb.repo, "checkout", "--quiet", "main");
    await recordLand(g, "squash", stray);
    expect(await landed(g)).toEqual({ landed: false, reason: "not-merged" });
  });

  it("land events must name full SHAs exactly, and any matching event proves the land", async () => {
    const f = await start();
    await commitFile(f.wt.worktreePath, "a.txt", "a");
    await git(sb.repo, "merge", "--squash", f.wt.branch);
    await git(sb.repo, "commit", "--quiet", "-m", "squash");
    const tip = await git(sb.repo, "rev-parse", f.wt.branch);
    const mergeCommit = await git(sb.repo, "rev-parse", "main");
    const append = (data: Record<string, string>) =>
      sb.store.append(f.task.id, {
        type: LAND_EVENT,
        actor: "cantiere",
        data: { method: "squash", ...data },
      });

    await append({ branchTip: tip.slice(0, 12), mergeCommit });
    await append({ branchTip: tip, mergeCommit: mergeCommit.slice(0, 12) });
    expect(await landed(f)).toEqual({ landed: false, reason: "not-merged" });

    await append({ branchTip: tip, mergeCommit: "0".repeat(40) });
    expect(await landed(f)).toEqual({ landed: false, reason: "not-merged" });
    await append({ branchTip: tip, mergeCommit });
    expect(await landed(f)).toEqual({ landed: true, via: "land-event" });
  });

  it("rebased onto the base then fast-forwarded: landed by ancestry", async () => {
    const f = await start();
    await commitFile(f.wt.worktreePath, "a.txt", "a");
    await commitFile(sb.repo, "main-only.txt", "m");
    await git(f.wt.worktreePath, "rebase", "--quiet", "main");
    await git(sb.repo, "merge", "--quiet", "--ff-only", f.wt.branch);
    expect(await hasCommitsNotInBase(f.target)).toBe(false);
    expect(await landed(f)).toEqual({ landed: true, via: "ancestor" });
  });

  it("rebased but not yet merged is not landed", async () => {
    const f = await start();
    await commitFile(f.wt.worktreePath, "a.txt", "a");
    await commitFile(sb.repo, "main-only.txt", "m");
    await git(f.wt.worktreePath, "rebase", "--quiet", "main");
    expect(await hasCommitsNotInBase(f.target)).toBe(true);
    expect(await landed(f)).toEqual({ landed: false, reason: "not-merged" });
  });

  it("detached HEAD: commits on it count as unmerged work", async () => {
    const f = await start();
    const wt = f.wt.worktreePath;
    await git(wt, "checkout", "--quiet", "--detach");
    expect(await hasCommitsNotInBase(f.target)).toBe(false);
    expect(await landed(f)).toEqual({ landed: true, via: "ancestor" });
    await commitFile(wt, "orphan.txt", "no branch has this");
    expect(await hasCommitsNotInBase(f.target)).toBe(true);
    expect(await landed(f)).toEqual({ landed: false, reason: "detached-head-not-merged" });
    expect(await isDirty(wt)).toBe(false);
  });

  it("deleted branch: unproven without a land event, landed with one", async () => {
    const f = await start();
    await commitFile(f.wt.worktreePath, "a.txt", "a");
    await git(sb.repo, "merge", "--squash", f.wt.branch);
    await git(sb.repo, "commit", "--quiet", "-m", "squash");
    const mergeCommit = await git(sb.repo, "rev-parse", "main");
    await recordLand(f, "squash", mergeCommit);
    await git(sb.repo, "worktree", "remove", "--force", f.wt.worktreePath);
    await git(sb.repo, "branch", "-D", f.wt.branch);
    const gone = { ...f.target };
    delete gone.worktreePath;
    expect(await hasCommitsNotInBase(gone)).toBe(false);
    expect(await isLanded({ store: sb.store, taskId: f.task.id, target: gone })).toEqual({
      landed: true,
      via: "land-event",
    });

    // No record: a missing branch is never assumed landed, even if it was merged.
    const g = await start();
    await commitFile(g.wt.worktreePath, "g.txt", "g");
    await git(sb.repo, "merge", "--quiet", "--no-ff", "-m", "merge", g.wt.branch);
    await git(sb.repo, "worktree", "remove", "--force", g.wt.worktreePath);
    await git(sb.repo, "branch", "-d", g.wt.branch);
    const verdict = await isLanded({
      store: sb.store,
      taskId: g.task.id,
      target: { repoRoot: sb.repo, branch: g.wt.branch, baseRef: "main" },
    });
    expect(verdict).toEqual({ landed: false, reason: "branch-missing" });
  });

  it("abandoned requires a recorded reason", async () => {
    const f = await start();
    expect(await isAbandonedWithReason(sb.store, f.task.id)).toEqual({ abandoned: false });
    const id = f.task.id;
    await sb.store.transition(id, "provisioning", { actor: "cantiere" });
    await sb.store.append(id, {
      type: "task.provisioned",
      actor: "cantiere",
      data: { branch: f.wt.branch, worktreePath: f.wt.worktreePath },
    });
    await sb.store.transition(id, "running", { actor: "cantiere" });
    await sb.store.transition(id, "done", { actor: "agent" });
    expect(await isAbandonedWithReason(sb.store, id)).toEqual({ abandoned: false });
    await sb.store.transition(id, "abandoned", {
      actor: "human",
      approved: true,
      reason: "superseded by another approach",
    });
    expect(await isAbandonedWithReason(sb.store, id)).toEqual({
      abandoned: true,
      reason: "superseded by another approach",
    });
  });
});

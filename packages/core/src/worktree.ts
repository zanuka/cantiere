import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { type RetryOptions, runGit, runGitRaw, runGitRetrying } from "./git.js";
import { branchName } from "./id.js";
import type { CantiereStore } from "./store.js";
import type { Task } from "./task.js";

/** Event recorded (via the store's event log) when a task's worktree is created. */
export const WORKTREE_CREATED_EVENT = "worktree.created";

export interface GitIdentity {
  name: string;
  email: string;
}

export interface WorktreeConfig {
  /**
   * Directory holding task worktrees as `<repo>-<id>`. Defaults to `<repo>.worktrees` beside the
   * primary checkout, so worktrees are never inside it.
   */
  worktreeRoot?: string;
  /** Set as `core.hooksPath` in the worktree (for example to disable or replace repo hooks). */
  hooksPath?: string;
  /** Set as `user.name` / `user.email` in the worktree only. */
  identity?: GitIdentity;
  /** Backoff for git lock contention. */
  retry?: RetryOptions;
}

export interface CreateWorktreeOptions {
  store: CantiereStore;
  task: Task;
  /** The primary checkout, or any worktree of it. */
  repoRoot: string;
  config?: WorktreeConfig;
}

export interface CreatedWorktree {
  branch: string;
  worktreePath: string;
  /** The commit `baseRef` pointed at when the branch was cut. */
  baseSha: string;
}

export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeError";
  }
}

/** The primary checkout's top-level directory, resolved through symlinks, for any path in the repo. */
export async function primaryCheckoutOf(repoRoot: string): Promise<string> {
  const common = await runGit(repoRoot, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const gitDir = await realpath(common.stdout.trim());
  const bare = (await runGit(repoRoot, ["rev-parse", "--is-bare-repository"])).stdout.trim();
  if (bare === "true" || path.basename(gitDir) !== ".git") {
    throw new WorktreeError(
      `${repoRoot} is not a normal (non-bare) git checkout; Cantiere creates task worktrees from a primary checkout.`,
    );
  }
  return path.dirname(gitDir);
}

/** `realpath` for a path that may not exist yet: resolve the nearest existing ancestor. */
async function realpathOfNearest(target: string): Promise<string> {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try {
      return path.join(await realpath(current), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) return target;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Creates the task's isolated worktree and branch and records the base SHA.
 *
 * Serialized behind the store's repo lock (so many tasks starting at once do not fight over
 * `.git`), with retry when git itself reports a lock error. The primary checkout's working tree
 * is never written: git only adds metadata under `.git/worktrees/` and the new directory.
 */
export async function createWorktree(options: CreateWorktreeOptions): Promise<CreatedWorktree> {
  const { store, task, config = {} } = options;
  const primary = await primaryCheckoutOf(options.repoRoot);
  const repoName = path.basename(primary);
  const root = path.resolve(
    config.worktreeRoot ?? path.join(path.dirname(primary), `${repoName}.worktrees`),
  );
  const worktreePath = path.join(await realpathOfNearest(root), `${repoName}-${task.id}`);
  const branch = branchName(task.id, task.title);

  // Checked before anything is created, so a bad root never writes into the primary checkout.
  if (isInside(primary, worktreePath)) {
    throw new WorktreeError(
      `Refusing to create a worktree at ${worktreePath}: it is the primary checkout or inside it. ` +
        "Set worktreeRoot to a directory outside the repository.",
    );
  }
  await store.getTask(task.id);
  await mkdir(root, { recursive: true });

  return store.withRepoLock(async () => {
    const retry = config.retry;
    const resolved = await runGitRaw(primary, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${task.baseRef}^{commit}`,
    ]);
    if (resolved.code !== 0) {
      throw new WorktreeError(
        `baseRef "${task.baseRef}" does not resolve to a commit in ${primary}. ` +
          "Check the ref name, or fetch it first.",
      );
    }
    const baseSha = resolved.stdout.trim();

    const exists = await runGitRaw(primary, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);
    if (exists.code === 0) {
      throw new WorktreeError(
        `Branch ${branch} already exists. Task ids are unique, so this task may already have a worktree; ` +
          "inspect it before retrying.",
      );
    }

    await runGitRetrying(
      primary,
      ["worktree", "add", "--quiet", "-b", branch, worktreePath, baseSha],
      retry,
    );

    try {
      if (config.hooksPath !== undefined || config.identity) {
        // Per-worktree config keeps hooks and identity off the shared repo config.
        await runGitRetrying(primary, ["config", "extensions.worktreeConfig", "true"], retry);
        const set = (key: string, value: string) =>
          runGitRetrying(worktreePath, ["config", "--worktree", key, value], retry);
        if (config.hooksPath !== undefined) await set("core.hooksPath", config.hooksPath);
        if (config.identity) {
          await set("user.name", config.identity.name);
          await set("user.email", config.identity.email);
        }
      }

      await store.append(task.id, {
        type: WORKTREE_CREATED_EVENT,
        actor: "cantiere",
        data: { branch, worktreePath, baseRef: task.baseRef, baseSha },
      });
    } catch (error) {
      await runGitRaw(primary, ["worktree", "remove", "--force", worktreePath]);
      await runGitRaw(primary, ["update-ref", "-d", `refs/heads/${branch}`, baseSha]);
      throw error;
    }
    return { branch, worktreePath, baseSha };
  });
}

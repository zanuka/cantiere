import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  createWorktree,
  hasCommitsNotInBase,
  isDirty,
  runGit,
  WORKTREE_CREATED_EVENT,
  WorktreeError,
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

function lockFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".lock") || entry.name.endsWith(".tmp")) found.push(full);
    }
  };
  walk(dir);
  return found;
}

/** Every file in the primary checkout's working tree (not `.git`) with a content hash and mtime. */
function snapshotWorkingTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        out[`${path.relative(root, full)}/`] = String(statSync(full).mtimeMs);
        walk(full);
      } else {
        out[path.relative(root, full)] =
          `${createHash("sha256").update(readFileSync(full)).digest("hex")}@${statSync(full).mtimeMs}`;
      }
    }
  };
  walk(root);
  return out;
}

describe("createWorktree", () => {
  it("creates a branch and a worktree outside the primary checkout, recording the base SHA", async () => {
    const task = makeTask();
    await sb.store.createTask(task);
    const baseSha = await git(sb.repo, "rev-parse", "main");
    const result = await createWorktree({
      store: sb.store,
      task,
      repoRoot: sb.repo,
      config: { worktreeRoot: sb.worktrees },
    });
    expect(result.worktreePath).toBe(path.join(sb.worktrees, `repo-${task.id}`));
    expect(result.branch).toBe(`cantiere/${task.id}-add-widget`);
    expect(result.baseSha).toBe(baseSha);
    expect(await git(result.worktreePath, "rev-parse", "--abbrev-ref", "HEAD")).toBe(result.branch);
    expect(await git(result.worktreePath, "rev-parse", "HEAD")).toBe(baseSha);

    const { events } = await sb.store.readEvents(task.id);
    const recorded = events.find((e) => e.type === WORKTREE_CREATED_EVENT);
    expect(recorded?.data).toMatchObject({ baseSha, branch: result.branch });
  });

  it("defaults the worktree root to a sibling of the primary checkout", async () => {
    const task = makeTask();
    await sb.store.createTask(task);
    const { worktreePath } = await createWorktree({ store: sb.store, task, repoRoot: sb.repo });
    expect(worktreePath).toBe(path.join(sb.base, "repo.worktrees", `repo-${task.id}`));
  });

  it("works when called with a path inside a linked worktree", async () => {
    const first = makeTask("first");
    const second = makeTask("second");
    await sb.store.createTask(first);
    await sb.store.createTask(second);
    const config = { worktreeRoot: sb.worktrees };
    const a = await createWorktree({ store: sb.store, task: first, repoRoot: sb.repo, config });
    const b = await createWorktree({
      store: sb.store,
      task: second,
      repoRoot: a.worktreePath,
      config,
    });
    expect(b.worktreePath).toBe(path.join(sb.worktrees, `repo-${second.id}`));
  });

  it("refuses a worktree root that is, or is inside, the primary checkout", async () => {
    const task = makeTask();
    await sb.store.createTask(task);
    for (const worktreeRoot of [sb.repo, path.join(sb.repo, "nested")]) {
      await expect(
        createWorktree({ store: sb.store, task, repoRoot: sb.repo, config: { worktreeRoot } }),
      ).rejects.toThrow(/primary checkout/);
    }
    expect(await git(sb.repo, "worktree", "list", "--porcelain")).not.toContain(task.id);
    expect(existsSync(path.join(sb.repo, "nested"))).toBe(false);
  });

  it("refuses an unknown baseRef and an existing branch with actionable errors", async () => {
    const task = makeTask("x", { baseRef: "nope" });
    await sb.store.createTask(task);
    const config = { worktreeRoot: sb.worktrees };
    await expect(
      createWorktree({ store: sb.store, task, repoRoot: sb.repo, config }),
    ).rejects.toThrow(/baseRef "nope"/);

    const ok = makeTask("y");
    await sb.store.createTask(ok);
    await createWorktree({ store: sb.store, task: ok, repoRoot: sb.repo, config });
    await expect(
      createWorktree({ store: sb.store, task: ok, repoRoot: sb.repo, config }),
    ).rejects.toBeInstanceOf(WorktreeError);
  });

  it("sets hooksPath and identity in the worktree only", async () => {
    const task = makeTask();
    await sb.store.createTask(task);
    const { worktreePath } = await createWorktree({
      store: sb.store,
      task,
      repoRoot: sb.repo,
      config: {
        worktreeRoot: sb.worktrees,
        hooksPath: "/dev/null",
        identity: { name: "Cantiere Agent", email: "agent@cantiere.invalid" },
      },
    });
    const config = async (cwd: string, key: string) =>
      (await runGit(cwd, ["config", "--get", key]).catch(() => ({ stdout: "" }))).stdout.trim();
    expect(await config(worktreePath, "core.hooksPath")).toBe("/dev/null");
    expect(await config(worktreePath, "user.name")).toBe("Cantiere Agent");
    expect(await config(worktreePath, "user.email")).toBe("agent@cantiere.invalid");
    // The primary checkout keeps its own settings.
    expect(await config(sb.repo, "core.hooksPath")).toBe("");
    expect(await config(sb.repo, "user.name")).toBe("");
  });

  it("creates 10 concurrent worktrees with distinct branches and leaves no lock files", async () => {
    const tasks = Array.from({ length: 10 }, (_, i) => makeTask(`Task number ${i}`));
    for (const task of tasks) await sb.store.createTask(task);
    const config = {
      worktreeRoot: sb.worktrees,
      identity: { name: "Agent", email: "agent@example.com" },
    };
    const results = await Promise.all(
      tasks.map((task) => createWorktree({ store: sb.store, task, repoRoot: sb.repo, config })),
    );
    expect(new Set(results.map((r) => r.branch)).size).toBe(10);
    expect(new Set(results.map((r) => r.worktreePath)).size).toBe(10);
    for (const r of results) expect(existsSync(path.join(r.worktreePath, "README.md"))).toBe(true);
    const branches = (await git(sb.repo, "branch", "--format=%(refname:short)")).split("\n");
    for (const r of results) expect(branches).toContain(r.branch);
    expect(lockFiles(path.join(sb.repo, ".git"))).toEqual([]);
    expect(lockFiles(path.join(sb.base, "state"))).toEqual([]);
  });

  it("retries while another git process holds a lock, then succeeds", async () => {
    const task = makeTask();
    await sb.store.createTask(task);
    const lock = path.join(sb.repo, ".git", "config.lock");
    writeFileSync(lock, "");
    const release = setTimeout(() => rmSync(lock, { force: true }), 200);
    try {
      const result = await createWorktree({
        store: sb.store,
        task,
        repoRoot: sb.repo,
        config: {
          worktreeRoot: sb.worktrees,
          identity: { name: "Agent", email: "agent@example.com" },
          retry: { attempts: 20, baseDelayMs: 20, maxDelayMs: 100 },
        },
      });
      expect(existsSync(result.worktreePath)).toBe(true);
    } finally {
      clearTimeout(release);
    }
  });

  it("gives up with git's lock error once retries are exhausted", async () => {
    const task = makeTask();
    await sb.store.createTask(task);
    const lock = path.join(sb.repo, ".git", "config.lock");
    writeFileSync(lock, "");
    await expect(
      createWorktree({
        store: sb.store,
        task,
        repoRoot: sb.repo,
        config: {
          worktreeRoot: sb.worktrees,
          identity: { name: "Agent", email: "agent@example.com" },
          retry: { attempts: 2, baseDelayMs: 5 },
        },
      }),
    ).rejects.toThrow(/could not lock config file/);
  });

  it("never writes to the primary checkout's working tree", async () => {
    // Give the primary tree some shape, including an untracked and an ignored file.
    await commitFile(sb.repo, ".gitignore", "ignored.txt\n");
    await commitFile(sb.repo, "src/app.ts", "export {};\n");
    writeFileSync(path.join(sb.repo, "ignored.txt"), "x");
    writeFileSync(path.join(sb.repo, "untracked.txt"), "y");
    const before = snapshotWorkingTree(sb.repo);
    const status = await git(sb.repo, "status", "--porcelain", "--ignored");

    const tasks = [makeTask("one"), makeTask("two")];
    for (const task of tasks) await sb.store.createTask(task);
    const created = [];
    for (const task of tasks) {
      created.push(
        await createWorktree({
          store: sb.store,
          task,
          repoRoot: sb.repo,
          config: { worktreeRoot: sb.worktrees, hooksPath: "/dev/null" },
        }),
      );
    }
    // Work in a worktree and inspect it with every predicate, as an agent and cleanup would.
    const [first] = created;
    if (!first) throw new Error("no worktree");
    await commitFile(first.worktreePath, "feature.txt", "feature\n");
    writeFileSync(path.join(first.worktreePath, "scratch.txt"), "wip");
    expect(await isDirty(first.worktreePath)).toBe(true);
    await hasCommitsNotInBase({
      repoRoot: sb.repo,
      worktreePath: first.worktreePath,
      branch: first.branch,
      baseRef: "main",
    });

    expect(snapshotWorkingTree(sb.repo)).toEqual(before);
    expect(await git(sb.repo, "status", "--porcelain", "--ignored")).toBe(status);
    expect(await git(sb.repo, "rev-parse", "HEAD")).toBe(await git(sb.repo, "rev-parse", "main"));
    expect(existsSync(path.join(sb.repo, "feature.txt"))).toBe(false);
  });
});

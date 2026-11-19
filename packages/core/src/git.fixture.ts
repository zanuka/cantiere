import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { CantiereStore, generateTaskId, runGit, SCHEMA_VERSION, type Task } from "./index.js";

/** A scratch area with a real git repo (`repo/`), a store outside it, and room for worktrees. */
export interface Sandbox {
  base: string;
  repo: string;
  worktrees: string;
  store: CantiereStore;
}

const IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

export async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await runGit(cwd, [...IDENTITY, ...args])).stdout.trim();
}

export function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

export async function commitFile(cwd: string, name: string, content: string, message = name) {
  write(path.join(cwd, name), content);
  await git(cwd, "add", "--", name);
  await git(cwd, "commit", "--quiet", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

/**
 * Keeps tests independent of the machine running them: no inherited `GIT_CONFIG_*` overrides
 * (which beat repo config), no global or system config, hence no user hooks.
 */
export function isolateGitEnv(): void {
  for (const name of ["GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_DIR", "GIT_WORK_TREE"]) {
    vi.stubEnv(name, undefined);
  }
  for (let i = 0; i < 8; i++) {
    vi.stubEnv(`GIT_CONFIG_KEY_${i}`, undefined);
    vi.stubEnv(`GIT_CONFIG_VALUE_${i}`, undefined);
  }
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
}

export async function makeSandbox(): Promise<Sandbox> {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cantiere-git-")));
  const repo = path.join(base, "repo");
  mkdirSync(repo);
  await git(repo, "init", "--quiet", "-b", "main");
  await commitFile(repo, "README.md", "hello\n", "initial");
  const store = await CantiereStore.open(path.join(base, "state"), { fsync: false });
  return { base, repo, worktrees: path.join(base, "worktrees"), store };
}

export function makeTask(title = "Add widget", overrides: Partial<Task> = {}): Task {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: generateTaskId(),
    title,
    prompt: "do it",
    kind: "agent",
    repo: "repo",
    baseRef: "main",
    harness: "fake",
    createdAt: new Date().toISOString(),
    labels: [],
    source: "manual",
    ...overrides,
  };
}

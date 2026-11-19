import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

export interface GitResult {
  stdout: string;
  stderr: string;
  /** Exit code; 128 and up usually mean git itself failed. */
  code: number;
}

/** A git command exited non-zero (or could not start). The message carries argv and stderr. */
export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly cwd: string,
    readonly result: GitResult,
  ) {
    super(
      `git ${args.join(" ")} failed in ${cwd} (exit ${result.code}): ` +
        `${result.stderr.trim() || result.stdout.trim() || "no output"}`,
    );
    this.name = "GitError";
  }
}

const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Runs git with an argv array (never a shell string, so no quoting or injection hazards) and
 * returns the result whatever the exit code. Locale is pinned so error text can be matched.
 */
export function runGitRaw(
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER,
        env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", ...env },
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ stdout, stderr, code: 0 });
        const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
        if (typeof code === "number") return resolve({ stdout, stderr, code });
        reject(
          new Error(
            `Could not run git (${(error as Error).message}). Is git installed and on PATH?`,
          ),
        );
      },
    );
  });
}

/** Runs git and throws {@link GitError} on a non-zero exit. */
export async function runGit(
  cwd: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<GitResult> {
  const result = await runGitRaw(cwd, args, env);
  if (result.code !== 0) throw new GitError(args, cwd, result);
  return result;
}

/** True when git failed because another git process holds a `.lock` file. */
export function isGitLockError(error: unknown): boolean {
  if (!(error instanceof GitError)) return false;
  const text = error.result.stderr;
  return (
    /Unable to create '[^']*\.lock': File exists/.test(text) ||
    /could not lock [^\n]*\.lock/i.test(text) ||
    /could not lock config file [^\n]*: File exists/.test(text) ||
    /cannot lock ref/i.test(text)
  );
}

export interface RetryOptions {
  /** Total attempts including the first. Default 8. */
  attempts?: number;
  /** First backoff; doubles each attempt with jitter. Default 50ms. */
  baseDelayMs?: number;
  /** Backoff ceiling. Default 1000ms. */
  maxDelayMs?: number;
}

/** Runs git, retrying with jittered backoff while it fails on a git lock file. */
export async function runGitRetrying(
  cwd: string,
  args: readonly string[],
  retry: RetryOptions = {},
  env?: NodeJS.ProcessEnv,
): Promise<GitResult> {
  const attempts = retry.attempts ?? 8;
  const base = retry.baseDelayMs ?? 50;
  const max = retry.maxDelayMs ?? 1000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await runGit(cwd, args, env);
    } catch (error) {
      if (attempt >= attempts || !isGitLockError(error)) throw error;
      const delay = Math.min(max, base * 2 ** (attempt - 1));
      await sleep(delay / 2 + (Math.random() * delay) / 2);
    }
  }
}

import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** Contents of a lock file: enough to tell who holds it and whether they are still alive. */
export interface LockOwner {
  pid: number;
  host: string;
  token: string;
  acquiredAt: string;
}

export interface LockOptions {
  /** Give up after this long and throw {@link LockTimeoutError}. Default 30s. */
  timeoutMs?: number;
  /** A lock older than this is stale even if its pid looks alive (pid reuse, stopped holder). Default 60s. */
  staleMs?: number;
}

export class LockTimeoutError extends Error {
  constructor(
    readonly lockPath: string,
    readonly owner: LockOwner | undefined,
    timeoutMs: number,
  ) {
    const holder = owner
      ? `held by pid ${owner.pid} on ${owner.host} since ${owner.acquiredAt}`
      : "holder unknown";
    super(
      `Timed out after ${timeoutMs}ms waiting for lock ${lockPath} (${holder}). ` +
        "If that process is gone, remove the lock file and retry.",
    );
    this.name = "LockTimeoutError";
  }
}

export interface LockHandle {
  readonly path: string;
  release(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STALE_MS = 60_000;
const STEAL_GUARD_STALE_MS = 5_000;
const STALE_CHECK_INTERVAL_MS = 25;
const MAX_BACKOFF_MS = 20;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readOwner(lockPath: string): Promise<LockOwner | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(lockPath, "utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      const owner = parsed as Partial<LockOwner>;
      if (
        typeof owner.pid === "number" &&
        typeof owner.host === "string" &&
        typeof owner.token === "string" &&
        typeof owner.acquiredAt === "string"
      ) {
        return owner as LockOwner;
      }
    }
  } catch {
    // Missing or unreadable: treated as "no readable owner".
  }
  return undefined;
}

function isStale(owner: LockOwner, staleMs: number): boolean {
  const age = Date.now() - Date.parse(owner.acquiredAt);
  if (Number.isFinite(age) && age > staleMs) return true;
  return owner.host === os.hostname() && !isProcessAlive(owner.pid);
}

/**
 * Creates `target` atomically *with* its contents (write a private temp file, then `link` it into
 * place), so a competing process never observes an empty lock file. Returns false when it exists.
 */
async function createExclusive(target: string, content: string): Promise<boolean> {
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, content, { flag: "wx" });
  try {
    await link(tmp, target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

/**
 * Removes a stale lock without two stealers racing each other into deleting a *live* lock: stealing
 * is itself serialized by a short-lived guard file, and staleness is re-checked inside the guard.
 */
async function stealIfStale(lockPath: string, staleMs: number): Promise<void> {
  const guard = `${lockPath}.steal`;
  const mine = JSON.stringify({
    pid: process.pid,
    host: os.hostname(),
    token: randomBytes(8).toString("hex"),
    acquiredAt: new Date().toISOString(),
  } satisfies LockOwner);
  if (!(await createExclusive(guard, mine))) {
    // Someone else is stealing. Clear the guard only if its holder died mid-steal.
    const guardOwner = await readOwner(guard);
    if (guardOwner && isStale(guardOwner, STEAL_GUARD_STALE_MS))
      await unlink(guard).catch(() => undefined);
    return;
  }
  try {
    const owner = await readOwner(lockPath);
    if (owner && isStale(owner, staleMs)) await unlink(lockPath).catch(() => undefined);
    else if (!owner) {
      // Unreadable lock file: only remove it once it is old enough that nobody is mid-write.
      const info = await stat(lockPath).catch(() => undefined);
      if (info && Date.now() - info.mtimeMs > staleMs)
        await unlink(lockPath).catch(() => undefined);
    }
  } finally {
    await unlink(guard).catch(() => undefined);
  }
}

/** Acquires an exclusive cross-process lock at `lockPath`, waiting (with jittered backoff) if held. */
export async function acquireLock(
  lockPath: string,
  options: LockOptions = {},
): Promise<LockHandle> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  await mkdir(path.dirname(lockPath), { recursive: true });
  const token = randomBytes(8).toString("hex");
  const content = JSON.stringify({
    pid: process.pid,
    host: os.hostname(),
    token,
    acquiredAt: new Date().toISOString(),
  } satisfies LockOwner);
  // The private file is written once; each attempt is then a single cheap `link` syscall.
  const tmp = `${lockPath}.${process.pid}.${token}.tmp`;
  await writeFile(tmp, content, { flag: "wx" });
  const deadline = Date.now() + timeoutMs;
  let lastStaleCheck = 0;
  let owner: LockOwner | undefined;
  try {
    for (;;) {
      try {
        await link(tmp, lockPath);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (Date.now() - lastStaleCheck >= STALE_CHECK_INTERVAL_MS) {
        lastStaleCheck = Date.now();
        owner = await readOwner(lockPath);
        if (!owner || isStale(owner, staleMs)) await stealIfStale(lockPath, staleMs);
      }
      if (Date.now() >= deadline) throw new LockTimeoutError(lockPath, owner, timeoutMs);
      await sleep(1 + Math.random() * MAX_BACKOFF_MS);
    }
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
  let released = false;
  return {
    path: lockPath,
    async release() {
      if (released) return;
      released = true;
      // Only remove the lock if it is still ours (it may have been stolen after a long pause).
      const owner = await readOwner(lockPath);
      if (owner?.token === token) await unlink(lockPath).catch(() => undefined);
    },
  };
}

/** Runs `fn` while holding the lock at `lockPath`. */
export async function withLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options?: LockOptions,
): Promise<T> {
  const handle = await acquireLock(lockPath, options);
  try {
    return await fn();
  } finally {
    await handle.release();
  }
}

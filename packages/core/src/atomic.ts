import { randomBytes } from "node:crypto";
import { type FileHandle, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

/**
 * Points inside {@link writeFileAtomic} where a crash can be injected. Used by the fault-injection
 * tests: a process that dies at any of these points must never leave a corrupt target.
 */
export type AtomicWritePhase =
  | "tmp-created"
  | "tmp-partial"
  | "tmp-written"
  | "tmp-synced"
  | "renamed";

export interface AtomicWriteOptions {
  /** fsync the temp file before the rename and the directory after it. Default true. */
  fsync?: boolean;
  /** Test seam: called synchronously at each phase; it may kill the process. */
  onPhase?: (phase: AtomicWritePhase) => void;
}

/** Temp files are named `.<base>.<pid>.<random>.tmp` so a sweeper can tell whose they are. */
export function tempFileName(base: string, pid = process.pid): string {
  return `.${base}.${pid}.${randomBytes(4).toString("hex")}.tmp`;
}

const TEMP_FILE_PATTERN = /^\..+\.(\d+)\.[0-9a-f]{8}\.tmp$/;

/** The pid embedded in a temp file name, or undefined when it is not one of ours. */
export function tempFileOwner(name: string): number | undefined {
  const match = TEMP_FILE_PATTERN.exec(name);
  return match?.[1] ? Number(match[1]) : undefined;
}

async function syncDirectory(dir: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(dir, "r");
    await handle.sync();
  } catch {
    // Directory fsync is not supported everywhere; the rename itself is still atomic.
  } finally {
    await handle?.close();
  }
}

/**
 * Writes `data` to `target` so a reader (or a crash) only ever sees the old file or the complete
 * new one: write a temp file in the same directory, fsync it, then rename over the target.
 */
export async function writeFileAtomic(
  target: string,
  data: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const { fsync = true, onPhase } = options;
  const dir = path.dirname(target);
  const tmp = path.join(dir, tempFileName(path.basename(target)));
  const handle = await open(tmp, "wx", 0o644);
  let renamed = false;
  try {
    onPhase?.("tmp-created");
    const bytes = Buffer.from(data, "utf8");
    if (onPhase) {
      // Split the write so a crash can land with the temp file half written.
      const half = Math.floor(bytes.length / 2);
      await handle.write(bytes, 0, half);
      onPhase("tmp-partial");
      await handle.write(bytes, half, bytes.length - half);
    } else {
      await handle.write(bytes);
    }
    onPhase?.("tmp-written");
    if (fsync) await handle.sync();
    onPhase?.("tmp-synced");
    await handle.close();
    await rename(tmp, target);
    renamed = true;
    onPhase?.("renamed");
    if (fsync) await syncDirectory(dir);
  } finally {
    // `close` is idempotent for FileHandle; ignore the already-closed case.
    await handle.close().catch(() => undefined);
    if (!renamed) await unlink(tmp).catch(() => undefined);
  }
}

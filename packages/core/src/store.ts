import { appendFile, mkdir, open, readdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { type AtomicWritePhase, tempFileOwner, writeFileAtomic } from "./atomic.js";
import {
  type Actor,
  applyEvent,
  CorruptEventLogError,
  EVENT_TYPES,
  type EventEnvelope,
  EventEnvelopeSchema,
  type EventInput,
  foldEvents,
  type TaskSnapshot,
  TaskSnapshotSchema,
} from "./events.js";
import { TASK_ID_PATTERN } from "./id.js";
import { type LockOptions, withLock } from "./lock.js";
import { SCHEMA_VERSION } from "./schema-version.js";
import type { TaskState } from "./state.js";
import { type Task, TaskSchema } from "./task.js";

/** Directory name of runtime state inside a repository or workspace root. Git-ignored. */
export const STATE_DIR_NAME = ".cantiere";

/**
 * Upper bound for one serialized event line (including the newline). Events record metadata and
 * outcomes; raw agent output goes to `tasks/<id>/log/`, and page bodies or secrets are not logged.
 */
export const MAX_EVENT_BYTES = 64 * 1024;

export const StoreConfigSchema = z.looseObject({ schemaVersion: z.number().int().positive() });
export type StoreConfig = z.infer<typeof StoreConfigSchema>;

export class TaskNotFoundError extends Error {
  constructor(readonly taskId: string) {
    super(
      `Task ${taskId} does not exist in this store. List tasks to find the right id, or create it first.`,
    );
    this.name = "TaskNotFoundError";
  }
}

export class TaskExistsError extends Error {
  constructor(readonly taskId: string) {
    super(`Task ${taskId} already exists; task ids are never reused. Generate a new id.`);
    this.name = "TaskExistsError";
  }
}

export class EventTooLargeError extends Error {
  constructor(eventType: string, bytes: number) {
    super(
      `A ${eventType} event is ${bytes} bytes; the limit is ${MAX_EVENT_BYTES}. ` +
        "Events record metadata and outcomes only: write bulk output to the task's log/ directory " +
        "and reference it from the event.",
    );
    this.name = "EventTooLargeError";
  }
}

export interface StoreOptions {
  /** fsync events and snapshots so they survive power loss, not just process death. Default true. */
  fsync?: boolean;
  /** Lock behaviour for the per-task and repo-level locks. */
  lock?: LockOptions;
  /** Clock, injectable for tests. */
  now?: () => Date;
  /** Test seam: observe (or crash at) each phase of a snapshot write. */
  onSnapshotPhase?: (phase: AtomicWritePhase) => void;
}

export interface ReadEventsResult {
  events: EventEnvelope[];
  /** Bytes of an unterminated final line (an interrupted append) that were ignored. */
  tornBytes: number;
}

export interface RebuildResult {
  snapshot: TaskSnapshot;
  /** False when the snapshot on disk was already identical to the rebuilt one. */
  changed: boolean;
}

/** Where a store lives for a repository or workspace root. */
export function stateDirFor(root: string): string {
  return path.join(root, STATE_DIR_NAME);
}

/** Canonical on-disk text of a snapshot: stable key order, so rebuilds are byte-identical. */
export function serializeSnapshot(snapshot: TaskSnapshot): string {
  return `${JSON.stringify(TaskSnapshotSchema.parse(snapshot), null, 2)}\n`;
}

function assertTaskId(taskId: string): void {
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new Error(
      `Invalid task id "${taskId}": expected 13 lowercase Crockford base32 characters.`,
    );
  }
}

const NEWLINE = 0x0a;
const INITIAL_TAIL_BYTES = 8 * 1024;

interface Tail {
  /** Bytes up to and including the last newline: the extent of well-formed content. */
  goodSize: number;
  /** An unterminated final fragment, if any. */
  torn: Buffer;
  /** The last complete line, if any. */
  lastLine?: string;
}

/**
 * Finds the end of the log without reading all of it, so appending stays O(1) however long the log
 * grows: read a growing window from the end until it holds the last complete line.
 */
async function readTail(file: string, taskId: string): Promise<Tail> {
  const handle = await open(file, "r").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!handle) return { goodSize: 0, torn: Buffer.alloc(0) };
  try {
    const { size } = await handle.stat();
    let window = INITIAL_TAIL_BYTES;
    for (;;) {
      const length = Math.min(window, size);
      const start = size - length;
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, start);
      const last = buf.lastIndexOf(NEWLINE);
      const previous = last > 0 ? buf.lastIndexOf(NEWLINE, last - 1) : -1;
      const complete = last >= 0 && (previous >= 0 || start === 0);
      const wholeFile = start === 0;
      if (complete || (last < 0 && wholeFile)) {
        if (last < 0) return { goodSize: 0, torn: buf };
        return {
          goodSize: start + last + 1,
          torn: buf.subarray(last + 1),
          lastLine: buf.subarray(previous + 1, last).toString("utf8"),
        };
      }
      if (window > MAX_EVENT_BYTES * 2) {
        throw new CorruptEventLogError(
          taskId,
          undefined,
          `no line break within the last ${window} bytes of events.jsonl, more than any valid event.`,
        );
      }
      window *= 2;
    }
  } finally {
    await handle.close();
  }
}

function parseEventLine(taskId: string, line: string, lineNumber: number): EventEnvelope {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    throw new CorruptEventLogError(taskId, undefined, `line ${lineNumber} is not valid JSON.`);
  }
  const parsed = EventEnvelopeSchema.safeParse(json);
  if (!parsed.success) {
    throw new CorruptEventLogError(
      taskId,
      undefined,
      `line ${lineNumber} is not a valid event envelope: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}.`,
    );
  }
  return parsed.data;
}

/**
 * The durable store under `<root>/.cantiere/`:
 *
 * ```
 * config.json
 * locks/                    repo.lock, task-<id>.lock
 * tasks/<id>/task.json      snapshot (cache; rebuildable from events)
 * tasks/<id>/events.jsonl   append-only event log (source of truth)
 * tasks/<id>/log/           raw agent output
 * ```
 *
 * Safe under concurrent writers across processes: every mutation of a task holds its lock, appends
 * are single `O_APPEND` writes of whole lines, and snapshots are replaced by temp file + rename.
 */
export class CantiereStore {
  private constructor(
    readonly dir: string,
    private readonly options: StoreOptions,
  ) {}

  /** Opens (creating on first use) the store at `dir`, which is usually `stateDirFor(root)`. */
  static async open(dir: string, options: StoreOptions = {}): Promise<CantiereStore> {
    const store = new CantiereStore(path.resolve(dir), options);
    await mkdir(path.join(store.dir, "tasks"), { recursive: true });
    await mkdir(path.join(store.dir, "locks"), { recursive: true });
    await store.ensureConfig();
    return store;
  }

  // --- layout -----------------------------------------------------------------------------

  get configPath(): string {
    return path.join(this.dir, "config.json");
  }

  taskDir(taskId: string): string {
    assertTaskId(taskId);
    return path.join(this.dir, "tasks", taskId);
  }

  snapshotPath(taskId: string): string {
    return path.join(this.taskDir(taskId), "task.json");
  }

  eventsPath(taskId: string): string {
    return path.join(this.taskDir(taskId), "events.jsonl");
  }

  /** Directory for raw agent output; kept out of the event log on purpose. */
  taskLogDir(taskId: string): string {
    return path.join(this.taskDir(taskId), "log");
  }

  // --- locks ------------------------------------------------------------------------------

  /** Serializes queue operations (picking the next task, admission) across processes. */
  withRepoLock<T>(fn: () => Promise<T>): Promise<T> {
    return withLock(path.join(this.dir, "locks", "repo.lock"), fn, this.options.lock);
  }

  /** Serializes all mutation of one task across processes. */
  withTaskLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    assertTaskId(taskId);
    return withLock(path.join(this.dir, "locks", `task-${taskId}.lock`), fn, this.options.lock);
  }

  // --- writes -----------------------------------------------------------------------------

  /** Creates a task: records `task.created` as seq 1 and writes the first snapshot. */
  async createTask(task: Task, actor: Actor = "cantiere"): Promise<TaskSnapshot> {
    const parsed = TaskSchema.parse(task);
    await mkdir(this.taskLogDir(parsed.id), { recursive: true });
    return this.withTaskLock(parsed.id, async () => {
      const result = await this.appendLocked(
        parsed.id,
        { type: EVENT_TYPES.taskCreated, actor, data: { task: parsed } },
        true,
      );
      return result.snapshot;
    });
  }

  /**
   * Appends one event. The sequence number is assigned under the task lock, the event is checked
   * against the lifecycle state machine *before* anything is written (an illegal transition leaves
   * the log untouched), and the snapshot is refreshed after the append.
   */
  async append(taskId: string, input: EventInput): Promise<EventEnvelope> {
    assertTaskId(taskId);
    return this.withTaskLock(
      taskId,
      async () => (await this.appendLocked(taskId, input, false)).event,
    );
  }

  /** Records a lifecycle transition, validated by the state machine. */
  async transition(
    taskId: string,
    to: TaskState,
    options: { actor: Actor; reason?: string; approved?: boolean },
  ): Promise<EventEnvelope> {
    const data: Record<string, unknown> = { to };
    if (options.reason !== undefined) data.reason = options.reason;
    if (options.approved !== undefined) data.approved = options.approved;
    return this.append(taskId, { type: EVENT_TYPES.taskTransitioned, actor: options.actor, data });
  }

  /**
   * Re-derives the snapshot from the full event log and rewrites it if it differs. The snapshot is
   * a cache, so this is always safe; `cantiere reconcile` will build on it.
   */
  async rebuildSnapshot(taskId: string): Promise<RebuildResult> {
    assertTaskId(taskId);
    return this.withTaskLock(taskId, async () => {
      await this.repairTail(taskId);
      const snapshot = await this.deriveFromLog(taskId);
      const text = serializeSnapshot(snapshot);
      const current = await readFile(this.snapshotPath(taskId), "utf8").catch(() => undefined);
      if (current === text) return { snapshot, changed: false };
      await this.writeSnapshot(taskId, text);
      return { snapshot, changed: true };
    });
  }

  // --- reads ------------------------------------------------------------------------------

  /** All task ids in the store, in creation order (ids sort by creation time). */
  async listTaskIds(): Promise<string[]> {
    const entries = await readdir(path.join(this.dir, "tasks"), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && TASK_ID_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  }

  /** Reads and validates the whole log. A torn final line is ignored and reported. */
  async readEvents(taskId: string): Promise<ReadEventsResult> {
    assertTaskId(taskId);
    const raw = await readFile(this.eventsPath(taskId)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!raw) return { events: [], tornBytes: 0 };
    const lastBreak = raw.lastIndexOf(NEWLINE);
    const body = raw.subarray(0, lastBreak + 1).toString("utf8");
    const tornBytes = raw.length - (lastBreak + 1);
    const events: EventEnvelope[] = [];
    if (body.length > 0) {
      const lines = body.slice(0, -1).split("\n");
      lines.forEach((line, index) => {
        const event = parseEventLine(taskId, line, index + 1);
        const expected = index + 1;
        if (event.taskId !== taskId) {
          throw new CorruptEventLogError(
            taskId,
            event.seq,
            `it holds an event for task ${event.taskId}.`,
          );
        }
        if (event.seq !== expected) {
          throw new CorruptEventLogError(
            taskId,
            event.seq,
            `expected seq ${expected} on line ${index + 1} (seq must be contiguous and increasing).`,
          );
        }
        events.push(event);
      });
    }
    return { events, tornBytes };
  }

  /**
   * The current snapshot. Uses the cached `task.json` when it is current with the log, otherwise
   * derives the state from events (without writing; use {@link rebuildSnapshot} to repair).
   */
  async getTask(taskId: string): Promise<TaskSnapshot> {
    assertTaskId(taskId);
    const cached = await this.readSnapshotFile(taskId);
    if (cached) {
      const tail = await readTail(this.eventsPath(taskId), taskId);
      const lastSeq = tail.lastLine ? parseEventLine(taskId, tail.lastLine, 0).seq : 0;
      if (cached.seq === lastSeq) return cached;
    }
    return this.deriveFromLog(taskId);
  }

  // --- internals --------------------------------------------------------------------------

  private async ensureConfig(): Promise<void> {
    const read = async () => {
      const text = await readFile(this.configPath, "utf8").catch(() => undefined);
      return text === undefined ? undefined : StoreConfigSchema.parse(JSON.parse(text));
    };
    let config = await read();
    if (!config) {
      config = await this.withRepoLock(async () => {
        const existing = await read();
        if (existing) return existing;
        const fresh: StoreConfig = { schemaVersion: SCHEMA_VERSION };
        await writeFileAtomic(this.configPath, `${JSON.stringify(fresh, null, 2)}\n`, {
          fsync: this.options.fsync ?? true,
        });
        return fresh;
      });
    }
    if (config.schemaVersion > SCHEMA_VERSION) {
      throw new Error(
        `${this.configPath} has schemaVersion ${config.schemaVersion}, newer than this Cantiere supports (${SCHEMA_VERSION}). Upgrade Cantiere before using this store.`,
      );
    }
  }

  private async readSnapshotFile(taskId: string): Promise<TaskSnapshot | undefined> {
    const text = await readFile(this.snapshotPath(taskId), "utf8").catch(() => undefined);
    if (text === undefined) return undefined;
    try {
      const parsed = TaskSnapshotSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  private async deriveFromLog(taskId: string): Promise<TaskSnapshot> {
    const { events } = await this.readEvents(taskId);
    if (events.length === 0) throw new TaskNotFoundError(taskId);
    return foldEvents(taskId, events);
  }

  /**
   * An append interrupted mid-line leaves an unterminated fragment. It was never acknowledged, so
   * it is moved aside (to `events.torn`) and the log is cut back to the last whole line.
   * Must hold the task lock.
   */
  private async repairTail(taskId: string): Promise<Tail> {
    const file = this.eventsPath(taskId);
    const tail = await readTail(file, taskId);
    if (tail.torn.length > 0) {
      await appendFile(path.join(this.taskDir(taskId), "events.torn"), tail.torn);
      const handle = await open(file, "r+");
      try {
        await handle.truncate(tail.goodSize);
        if (this.options.fsync ?? true) await handle.sync();
      } finally {
        await handle.close();
      }
      return {
        goodSize: tail.goodSize,
        torn: Buffer.alloc(0),
        ...(tail.lastLine === undefined ? {} : { lastLine: tail.lastLine }),
      };
    }
    return tail;
  }

  private async appendLocked(
    taskId: string,
    input: EventInput,
    creating: boolean,
  ): Promise<{ event: EventEnvelope; snapshot: TaskSnapshot }> {
    const tail = await this.repairTail(taskId);
    const lastSeq = tail.lastLine ? parseEventLine(taskId, tail.lastLine, 0).seq : 0;

    let current: TaskSnapshot | undefined;
    if (creating) {
      if (lastSeq > 0) throw new TaskExistsError(taskId);
    } else {
      if (lastSeq === 0) throw new TaskNotFoundError(taskId);
      const cached = await this.readSnapshotFile(taskId);
      current = cached?.seq === lastSeq ? cached : await this.deriveFromLog(taskId);
    }

    const event = EventEnvelopeSchema.parse({
      v: SCHEMA_VERSION,
      ts: (this.options.now?.() ?? new Date()).toISOString(),
      taskId,
      seq: lastSeq + 1,
      type: input.type,
      actor: input.actor,
      data: input.data ?? {},
    });
    // Throws (and writes nothing) if the event is invalid or the transition is illegal.
    const snapshot = applyEvent(current, event);

    const line = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
    if (line.length > MAX_EVENT_BYTES) throw new EventTooLargeError(event.type, line.length);

    await this.appendLine(taskId, line);
    await this.writeSnapshot(taskId, serializeSnapshot(snapshot));
    return { event, snapshot };
  }

  /** One `O_APPEND` write of a whole line; the lock makes it the only writer. */
  private async appendLine(taskId: string, line: Buffer): Promise<void> {
    const handle = await open(this.eventsPath(taskId), "a");
    try {
      let written = 0;
      while (written < line.length) {
        const result = await handle.write(line, written, line.length - written);
        written += result.bytesWritten;
      }
      if (this.options.fsync ?? true) await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async writeSnapshot(taskId: string, text: string): Promise<void> {
    await this.sweepTempFiles(taskId);
    await writeFileAtomic(this.snapshotPath(taskId), text, {
      fsync: this.options.fsync ?? true,
      ...(this.options.onSnapshotPhase ? { onPhase: this.options.onSnapshotPhase } : {}),
    });
  }

  /** Removes temp files left by writers that died mid-snapshot (their pid is gone). */
  private async sweepTempFiles(taskId: string): Promise<void> {
    const dir = this.taskDir(taskId);
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      const owner = tempFileOwner(name);
      if (owner === undefined || owner === process.pid) continue;
      try {
        process.kill(owner, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          await unlink(path.join(dir, name)).catch(() => undefined);
        }
      }
    }
  }
}

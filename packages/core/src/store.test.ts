import { type ChildProcess, spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AtomicWritePhase,
  CantiereStore,
  CorruptEventLogError,
  EventEnvelopeSchema,
  EventTooLargeError,
  generateTaskId,
  IllegalTransitionError,
  InvalidEventError,
  LockTimeoutError,
  MAX_EVENT_BYTES,
  SCHEMA_VERSION,
  serializeSnapshot,
  type Task,
  TaskExistsError,
  TaskNotFoundError,
  TaskSnapshotSchema,
  withLock,
} from "./index.js";

// Several tests spawn child processes (tsx start-up under load can be slow).
vi.setConfig({ testTimeout: 30_000 });

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const worker = path.join(root, "packages/core/src/store-worker.fixture.ts");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "cantiere-store-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

let idCounter = 0;
function makeTask(overrides: Partial<Task> = {}): Task {
  idCounter++;
  return {
    schemaVersion: SCHEMA_VERSION,
    id: generateTaskId({
      now: () => 1_700_000_000_000 + idCounter,
      randomInt: () => idCounter % 32,
    }),
    title: "Fix flaky test",
    prompt: "Find and fix the flaky test.",
    kind: "agent",
    repo: "/work/repo",
    baseRef: "main",
    harness: "claude-code",
    createdAt: "2026-11-10T00:00:00.000Z",
    labels: [],
    source: "manual",
    ...overrides,
  };
}

async function openStore(options = {}) {
  return CantiereStore.open(path.join(dir, ".cantiere"), { fsync: false, ...options });
}

/** Drives a task through the full happy-path lifecycle. */
async function run(store: CantiereStore, id: string) {
  await store.transition(id, "provisioning", { actor: "cantiere" });
  await store.append(id, {
    type: "task.provisioned",
    actor: "cantiere",
    data: { branch: "cantiere/x", worktreePath: "/w/x" },
  });
  await store.transition(id, "running", { actor: "cantiere" });
  await store.append(id, { type: "test.note", actor: "agent", data: { msg: "hello" } });
  await store.transition(id, "done", { actor: "agent" });
}

function spawnWorker(args: string[]): { child: ChildProcess; exit: Promise<number | null> } {
  const child = spawn(process.execPath, ["--import", "tsx", worker, ...args], {
    cwd: root,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exit = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code !== 0 && signal === null) reject(new Error(`worker exited ${code}: ${stderr}`));
      else resolve(signal === null ? code : null);
    });
  });
  return { child, exit };
}

describe("layout", () => {
  it("creates config.json, tasks/ and locks/ and is safe to reopen", async () => {
    const store = await openStore();
    expect(JSON.parse(readFileSync(store.configPath, "utf8"))).toEqual({
      schemaVersion: SCHEMA_VERSION,
    });
    expect(existsSync(path.join(store.dir, "tasks"))).toBe(true);
    expect(existsSync(path.join(store.dir, "locks"))).toBe(true);
    await openStore();
  });

  it("refuses a store written by a newer schema", async () => {
    mkdirSync(path.join(dir, ".cantiere"), { recursive: true });
    writeFileSync(path.join(dir, ".cantiere/config.json"), '{"schemaVersion":2}');
    await expect(openStore()).rejects.toThrow(/newer than this Cantiere supports/);
  });

  it("creates task files and the log directory", async () => {
    const store = await openStore();
    const task = makeTask();
    await store.createTask(task);
    expect(existsSync(store.snapshotPath(task.id))).toBe(true);
    expect(existsSync(store.eventsPath(task.id))).toBe(true);
    expect(existsSync(store.taskLogDir(task.id))).toBe(true);
    expect(await store.listTaskIds()).toEqual([task.id]);
  });

  it("rejects task ids that could escape the store", async () => {
    const store = await openStore();
    expect(() => store.taskDir("../../etc")).toThrow(/Invalid task id/);
    await expect(store.append("../x", { type: "t", actor: "agent" })).rejects.toThrow(
      /Invalid task id/,
    );
  });
});

describe("append and state", () => {
  it("assigns contiguous seq numbers and derives state through the state machine", async () => {
    const store = await openStore();
    const task = makeTask();
    const created = await store.createTask(task);
    expect(created.state).toBe("queued");
    await run(store, task.id);

    const { events, tornBytes } = await store.readEvents(task.id);
    expect(tornBytes).toBe(0);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(events.map((e) => e.type)).toEqual([
      "task.created",
      "task.transitioned",
      "task.provisioned",
      "task.transitioned",
      "test.note",
      "task.transitioned",
    ]);
    for (const event of events) {
      expect(EventEnvelopeSchema.safeParse(event).success).toBe(true);
      expect(event.v).toBe(SCHEMA_VERSION);
      expect(event.taskId).toBe(task.id);
    }

    const snapshot = await store.getTask(task.id);
    expect(snapshot).toMatchObject({
      state: "done",
      seq: 6,
      task: { branch: "cantiere/x", worktreePath: "/w/x" },
    });
    expect(TaskSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it("rejects an illegal transition and writes nothing", async () => {
    const store = await openStore();
    const task = makeTask();
    await store.createTask(task);
    await expect(store.transition(task.id, "done", { actor: "agent" })).rejects.toThrow(
      IllegalTransitionError,
    );
    expect((await store.readEvents(task.id)).events).toHaveLength(1);
    expect((await store.getTask(task.id)).state).toBe("queued");
  });

  it("enforces guards from the state machine (reason, provisioned, approval)", async () => {
    const store = await openStore();
    const task = makeTask();
    await store.createTask(task);
    await store.transition(task.id, "provisioning", { actor: "cantiere" });
    // not provisioned yet
    await expect(store.transition(task.id, "running", { actor: "cantiere" })).rejects.toThrow(
      /no worktree and branch/,
    );
    await expect(store.transition(task.id, "failed", { actor: "cantiere" })).rejects.toThrow(
      /requires a reason/,
    );
    await store.transition(task.id, "failed", { actor: "cantiere", reason: "no disk" });
    expect((await store.getTask(task.id)).state).toBe("failed");
  });

  it("rejects malformed payloads for known event types", async () => {
    const store = await openStore();
    const task = makeTask();
    await store.createTask(task);
    await expect(
      store.append(task.id, { type: "task.transitioned", actor: "agent", data: { to: "nope" } }),
    ).rejects.toThrow(InvalidEventError);
    await expect(
      store.append(task.id, {
        type: "task.provisioned",
        actor: "agent",
        data: { branch: "b", worktreePath: "/w" },
      }),
    ).rejects.toThrow(/only be recorded while provisioning/);
    await expect(
      store.append(task.id, { type: "task.created", actor: "agent", data: { task } }),
    ).rejects.toThrow(/already exists/);
  });

  it("refuses to create the same task twice and to append to a missing task", async () => {
    const store = await openStore();
    const task = makeTask();
    await store.createTask(task);
    await expect(store.createTask(task)).rejects.toThrow(TaskExistsError);
    await expect(store.append(makeTask().id, { type: "x", actor: "agent" })).rejects.toThrow(
      TaskNotFoundError,
    );
    await expect(store.getTask(makeTask().id)).rejects.toThrow(TaskNotFoundError);
  });

  it("rejects an oversized event with an actionable message", async () => {
    const store = await openStore();
    const task = makeTask();
    await store.createTask(task);
    const err = await store
      .append(task.id, {
        type: "test.note",
        actor: "agent",
        data: { body: "x".repeat(MAX_EVENT_BYTES) },
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EventTooLargeError);
    expect(String(err)).toMatch(/log\/ directory/);
    expect((await store.readEvents(task.id)).events).toHaveLength(1);
  });

  it("accepts the maximum-size event and still finds the tail afterwards", async () => {
    const store = await openStore();
    const task = makeTask();
    await store.createTask(task);
    const overhead = Buffer.byteLength(
      JSON.stringify({
        v: 1,
        ts: new Date().toISOString(),
        taskId: task.id,
        seq: 2,
        type: "test.note",
        actor: "agent",
        data: { body: "" },
      }),
    );
    const body = "x".repeat(MAX_EVENT_BYTES - overhead - 1 - 100);
    await store.append(task.id, { type: "test.note", actor: "agent", data: { body } });
    const next = await store.append(task.id, { type: "test.note", actor: "agent" });
    expect(next.seq).toBe(3);
  });
});

describe("forward compatibility", () => {
  it("preserves unknown event types, extra fields and newer envelope versions", async () => {
    const store = await openStore();
    const task = makeTask();
    await store.createTask(task);
    const future = {
      v: 2,
      ts: "2026-11-11T00:00:00.000Z",
      taskId: task.id,
      seq: 2,
      type: "task.transitioned",
      actor: "agent",
      data: { to: "something-new" },
      extra: { kept: true },
    };
    const unknown = {
      v: 1,
      ts: "2026-11-11T00:00:01.000Z",
      taskId: task.id,
      seq: 3,
      type: "future.thing",
      actor: "human",
      data: { a: 1 },
      trace: "abc",
    };
    appendFileSync(
      store.eventsPath(task.id),
      `${JSON.stringify(future)}\n${JSON.stringify(unknown)}\n`,
    );

    const { events } = await store.readEvents(task.id);
    expect(events[1]).toEqual(future);
    expect(events[2]).toEqual(unknown);

    // Not interpreted, but counted: state is untouched and appends continue after them.
    const snapshot = await store.getTask(task.id);
    expect(snapshot).toMatchObject({ state: "queued", seq: 3 });
    const next = await store.append(task.id, { type: "test.note", actor: "agent" });
    expect(next.seq).toBe(4);
    const raw = readFileSync(store.eventsPath(task.id), "utf8").split("\n");
    expect(raw[1]).toBe(JSON.stringify(future));
    expect(raw[2]).toBe(JSON.stringify(unknown));
  });
});

describe("snapshots are a rebuildable cache", () => {
  it("rebuilding from events yields identical snapshots", async () => {
    const store = await openStore();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const task = makeTask();
      ids.push(task.id);
      await store.createTask(task);
      await run(store, task.id);
      await store.append(task.id, { type: "future.thing", actor: "human", data: { i } });
    }
    for (const id of ids) {
      const before = readFileSync(store.snapshotPath(id), "utf8");
      const result = await store.rebuildSnapshot(id);
      expect(result.changed).toBe(false);
      expect(readFileSync(store.snapshotPath(id), "utf8")).toBe(before);
      expect(serializeSnapshot(result.snapshot)).toBe(before);

      // Also from scratch: delete the cache entirely.
      rmSync(store.snapshotPath(id));
      const rebuilt = await store.rebuildSnapshot(id);
      expect(rebuilt.changed).toBe(true);
      expect(readFileSync(store.snapshotPath(id), "utf8")).toBe(before);
    }
  });

  it.each([
    ["missing", (_good: string, file: string) => rmSync(file)],
    ["truncated", (_good: string, file: string) => writeFileSync(file, '{"schemaVers')],
    [
      "stale",
      (good: string, file: string) => writeFileSync(file, good.replace('"seq": 6', '"seq": 3')),
    ],
    [
      "ahead of the log",
      (good: string, file: string) => writeFileSync(file, good.replace('"seq": 6', '"seq": 60')),
    ],
  ])("heals a %s snapshot", async (_name, damage) => {
    const store = await openStore();
    const task = makeTask();
    await store.createTask(task);
    await run(store, task.id);
    const file = store.snapshotPath(task.id);
    const good = readFileSync(file, "utf8");

    damage(good, file);
    // Reads fall back to the log without needing the cache.
    expect(await store.getTask(task.id)).toMatchObject({ state: "done", seq: 6 });
    // Rebuilding restores the exact bytes.
    await store.rebuildSnapshot(task.id);
    expect(readFileSync(file, "utf8")).toBe(good);

    // Appending also heals: the new snapshot reflects the whole history, not just the new event.
    damage(good, file);
    await store.append(task.id, { type: "test.note", actor: "agent" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ state: "done", seq: 7 });
  });
});

describe("torn and corrupt logs", () => {
  it("ignores an unterminated final line on read and moves it aside on the next append", async () => {
    const store = await openStore();
    const task = makeTask();
    await store.createTask(task);
    await store.append(task.id, { type: "test.note", actor: "agent" });
    appendFileSync(store.eventsPath(task.id), '{"v":1,"ts":"2026-11-10T00:00:00.000Z","taskId":');

    const read = await store.readEvents(task.id);
    expect(read.events).toHaveLength(2);
    expect(read.tornBytes).toBeGreaterThan(0);
    expect((await store.getTask(task.id)).seq).toBe(2);

    const next = await store.append(task.id, { type: "test.note", actor: "agent" });
    expect(next.seq).toBe(3);
    const after = await store.readEvents(task.id);
    expect(after.tornBytes).toBe(0);
    expect(after.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(readFileSync(path.join(store.taskDir(task.id), "events.torn"), "utf8")).toContain(
      '"taskId":',
    );
  });

  it("recovers when the whole log is one torn fragment", async () => {
    const store = await openStore();
    const task = makeTask();
    await store.createTask(task);
    truncateSync(store.eventsPath(task.id), 10);
    await expect(store.append(task.id, { type: "x", actor: "agent" })).rejects.toThrow(
      TaskNotFoundError,
    );
  });

  it("fails loudly on a corrupt line in the middle", async () => {
    const store = await openStore();
    const task = makeTask();
    await store.createTask(task);
    await store.append(task.id, { type: "test.note", actor: "agent" });
    const lines = readFileSync(store.eventsPath(task.id), "utf8").split("\n");
    lines[0] = "{not json";
    writeFileSync(store.eventsPath(task.id), lines.join("\n"));
    await expect(store.readEvents(task.id)).rejects.toThrow(CorruptEventLogError);
    await expect(store.readEvents(task.id)).rejects.toThrow(/line 1 is not valid JSON/);
  });

  it("fails loudly on a seq gap or an event for another task", async () => {
    const store = await openStore();
    const task = makeTask();
    await store.createTask(task);
    const other = makeTask();
    const base = {
      v: 1,
      ts: "2026-11-10T00:00:00.000Z",
      type: "test.note",
      actor: "agent",
      data: {},
    };
    appendFileSync(
      store.eventsPath(task.id),
      `${JSON.stringify({ ...base, taskId: task.id, seq: 5 })}\n`,
    );
    await expect(store.readEvents(task.id)).rejects.toThrow(/expected seq 2/);
    writeFileSync(
      store.eventsPath(task.id),
      `${readFileSync(store.eventsPath(task.id), "utf8").split("\n")[0]}\n${JSON.stringify({ ...base, taskId: other.id, seq: 2 })}\n`,
    );
    await expect(store.readEvents(task.id)).rejects.toThrow(/holds an event for task/);
  });

  it("fails loudly when recorded history contradicts the state machine", async () => {
    const store = await openStore();
    const task = makeTask();
    await store.createTask(task);
    const bad = {
      v: 1,
      ts: "2026-11-10T00:00:00.000Z",
      taskId: task.id,
      seq: 2,
      type: "task.transitioned",
      actor: "agent",
      data: { to: "landed" },
    };
    appendFileSync(store.eventsPath(task.id), `${JSON.stringify(bad)}\n`);
    await expect(store.rebuildSnapshot(task.id)).rejects.toThrow(/corrupt at seq 2/);
  });
});

describe("locks", () => {
  it("recovers a lock left behind by a process that was killed", async () => {
    const store = await openStore();
    const task = makeTask();
    await store.createTask(task);
    const lockPath = path.join(store.dir, "locks", `task-${task.id}.lock`);
    // Simulate a SIGKILLed holder: a lock file whose pid no longer exists.
    const dead = spawn(process.execPath, ["-e", ""]);
    await new Promise((resolve) => dead.on("exit", resolve));
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: dead.pid,
        host: os.hostname(),
        token: "dead",
        acquiredAt: new Date().toISOString(),
      }),
    );
    const event = await store.append(task.id, { type: "test.note", actor: "agent" });
    expect(event.seq).toBe(2);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("times out with an actionable error while a live process holds the lock", async () => {
    const lockPath = path.join(dir, "x.lock");
    await withLock(lockPath, async () => {
      const err = await withLock(lockPath, async () => undefined, { timeoutMs: 50 }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(LockTimeoutError);
      expect(String(err)).toMatch(/held by pid/);
    });
    // released afterwards
    await withLock(lockPath, async () => undefined, { timeoutMs: 50 });
  });

  it("serializes in-process concurrent appends", async () => {
    const store = await openStore();
    const task = makeTask();
    await store.createTask(task);
    await Promise.all(
      Array.from({ length: 50 }, (_, n) =>
        store.append(task.id, { type: "test.note", actor: "agent", data: { n } }),
      ),
    );
    const { events } = await store.readEvents(task.id);
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 51 }, (_, i) => i + 1));
  });

  it("runs queue operations under the repo lock", async () => {
    const store = await openStore();
    let active = 0;
    let max = 0;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        store.withRepoLock(async () => {
          active++;
          max = Math.max(max, active);
          await new Promise((r) => setTimeout(r, 2));
          active--;
        }),
      ),
    );
    expect(max).toBe(1);
  });
});

describe("concurrency across processes", () => {
  it("20 processes append 500 events each: no line lost or torn, seq strictly increasing", async () => {
    const store = await openStore();
    const task = makeTask();
    await store.createTask(task);

    const PROCESSES = 20;
    const EVENTS_EACH = 500;
    const workers = Array.from({ length: PROCESSES }, (_, i) =>
      spawnWorker(["append", store.dir, task.id, String(EVENTS_EACH), `w${i}`]),
    );
    await Promise.all(workers.map((w) => w.exit));

    const text = readFileSync(store.eventsPath(task.id), "utf8");
    expect(text.endsWith("\n")).toBe(true);
    const lines = text.slice(0, -1).split("\n");
    expect(lines).toHaveLength(1 + PROCESSES * EVENTS_EACH);
    const parsed = lines.map((line) => EventEnvelopeSchema.parse(JSON.parse(line)));
    parsed.forEach((event, index) => {
      expect(event.seq).toBe(index + 1);
    });

    // None lost: every worker's events 0..499 are present, in order per worker.
    const perWorker = new Map<string, number[]>();
    for (const event of parsed.slice(1)) {
      const { label, n } = event.data as { label: string; n: number };
      perWorker.set(label, [...(perWorker.get(label) ?? []), n]);
    }
    expect(perWorker.size).toBe(PROCESSES);
    for (const ns of perWorker.values()) {
      expect(ns).toEqual(Array.from({ length: EVENTS_EACH }, (_, n) => n));
    }

    // The snapshot is current and rebuilds identically.
    const before = readFileSync(store.snapshotPath(task.id), "utf8");
    expect(JSON.parse(before).seq).toBe(1 + PROCESSES * EVENTS_EACH);
    expect((await store.rebuildSnapshot(task.id)).changed).toBe(false);
    expect(readFileSync(store.snapshotPath(task.id), "utf8")).toBe(before);
    expect(readdirSync(path.join(store.dir, "locks"))).toEqual([]);
  }, 180_000);
});

describe("fault injection: kill -9 during a snapshot write", () => {
  const PHASES: AtomicWritePhase[] = [
    "tmp-created",
    "tmp-partial",
    "tmp-written",
    "tmp-synced",
    "renamed",
  ];

  function assertSnapshotIntact(store: CantiereStore, id: string) {
    const text = readFileSync(store.snapshotPath(id), "utf8");
    // Never corrupt: whole, parseable, schema-valid.
    expect(TaskSnapshotSchema.safeParse(JSON.parse(text)).success).toBe(true);
  }

  it.each(PHASES)("dying at %s never leaves a corrupt task.json", async (phase) => {
    const store = await openStore();
    const task = makeTask();
    await store.createTask(task);
    const { exit } = spawnWorker(["crash", store.dir, task.id, phase, "3"]);
    expect(await exit).toBeNull(); // killed by signal

    assertSnapshotIntact(store, task.id);
    // The log kept every acknowledged-or-in-flight event; the cache may lag but state is exact.
    const { events, tornBytes } = await store.readEvents(task.id);
    expect(tornBytes).toBe(0);
    const derived = await store.getTask(task.id);
    expect(derived.seq).toBe(events.length);

    // The next writer recovers (stale lock, stray temp file) and the store keeps working.
    const next = await store.append(task.id, { type: "test.note", actor: "human" });
    expect(next.seq).toBe(events.length + 1);
    assertSnapshotIntact(store, task.id);
    const leftovers = readdirSync(store.taskDir(task.id)).filter((n) => n.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
    const before = readFileSync(store.snapshotPath(task.id), "utf8");
    expect((await store.rebuildSnapshot(task.id)).changed).toBe(false);
    expect(readFileSync(store.snapshotPath(task.id), "utf8")).toBe(before);
  });

  it("random kill -9 of a busy writer, repeatedly, never corrupts task.json or the log", async () => {
    const store = await openStore({ fsync: true });
    const task = makeTask();
    await store.createTask(task);
    let lastCount = 1;
    for (let round = 0; round < 12; round++) {
      const { child, exit } = spawnWorker(["loop", store.dir, task.id, `r${round}`]);
      await new Promise((r) => setTimeout(r, 250 + Math.random() * 250));
      child.kill("SIGKILL");
      await exit;

      assertSnapshotIntact(store, task.id);
      const { events, tornBytes } = await store.readEvents(task.id);
      expect(tornBytes).toBe(0);
      expect(events.length).toBeGreaterThanOrEqual(lastCount);
      lastCount = events.length;
    }
    const rebuilt = await store.rebuildSnapshot(task.id);
    expect(rebuilt.snapshot.seq).toBe(lastCount);
    assertSnapshotIntact(store, task.id);
  }, 120_000);
});

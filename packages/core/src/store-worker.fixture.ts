/**
 * Child-process worker for the store's concurrency and fault-injection tests. Run with
 * `node --import tsx store-worker.fixture.ts <mode> <stateDir> <taskId> [...]`.
 *
 * Modes:
 *   append  <count> <label>          append `count` note events, then exit 0
 *   loop    <label>                  append note events until killed
 *   crash   <phase> <afterWrites>    after `afterWrites` complete snapshot writes, SIGKILL itself at
 *                                    `phase` of the next one
 */
import type { AtomicWritePhase } from "./atomic.js";
import { CantiereStore } from "./store.js";

const [mode, stateDir, taskId, ...rest] = process.argv.slice(2);
if (!mode || !stateDir || !taskId) {
  console.error("usage: store-worker.fixture.ts <mode> <stateDir> <taskId> ...");
  process.exit(2);
}

const note = (label: string, n: number) => ({
  type: "test.note",
  actor: "agent" as const,
  data: { label, n },
});

async function main(): Promise<void> {
  if (mode === "append") {
    const store = await CantiereStore.open(stateDir as string, { fsync: false });
    const count = Number(rest[0]);
    const label = rest[1] ?? String(process.pid);
    for (let n = 0; n < count; n++) await store.append(taskId as string, note(label, n));
    return;
  }
  if (mode === "loop") {
    const store = await CantiereStore.open(stateDir as string);
    const label = rest[0] ?? String(process.pid);
    for (let n = 0; ; n++) await store.append(taskId as string, note(label, n));
  }
  if (mode === "crash") {
    const phase = rest[0] as AtomicWritePhase;
    const afterWrites = Number(rest[1] ?? 0);
    let completed = 0;
    const store = await CantiereStore.open(stateDir as string, {
      onSnapshotPhase(current) {
        if (current === "renamed") completed++;
        if (completed >= afterWrites && current === phase) process.kill(process.pid, "SIGKILL");
      },
    });
    for (let n = 0; ; n++) await store.append(taskId as string, note("crash", n));
  }
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

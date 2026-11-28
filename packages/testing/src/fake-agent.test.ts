import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext } from "@cantiere/adapters";
import { TaskSchema } from "@cantiere/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeAdapter, detectFakeState } from "./fake-adapter.js";
import type { FakeScript } from "./fake-agent-script.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fake-agent-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const task = TaskSchema.parse({
  schemaVersion: 1,
  id: "01k3m9x2q7a4b",
  title: "t",
  prompt: "p",
  kind: "agent",
  repo: "/r",
  baseRef: "main",
  harness: "fake",
  createdAt: "2026-11-15T12:00:00.000Z",
  source: "manual",
});

function start(script: FakeScript, resumed = false) {
  const adapter = createFakeAdapter(script);
  const ctx: AdapterContext = {
    repo: "/r",
    worktree: dir,
    reportBinary: "/bin/cantiere",
    eventsPath: "/r/events.jsonl",
    mode: "headless",
  };
  const spec = resumed ? adapter.resumeCommand?.(task, ctx) : adapter.buildCommand(task, ctx);
  if (!spec) throw new Error("no command");
  const [bin, ...args] = spec.argv;
  const child = spawn(bin as string, args, { cwd: spec.cwd, env: spec.env as NodeJS.ProcessEnv });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d: string) => {
    stdout += d;
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  return { adapter, child: child as ChildProcessWithoutNullStreams, exited, out: () => stdout };
}

describe("fake agent (real processes)", () => {
  it("emits status events and exits 0", async () => {
    const run = start({
      steps: [
        { do: "emit", status: "working", message: "starting" },
        { do: "print", text: "plain output" },
        { do: "emit", status: "done" },
      ],
    });
    expect(await run.exited).toEqual({ code: 0, signal: null });
    expect(run.out()).toContain('"status":"working"');
    expect(run.out()).toContain("plain output");
    expect(run.out()).toContain('"status":"done"');
  });

  it("really sleeps", async () => {
    const started = Date.now();
    const run = start({ steps: [{ do: "sleep", ms: 300 }] });
    expect((await run.exited).code).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
  });

  it("crashes with an exit code", async () => {
    const run = start({
      steps: [
        { do: "emit", status: "working" },
        { do: "crash", code: 42 },
      ],
    });
    expect(await run.exited).toEqual({ code: 42, signal: null });
  });

  it("crashes with a signal", async () => {
    const run = start({ steps: [{ do: "crash", signal: "SIGKILL" }] });
    expect(await run.exited).toEqual({ code: null, signal: "SIGKILL" });
  });

  it("asks a question, waits for the steering answer, then continues", async () => {
    const run = start({
      steps: [
        { do: "ask", question: "Which branch?" },
        { do: "emit", status: "done" },
      ],
    });
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (run.out().includes("Which branch?")) {
          clearInterval(poll);
          resolve();
        }
      }, 20);
    });
    expect(detectFakeState(run.out())).toEqual([{ kind: "asking", question: "Which branch?" }]);
    await run.adapter.deliver(
      { taskId: task.id, write: (d) => new Promise((r) => run.child.stdin.write(d, () => r())) },
      "main",
    );
    expect((await run.exited).code).toBe(0);
    expect(run.out()).toContain('"answer":"main"');
  });

  it("exits non-zero when its input closes while it waits for an answer", async () => {
    const run = start({ steps: [{ do: "ask", question: "anyone?" }] });
    run.child.stdin.end();
    expect((await run.exited).code).toBe(3);
  });

  it("sees the environment contract and the worktree as its cwd", async () => {
    const run = start({ steps: [{ do: "echo-env" }] });
    await run.exited;
    const line = JSON.parse(run.out().trim().split("\n")[0] as string);
    expect(line.env).toMatchObject({
      CANTIERE_TASK: task.id,
      CANTIERE_REPO: "/r",
      CANTIERE_WORKTREE: dir,
      CANTIERE_REPORT: "/bin/cantiere",
      CANTIERE_EVENTS: "/r/events.jsonl",
    });
    expect(await realpath(line.cwd)).toBe(await realpath(dir));
    expect(line.resumed).toBe(false);
  });

  it("marks a resumed run", async () => {
    const run = start({ steps: [{ do: "echo-env" }] }, true);
    await run.exited;
    expect(JSON.parse(run.out().trim()).resumed).toBe(true);
  });
});

async function realpath(p: string): Promise<string> {
  const { realpath: rp } = await import("node:fs/promises");
  return rp(p);
}

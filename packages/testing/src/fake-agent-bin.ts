// The fake agent process. Self-contained on purpose: it uses only node builtins and type-only
// imports, so it runs both compiled (dist/) and straight from source with type stripping.
import { createInterface } from "node:readline";
import type { FakeLine, FakeScript, FakeStep } from "./fake-agent-script.js";

const ENV_KEYS = [
  "CANTIERE_TASK",
  "CANTIERE_REPO",
  "CANTIERE_WORKTREE",
  "CANTIERE_REPORT",
  "CANTIERE_EVENTS",
];

function line(type: FakeLine["type"], fields: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ fakeAgent: 1, type, ...fields })}\n`);
}

const stdin = createInterface({ input: process.stdin });
const pending: string[] = [];
const waiters: Array<(l: string | null) => void> = [];
let closed = false;
stdin.on("line", (l) => {
  const w = waiters.shift();
  if (w) w(l);
  else pending.push(l);
});
stdin.on("close", () => {
  closed = true;
  for (const w of waiters.splice(0)) w(null);
});

function nextLine(): Promise<string | null> {
  const queued = pending.shift();
  if (queued !== undefined) return Promise.resolve(queued);
  if (closed) return Promise.resolve(null);
  return new Promise((resolve) => waiters.push(resolve));
}

async function run(step: FakeStep): Promise<void> {
  switch (step.do) {
    case "emit":
      line("status", { status: step.status, message: step.message });
      return;
    case "print":
      process.stdout.write(`${step.text}\n`);
      return;
    case "sleep":
      await new Promise((r) => setTimeout(r, step.ms));
      return;
    case "ask": {
      line("question", { question: step.question });
      const answer = await nextLine();
      if (answer === null) {
        process.stderr.write("fake agent: input closed while waiting for an answer\n");
        process.exit(3);
      }
      line("answer", { answer });
      return;
    }
    case "echo-env": {
      const env: Record<string, string | undefined> = {};
      for (const k of ENV_KEYS) env[k] = process.env[k];
      line("env", { env, cwd: process.cwd(), resumed: process.env.CANTIERE_FAKE_RESUME === "1" });
      return;
    }
    case "crash":
      if (step.signal) process.kill(process.pid, step.signal);
      process.exit(step.code ?? 1);
      return;
    case "exit":
      process.exit(step.code ?? 0);
  }
}

async function main(): Promise<void> {
  const flag = process.argv.indexOf("--script-json");
  const raw = flag >= 0 ? process.argv[flag + 1] : undefined;
  if (raw === undefined) {
    process.stderr.write("fake agent: pass --script-json '{\"steps\":[...]}'\n");
    process.exit(2);
  }
  const script = JSON.parse(raw) as FakeScript;
  for (const step of script.steps) await run(step);
  process.exit(0);
}

void main();

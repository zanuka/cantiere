/** A scripted behaviour for the fake agent. The fake agent runs these steps in order, as a real process. */
export type FakeStep =
  | { do: "emit"; status: "working" | "blocked" | "needs-decision" | "done"; message?: string }
  | { do: "print"; text: string }
  | { do: "sleep"; ms: number }
  | { do: "ask"; question: string }
  | { do: "echo-env" }
  | { do: "crash"; code?: number; signal?: "SIGKILL" | "SIGTERM" | "SIGABRT" }
  | { do: "exit"; code?: number };

export interface FakeScript {
  steps: FakeStep[];
}

/** Every line the fake agent writes to stdout for the runtime is JSON starting with this marker field. */
export const FAKE_PROTOCOL = 1;

export interface FakeLine {
  fakeAgent: typeof FAKE_PROTOCOL;
  type: "status" | "question" | "answer" | "env";
  [key: string]: unknown;
}

export function parseFakeScript(json: string): FakeScript {
  const value = JSON.parse(json) as { steps?: unknown };
  if (!value || !Array.isArray(value.steps)) {
    throw new Error('fake agent script must be {"steps": [...]}');
  }
  return value as FakeScript;
}

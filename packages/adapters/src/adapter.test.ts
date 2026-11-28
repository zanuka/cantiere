import { describe, expect, it } from "vitest";
import {
  ADAPTER_API_VERSION,
  type AdapterContext,
  AGENT_ENV_KEYS,
  buildAgentEnv,
  buildCommandEnv,
  checkAdapterShape,
} from "./adapter.js";

const ctx: AdapterContext = {
  repo: "/r",
  worktree: "/w",
  reportBinary: "/bin/cantiere",
  eventsPath: "/r/.cantiere/tasks/t/events.jsonl",
  mode: "headless",
};

const valid = {
  id: "demo",
  apiVersion: ADAPTER_API_VERSION,
  capabilities: {
    headless: true,
    interactive: false,
    resume: false,
    steerInput: false,
    mcpConfig: false,
    jsonOutput: false,
  },
  buildCommand: () => ({ argv: ["x"], env: {}, cwd: "/w" }),
  prepareWorkspace: async () => [],
  deliver: async () => {},
};

describe("environment contract", () => {
  it("derives all five variables", () => {
    const env = buildAgentEnv({ id: "abc" }, ctx);
    expect(Object.keys(env).sort()).toEqual([...AGENT_ENV_KEYS].sort());
    expect(env.CANTIERE_REPORT).toBe("/bin/cantiere");
  });

  it("lets nothing override the contract", () => {
    const env = buildCommandEnv(
      { id: "abc" },
      { ...ctx, baseEnv: { CANTIERE_TASK: "evil", PATH: "/usr/bin" } },
      { CANTIERE_REPO: "evil" },
    );
    expect(env.CANTIERE_TASK).toBe("abc");
    expect(env.CANTIERE_REPO).toBe("/r");
    expect(env.PATH).toBe("/usr/bin");
  });
});

describe("checkAdapterShape", () => {
  it("accepts a well-formed adapter", () => {
    expect(checkAdapterShape(valid)).toEqual([]);
  });

  it("rejects a different apiVersion with a rebuild hint", () => {
    expect(checkAdapterShape({ ...valid, apiVersion: 99 }).join()).toMatch(/rebuild/);
  });

  it("requires resumeCommand exactly when resume is declared", () => {
    const caps = { ...valid.capabilities, resume: true };
    expect(checkAdapterShape({ ...valid, capabilities: caps }).join()).toMatch(/resumeCommand/);
    expect(
      checkAdapterShape({ ...valid, resumeCommand: () => valid.buildCommand() }).join(),
    ).toMatch(/resumeCommand/);
  });

  it("requires at least one mode", () => {
    const caps = { ...valid.capabilities, headless: false };
    expect(checkAdapterShape({ ...valid, capabilities: caps }).join()).toMatch(
      /headless, interactive/,
    );
  });

  it("rejects non-objects and bad ids", () => {
    expect(checkAdapterShape(null)).not.toEqual([]);
    expect(checkAdapterShape({ ...valid, id: "Bad Id" }).join()).toMatch(/id must/);
  });
});

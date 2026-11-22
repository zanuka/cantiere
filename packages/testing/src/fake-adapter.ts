import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADAPTER_API_VERSION,
  type AdapterContext,
  type AgentSession,
  buildCommandEnv,
  type CommandSpec,
  type HarnessAdapter,
  type PlannedWorkspaceWrite,
  type StateHint,
} from "@cantiere/adapters";
import type { Task } from "@cantiere/core";
import { FAKE_PROTOCOL, type FakeLine, type FakeScript } from "./fake-agent-script.js";

/** Where the fake agent's MCP config lands inside a worktree. */
export const FAKE_MCP_CONFIG = ".fake-agent/mcp.json";

/** Absolute path of the fake agent entry point, compiled (`.js`) or source (`.ts`). */
export function fakeAgentEntry(): { file: string; nodeArgs: string[] } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const js = path.join(here, "fake-agent-bin.js");
  if (existsSync(js)) return { file: js, nodeArgs: [] };
  return {
    file: path.join(here, "fake-agent-bin.ts"),
    nodeArgs: ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"],
  };
}

function parseLine(text: string): FakeLine | null {
  try {
    const value = JSON.parse(text) as FakeLine;
    return value && value.fakeAgent === FAKE_PROTOCOL ? value : null;
  } catch {
    return null;
  }
}

/** Reads the fake agent's output lines and derives hints from them. */
export function detectFakeState(output: string): StateHint[] {
  const hints: StateHint[] = [];
  if (typeof output !== "string") return hints;
  for (const text of output.split("\n")) {
    const l = parseLine(text);
    if (!l) continue;
    if (l.type === "question" && typeof l.question === "string") {
      hints.push({ kind: "asking", question: l.question });
    } else if (l.type === "status" && l.status === "working") {
      hints.push({ kind: "working" });
    } else if (l.type === "status" && l.status === "done") {
      hints.push({ kind: "idle", detail: "done" });
    }
  }
  return hints;
}

/**
 * A complete adapter around the scriptable fake agent. It is a reference implementation of
 * the interface and what the conformance suite is validated against. All capabilities are on.
 */
export function createFakeAdapter(script: FakeScript = { steps: [] }): HarnessAdapter {
  const command = (task: Task, ctx: AdapterContext, resumed: boolean): CommandSpec => {
    const entry = fakeAgentEntry();
    return {
      argv: [
        process.execPath,
        ...entry.nodeArgs,
        entry.file,
        "--script-json",
        JSON.stringify(script),
      ],
      env: buildCommandEnv(task, ctx, resumed ? { CANTIERE_FAKE_RESUME: "1" } : {}),
      cwd: ctx.worktree,
    };
  };

  return {
    id: "fake",
    apiVersion: ADAPTER_API_VERSION,
    capabilities: {
      headless: true,
      interactive: true,
      resume: true,
      steerInput: true,
      mcpConfig: true,
      jsonOutput: true,
    },
    buildCommand: (task, ctx) => command(task, ctx, false),
    resumeCommand: (task, ctx) => command(task, ctx, true),
    async prepareWorkspace(worktree, ctx): Promise<PlannedWorkspaceWrite[]> {
      const target = path.join(worktree, FAKE_MCP_CONFIG);
      const servers = Object.fromEntries(
        (ctx.mcpServers ?? []).map((s) => [
          s.name,
          { command: s.command, args: [...(s.args ?? [])], env: { ...s.env } },
        ]),
      );
      const content = `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;
      let action: PlannedWorkspaceWrite["action"] = "create";
      try {
        action = (await readFile(target, "utf8")) === content ? "unchanged" : "update";
      } catch {
        // not there yet
      }
      if (!ctx.dryRun && action !== "unchanged") {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content);
      }
      return [{ path: target, action, description: "fake agent MCP server list" }];
    },
    async deliver(session: AgentSession, message: string): Promise<void> {
      if (message.length === 0) {
        throw new Error("Cannot deliver an empty message to the fake agent; send some text.");
      }
      await session.write(message.endsWith("\n") ? message : `${message}\n`);
    },
    detectState: detectFakeState,
  };
}

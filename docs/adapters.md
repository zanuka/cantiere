# Writing a harness adapter

Cantiere never assumes one vendor. Claude Code, Codex, Cursor's terminal agent and anything else that runs in a terminal plug in through a small **adapter**: an object that tells the runtime how to start the tool, prepare a worktree for it and talk to it. You can write one in an afternoon: implement the interface below, run the conformance suite, done.

This page describes interface `apiVersion` **1**. Adapters live in `@cantiere/adapters` (the interface) and are checked with `@cantiere/testing` (the conformance suite and a scriptable fake agent). The runtime that launches them is separate (session runner: [ADR 0004](adr/0004-session-host.md); supervision: [ADR 0003](adr/0003-supervision-model.md)); an adapter never owns a process.

## The interface

```ts
import { ADAPTER_API_VERSION, type HarnessAdapter } from "@cantiere/adapters";

export const adapter: HarnessAdapter = {
  id: "my-agent",                       // matches `harness` in .cantiere/config.json and in tasks
  apiVersion: ADAPTER_API_VERSION,      // refused at load time if it differs from the runtime's
  capabilities: { headless: true, interactive: false, resume: false, steerInput: false, mcpConfig: true, jsonOutput: true },

  buildCommand(task, ctx) { /* -> { argv, env, cwd } */ },
  async prepareWorkspace(worktree, ctx) { /* -> PlannedWorkspaceWrite[] */ },
  async deliver(session, message) { /* send steering text */ },
  detectState(output) { /* optional -> StateHint[] */ },
  resumeCommand(task, ctx) { /* only when capabilities.resume */ },
};
```

| Member | Contract |
| --- | --- |
| `id` | Lowercase letters, digits and dashes, starting with a letter. It is the `harness` value users configure. |
| `apiVersion` | Must equal `ADAPTER_API_VERSION`. |
| `capabilities` | `headless` (runs a prompt to completion), `interactive` (terminal UI that takes input), `resume`, `steerInput` (`deliver` works), `mcpConfig`, `jsonOutput`. Declare only what you implement; at least one of `headless`/`interactive`. |
| `buildCommand(task, ctx)` | Pure. Returns `{ argv, env, cwd }`: `cwd` is the worktree, `env` the **complete** environment (see below). Throw an actionable error for a `ctx.mode` you do not support. |
| `prepareWorkspace(worktree, ctx)` | Writes harness config into the worktree, for example the MCP server list from `ctx.mcpServers`. Idempotent. Writes only inside `worktree`. With `ctx.dryRun` it writes nothing and returns what it would write. Returns `{ path, action: "create" \| "update" \| "unchanged" }[]`. |
| `deliver(session, message)` | Sends steering text through `session.write`. The adapter chooses the harness-specific framing (a newline, bracketed paste, ...). Reject with `UnsupportedCapabilityError` when `steerInput` is false. |
| `detectState?(output)` | Optional. Reads raw output and returns hints: `working`, `asking`, `idle`, `error`, `session` (a resume token). Pure, never throws, tolerates partial lines and binary. Hints are advisory: status the agent reports itself wins. |
| `resumeCommand?(task, ctx)` | Present exactly when `capabilities.resume`. `ctx.resumeToken` is the harness-native session id. |

### The environment contract

Every agent is started with these variables. `buildCommand` and `resumeCommand` must set them, and nothing (adapter extras or `ctx.baseEnv`) may override them. `buildCommandEnv(task, ctx, extra)` does this for you.

| Variable | Value |
| --- | --- |
| `CANTIERE_TASK` | The task id. |
| `CANTIERE_REPO` | Absolute path of the primary repository. The agent never modifies it. |
| `CANTIERE_WORKTREE` | Absolute path of the task worktree; also the process `cwd`. |
| `CANTIERE_REPORT` | Absolute path of the `cantiere` binary, which the agent runs to report status. |
| `CANTIERE_EVENTS` | Absolute path of the task's `events.jsonl`. Read-only by convention: the agent may read it and must not write it. |

`ctx.baseEnv` carries what the user's shell already has (for example credentials). Pass it through; never log it, and never write secrets into files from `prepareWorkspace`.

## Conformance

The suite checks the shape and `apiVersion`, `buildCommand` (valid command, contract env, deterministic, no input mutation), `prepareWorkspace` (dry run writes nothing, stays inside the worktree, idempotent, MCP servers present), `deliver` against a real process, `detectState` robustness and, for `resume`, `resumeCommand`. Checks for capabilities you do not declare are skipped (or, for `deliver`, must reject).

Run it from your adapter's own repo, with vitest:

```ts
import { adapterConformanceSuite } from "@cantiere/testing/vitest";
import { adapter } from "./index.js";

adapterConformanceSuite(adapter, {
  samples: { asking: "<real output where your harness asks a question>", working: "<real working output>" },
});
```

or from a shell against the built module (default export, or `--export <name>`; a function returning an adapter works too):

```sh
npx cantiere-adapter-conformance ./dist/index.js --export adapter
```

Exit status is 0 when conformant, 1 when a check fails, 2 on usage errors. Programmatically, `runAdapterConformance(adapter, options)` returns a report and never throws for a failing adapter, so any test runner can use it.

### The fake agent

`createFakeAdapter(script)` in `@cantiere/testing` is a complete reference adapter around a real process you can script, so runtime code can be tested without a vendor tool. A script is a list of steps: `emit` (a status line), `print`, `sleep`, `ask` (prints a question and blocks until it reads an answer on stdin), `echo-env`, `crash` (exit code, or a real signal) and `exit`. Output lines are JSON with `"fakeAgent": 1`. Read its source to see what a minimal adapter looks like.

## Mapping real tools

The interface is meant to cover these without change. These are notes from each tool's documentation at the time of writing, not implementations; concrete adapters are separate work (Claude Code, then Codex and a generic adapter).

| | Claude Code | Codex CLI | Cursor terminal agent (`cursor-agent`) |
| --- | --- | --- | --- |
| `headless` | `claude -p "<prompt>"` | `codex exec "<prompt>"` | `cursor-agent -p "<prompt>"` (usually with `--force`/`--trust` so it does not wait for confirmation) |
| `interactive` | `claude` (TUI) | `codex` (TUI) | `cursor-agent` (TUI) |
| `jsonOutput` | `--output-format json` or `stream-json` | `codex exec --json` (JSONL) | `--output-format json` or `stream-json` |
| `resume` | `--resume <session-id>` | `codex exec resume <id>` | `--resume <chat-id>` |
| `mcpConfig` | `.mcp.json` in the worktree, or `--mcp-config <file>` | `mcp_servers` in `config.toml`, per run with `-c mcp_servers.<name>...` | `.cursor/mcp.json` in the worktree (headless may need `--approve-mcps`) |
| `steerInput` | text into the TUI through the session host | same | same |

Where config can be a file, `prepareWorkspace` writes it; where it can be a flag or env var, `buildCommand` returns it. Both fit the interface. Headless prompts go in `argv`, interactive ones through `deliver` after start. Check the current CLI reference before relying on a flag, since these tools change quickly.

## Versioning and breaking changes

`apiVersion` is one integer, exported as `ADAPTER_API_VERSION`.

- **Breaking changes** bump it: removing or renaming a member, changing what a member must return or accept, making an optional member required, narrowing a type, adding a required capability or an environment variable an adapter must set. The runtime accepts only adapters with the exact version it implements and refuses others with a message naming both versions.
- **Compatible changes** keep it: a new optional member, a new optional `ctx` field, a new `StateHint` kind that readers may ignore, a new check in the conformance suite that does not fail an adapter correct under the same version.
- A breaking change ships with a migration note in the release and in this document. Adapters built for the previous version are refused until they are updated and pass the new suite; there is no overlap window.
- The conformance suite is versioned with the interface: a suite release declares which `apiVersion` it checks.
- Until 1.0 the project may batch breaking changes, but never makes one without bumping `apiVersion`.

## Out of scope here

The session runner, dispatch, status events beyond what the fake agent emits, and every concrete vendor adapter are separate issues. Adapters take no part in landing, cleanup or merging; those stay behind the runtime's gates.

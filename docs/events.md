# Events and the durable store

This is the stable contract for Cantiere's on-disk run state ([ADR 0002](adr/0002-durable-state-format.md)). It is run state, not project knowledge: decisions and memory belong in [Nocciolo](https://github.com/zanuka/nocciolo) (see [boundaries](boundaries.md)).

Formats are JSON and JSONL, language-neutral. The JSON Schemas are the contract, not the TypeScript types:

- [`schema/event.schema.json`](../schema/event.schema.json): the event envelope
- [`schema/task-snapshot.schema.json`](../schema/task-snapshot.schema.json): `task.json`
- [`schema/task.schema.json`](../schema/task.schema.json): the task definition inside both

Regenerate them with `pnpm schema`; a test fails if they drift from the code.

## Layout

Under `<repo>/.cantiere/` (git-ignored runtime state):

```
.cantiere/
  config.json              {"schemaVersion": 1}
  locks/                   repo.lock, task-<id>.lock (and short-lived .steal guards)
  tasks/<id>/
    events.jsonl           append-only event log: the source of truth
    task.json              snapshot: a cache derived from events, rebuildable
    log/                   raw agent output (never copied into events)
    events.torn            only if an interrupted append was cleaned up (see Crash behaviour)
```

`<id>` is a task id (13 lowercase Crockford base32 characters). The store rejects anything else, so an id can never escape the directory.

## Event envelope

One JSON object per line of `events.jsonl`:

```json
{"v":1,"ts":"2026-11-15T12:00:00.000Z","taskId":"01k3m9x2q7a4b","seq":2,"type":"task.transitioned","actor":"cantiere","data":{"to":"provisioning"}}
```

| Field    | Type                                  | Meaning                                                                  |
| -------- | ------------------------------------- | ------------------------------------------------------------------------ |
| `v`      | integer, >= 1                         | Envelope version. This document describes `1`.                           |
| `ts`     | ISO 8601 UTC date-time                | When the event was recorded.                                             |
| `taskId` | task id                               | The task this log belongs to; must match the directory.                  |
| `seq`    | integer, >= 1                         | Position in the task's log. Contiguous (`1, 2, 3, ...`) and increasing. |
| `type`   | non-empty string                      | Dotted name, for example `task.transitioned`.                            |
| `actor`  | `"cantiere"`, `"agent"` or `"human"`  | Who caused the event.                                                    |
| `data`   | object                                | Payload, shaped by `type`. May be `{}`.                                  |

The store assigns `v`, `ts`, `taskId` and `seq` under the task lock. Callers supply `type`, `actor` and `data`.

### Event types the runtime interprets

| Type                | `data`                                                     | Effect on the snapshot                                                                                                                       |
| ------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `task.created`      | `{ "task": <Task> }`                                       | Must be `seq` 1. Sets the task definition; state starts as `queued`.                                                                          |
| `task.provisioned`  | `{ "branch": string, "worktreePath": string }`             | Records the worktree. Only valid while the state is `provisioning`.                                                                           |
| `task.transitioned` | `{ "to": <state>, "reason"?: string, "approved"?: boolean }` | Moves the lifecycle state, checked by the [state machine](../packages/core/src/state.ts). `reason` and `approved` feed that table's guards. |

State is derived from events with the same transition table the supervisor uses ([ADR 0002](adr/0002-durable-state-format.md), `packages/core/src/state.ts`); there is no second definition. An illegal transition is rejected before it is written, so the log never contains one. Whether a task counts as provisioned is derived (it has a branch and worktree path), not asserted by the caller.

Agent-reported status (`working`, `blocked`, `needs-decision`, `done`) is recorded as a `task.transitioned` event with `actor: "agent"`, using the mapping in `REPORTED_STATUS_TO_STATE`.

### Git events (recorded, not interpreted by the state machine)

These use the same log and are preserved like any event type the state machine does not interpret:

| Type               | `data`                                                                                           | Written by                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `worktree.created` | `{ "branch", "worktreePath", "baseRef", "baseSha" }`                                             | `createWorktree`: the commit `baseRef` pointed at when the branch was cut.              |
| `task.landed`      | `{ "method": "merge" \| "squash" \| "rebase", "branchTip", "mergeCommit" }`                      | The land flow. `isLanded` reads it to recognise a squash merge, which git cannot see.   |

`createWorktree` takes the store's repo lock, so many tasks can start at once without contending on `.git`; it also retries when git itself reports a lock error. The predicates (`isDirty`, `hasCommitsNotInBase`, `isLanded`, `isAbandonedWithReason`) are conservative: only positive proof counts as landed, a missing worktree or deleted branch is never read as safe to remove, and commits on a detached HEAD count as unmerged work.

### Forward compatibility

A reader must never drop what it does not understand:

- **Unknown event types** are read, kept in the log, counted in `seq`, and ignored when deriving state.
- **Unknown envelope fields** are preserved when events are read.
- **A newer envelope version** (`v` greater than the reader's) is treated like an unknown type: preserved, counted, not interpreted. Fields `ts`, `taskId`, `seq`, `type`, `actor` and `data` keep their meaning in every version.
- The log is append-only: nothing rewrites or removes an existing line.

A store whose `config.json` has a newer `schemaVersion` than the running Cantiere is refused with an upgrade message rather than read partially.

## Snapshot (`task.json`)

```json
{
  "schemaVersion": 1,
  "task": { "...": "the Task, with branch/worktreePath once provisioned" },
  "state": "running",
  "seq": 4,
  "updatedAt": "2026-11-15T12:00:03.000Z",
  "stateSince": "2026-11-15T12:00:02.000Z"
}
```

`seq` and `updatedAt` are those of the last event folded in. The snapshot is a **cache**: it is rewritten after every append, and if it is missing, corrupt, behind or ahead of the log, readers fall back to the log and the next write (or a rebuild) repairs it. Rebuilding is deterministic: the same events always produce a byte-identical `task.json`. A future `cantiere reconcile` builds on this; reconcile itself is not part of the store.

## Concurrency and crash behaviour

Many processes write at once (CLI calls, per-task supervisors, agents reporting status). The store is safe under that:

- **Per-task lock** (`locks/task-<id>.lock`): every mutation of a task holds it. Under it the writer reads the last `seq`, validates the event against the state machine, appends one `O_APPEND` write of a whole line, then replaces the snapshot. Reading the tail is O(1) however long the log is.
- **Repo lock** (`locks/repo.lock`): taken by queue operations (picking and admitting tasks) via `withRepoLock`.
- **Lock files** are created atomically with their contents (private temp file, then `link`) and name the holder's pid. A lock whose holder pid on this host is dead is stale and is taken over; a lock held by a live process on this host is never taken over, however old. A lock from another host, whose pid cannot be checked, is stale once older than a minute. The takeover is itself serialized so two processes cannot steal a live lock from each other.
- **Snapshots** are written to a temp file in the same directory, fsynced, then renamed over `task.json`. A reader or a crash sees the old file or the complete new one, never a partial one. Temp files left by dead writers are swept.
- **Events** are fsynced after each append, so an acknowledged event survives power loss, not just a killed process. (Tests may turn this off.)
- **A killed writer** (`kill -9`) leaves at worst a stale lock (recovered by the next writer), a stray temp file (swept), a snapshot one event behind the log (healed on the next read or write), or, only if the disk write itself was cut short, an unterminated last line. That line was never acknowledged: readers ignore it, and the next append moves it to `events.torn` and cuts the log back to the last whole line. A corrupt line *in the middle* of the log is never repaired silently; reading fails with the line number so it can be inspected.

Limits and failure messages are actionable by design: a lock timeout names the holder; a corrupt log names the line or `seq`.

## What is not logged

Events record **metadata and outcomes**: which task, which transition, who did it, branch names, paths, reasons, how a change was verified. They do not carry:

- raw agent output (it goes to `tasks/<id>/log/`),
- page bodies, file contents or diffs,
- secrets, tokens or credentials.

Each event line is limited to 64 KiB; the store rejects larger events and tells the caller to write bulk output to `log/` and reference it. Do not put credentials in `data` or in a task's `prompt` (the prompt is recorded in `task.created`). `.cantiere/` is git-ignored and never committed.

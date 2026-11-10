# 0006: Strumentario server topology

Status: Accepted

## Context

Strumentario is the family's concurrency-safe MCP tool server and owns tools; Cantiere only decides how agents reach it (see [boundaries](../boundaries.md)). This ADR matches strumentario as it exists on `main`, citing its issues rather than defining interfaces:

- stdio transport, selected by `MCP_TRANSPORT=stdio` or `serve --stdio`, with many agent-spawned processes able to share one data directory ([strumentario #13](https://github.com/zanuka/strumentario/issues/13)). Over stdio the agent name comes from `STRUMENTARIO_AGENT`.
- an append-only change journal that records the agent identity on every `mutate` outcome ([strumentario #10](https://github.com/zanuka/strumentario/issues/10)).
- separate read-only and read-write bearer tokens, `MCP_READ_TOKEN` and `MCP_WRITE_TOKEN`, for the HTTP transport; not applied over stdio ([strumentario #14](https://github.com/zanuka/strumentario/issues/14)).

## Options considered

1. **One shared strumentario server for all tasks (default).** Concurrency-safe, and every change is attributed through the change journal.
2. **A per-task stdio server on a worktree-local data directory.** Edits stay in the task's worktree, so they can pass through the landing gate.
3. **Per-task stdio servers always.** Loses the shared store and the single journal.

## Decision

Use a shared strumentario server by default. Agents are given the read-only token where they only need to read, and the write token otherwise, and their calls are attributed through the change journal. A task whose deliverable is content that must pass through the landing gate instead gets a per-task stdio server pointed at a worktree-local data directory (strumentario #13), so the content is part of the task's diff and is reviewed and landed like code.

## Consequences

- Shared-store edits are not part of any task's branch; they are attributed by journal entry, not gated by `land`.
- Tokens apply only to the shared HTTP server; a stdio server has no token scopes, so isolation comes from its worktree-local data directory.
- Cantiere passes configuration (transport, data directory, agent name, token) and does not reimplement strumentario behavior.

## Reopen when

Strumentario changes its transport, journal or token model in a way that breaks these assumptions, or a class of tasks needs shared-store edits to be gated as well. Re-check against strumentario `main` before relying on any detail here.

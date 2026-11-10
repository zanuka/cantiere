# 0002: Durable state format

Status: Accepted

## Context

Principle 6: a restart is a non-event; Cantiere reconciles from on-disk records, never from memory. Principle 7: every landed change records who did it, for which task, and how it was verified. The state format must be inspectable, crash-tolerant and usable by many processes at once.

## Options considered

1. **Plain files under `.cantiere/`:** a per-task append-only `events.jsonl` plus a `task.json` snapshot.
2. **SQLite as the source of truth.** Strong querying, but opaque to simple tools, a native dependency, and a single-file contention point.
3. **A long-lived daemon holding state in memory.** Conflicts with local-first and restart-as-non-event.

## Decision

Per task, under `.cantiere/`: an append-only `events.jsonl` (the record of what happened) and a `task.json` snapshot (the current derived state, rebuildable from events). Formats are JSON and JSONL with JSON Schema. A derived SQLite index is revisited only at the Fleet stage, and then only as a rebuildable cache, never the source of truth.

## Consequences

- State is greppable, diffable and recoverable with ordinary tools.
- Appends must be written so concurrent writers never interleave or truncate lines.
- Listing many tasks scans directories; acceptable until Fleet scale.
- `.cantiere/` is git-ignored runtime state.

## Reopen when

Listing or querying tasks becomes a measured bottleneck at Fleet scale (30 to 100+ tasks), or cross-task queries are needed that file scans cannot serve. The expected change is a derived, rebuildable SQLite index.

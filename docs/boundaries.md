# Boundaries

Cantiere is the runtime: it runs coding agents in parallel in isolated git worktrees, supervised from durable on-disk state. Anything else belongs to a sibling project. Keep the seams explicit and integrate through files, CLIs and adapters.

## Needs X: use Y

| Cantiere needs... | Use | Owner | Notes |
| --- | --- | --- | --- |
| Durable project memory and decisions | [Nocciolo](https://github.com/zanuka/nocciolo) | Memory | Cantiere does not store project knowledge; it records task state only. |
| Concurrency-safe MCP tools many agents call at once | [Strumentario](https://github.com/zanuka/strumentario) | Tools | See [ADR 0006](adr/0006-strumentario-server-topology.md). |
| Declarative factory blueprints, stages and stop conditions | [Maglio](https://github.com/zanuka/maglio) | Blueprints | Cantiere runs the work; Maglio defines the plan. |
| Dependency advisories, minimal patches, verified PRs | [Riparo](https://github.com/zanuka/riparo) | Dependency repair | Riparo scans are just tasks Cantiere can schedule. |

## What Cantiere does not do

- It is not a memory system, tool server, factory scaffolder or dependency repair tool.
- It does not require a hosted control plane.
- It never pushes from `land` ([ADR 0005](adr/0005-land-semantics.md)).

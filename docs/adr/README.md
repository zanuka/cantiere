# Architecture Decision Records

Decisions that are expensive to reverse, with their reasoning and the trigger that would reopen each. Every ADR lists the options considered, the decision, its consequences and a reopen trigger.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-toolchain.md) | TypeScript on Node 22, pnpm workspace, vitest, zod | Accepted |
| [0002](0002-durable-state-format.md) | `.cantiere/` files: `events.jsonl` plus `task.json` | Accepted |
| [0003](0003-supervision-model.md) | Daemonless Squad: per-task supervisor wrapper plus idempotent drain | Accepted |
| [0004](0004-session-host.md) | Runner interface: tmux for interactive, detached process for headless | Accepted |
| [0005](0005-land-semantics.md) | `land` is a local merge after approval and never pushes | Accepted |
| [0006](0006-strumentario-server-topology.md) | Shared strumentario server by default, per-task stdio for gated content | Accepted |

See also [boundaries](../boundaries.md) for what Cantiere does not do.

# Cantiere

**The shipyard where your agent crews work.**

A local-first, CLI-first orchestrator for running coding agents in parallel: first several, then 10+, then 30 to 100+, each in its own isolated workspace, all supervised from the terminal.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Status: Early](https://img.shields.io/badge/Status-Early%20%2F%20Public-orange)]()

---

## The Problem

One coding agent in an IDE is a pair programmer. Ten agents is a team, and most tooling still assumes a single chat window and a single human watching it.

Engineers who try to scale past a handful of agents hit the same walls:

- **Collisions.** Agents edit the same checkout, step on each other's branches, and leave half-finished work behind.
- **Babysitting.** Someone has to notice the stuck agent, answer its question, and restart the one that crashed. That someone becomes the bottleneck.
- **Lost state.** A terminal closes or a laptop sleeps, and nobody remembers which agent was doing what or what it already finished.
- **No proof.** Work lands without a clear record of which agent did it, why, and how it was verified.
- **IDE gravity.** Orchestration tools are often editor plugins or hosted dashboards, so the work never leaves the IDE or the vendor's cloud.

## The Vision

Cantiere is a **shipyard**: one site, many crews, one foreman.

It is a CLI that dispatches work to coding agents, gives every agent its own isolated workspace, supervises them from durable state, and brings finished work back through explicit gates. It is built to stay boring at any scale, from 3 agents to 100+.

- **CLI-first.** Everything is a command, a file, or a log line. No IDE required, and no hosted control plane.
- **Isolation by default.** Every task gets its own git worktree and branch. The primary checkout is never touched by an agent.
- **Durable state.** Tasks, assignments, and status live on disk. A restart is a non-event: Cantiere reconciles from its records, not from anyone's memory.
- **Supervision, not babysitting.** Agents report sparse, structured events (working, blocked, needs a decision, done). Cantiere surfaces only what needs a human.
- **Harness-agnostic.** Claude Code, Codex, and other terminal agents plug in through small adapters. Cantiere never assumes one vendor.
- **Explicit gates.** Merging, destructive actions, and anything irreversible stay behind human approval unless a project opts in.

## Why Cantiere instead of just an agent

Cantiere runs agents; it does not replace them. Claude Code, Codex and other terminal agents plug in through adapters (planned), and the agent still does the coding. The real comparison is opening agent sessions by hand versus letting Cantiere dispatch and supervise them.

**When plain agent use is enough.** With one or two agents and a human watching the chat, use the agent directly. Cantiere adds nothing there.

**What Cantiere adds past a handful of agents**, mapped to the walls in [The Problem](#the-problem):

- **Collisions.** A worktree and branch per task; the primary checkout is never touched.
- **Babysitting.** Sparse, structured statuses (working, blocked, needs a decision, done) that surface only what needs a human. Supervision is planned.
- **Lost state.** Tasks and history live on disk, so a restart is a non-event. The task model and store format exist; reconciliation is planned. See [ADR 0002](docs/adr/0002-durable-state-format.md).
- **No proof.** Every landed change records which agent did it, for which task, and how it was verified. Landing is planned.
- **Accidents.** In the lifecycle state machine that exists today, only `landed` and `abandoned` tasks permit worktree removal, and landing or abandoning needs approval. Irreversible steps stay behind a gate.
- **IDE gravity and lock-in.** A local CLI, any vendor's agents, your own machine and credentials.

**What a day looks like** (commands are the [sketch](#sketch-of-the-cli), not yet implemented): `dispatch` a few tasks, watch `crew`, `steer` a stuck one, `land` an approved one, `cleanup` after. Later, Maglio factories can queue tasks headless, calling Strumentario tools and reading Nocciolo memory; see [docs/boundaries.md](docs/boundaries.md).

### Relationship to Firstmate

Firstmate is prior art and the first dogfood consumer of Cantiere's ideas, not a dependency. Cantiere shares its mechanics: isolated worktrees, durable records, sparse statuses, refusing to discard unlanded work, approval gates and vendor-neutral agents.

The difference is who decides. Firstmate is an AI supervisor driven by instructions: it turns requests into briefs, makes judgment calls and reports in plain language. Cantiere is a deterministic CLI with no model in its control loop. A person, a script or a Maglio factory is the foreman, and Cantiere enforces the rules. Cantiere does not promise any Firstmate integration.

## How Cantiere Scales

Cantiere grows with the goal rather than starting as a 100-agent platform:

| Stage | Agents | What Cantiere adds |
|-------|--------|--------------------|
| **Squad** | several | Isolated worktrees, a task queue, a status view in the terminal |
| **Crew** | 10+ | Durable supervision, stuck-agent detection, steering messages, capacity limits per repo and machine |
| **Fleet** | 30 to 100+ | Scheduling across machines, quota-aware model routing, batched tool calls, fleet-level evidence and reporting |

Each stage must work reliably before the next one is built.

## Sketch of the CLI

The exact commands will evolve; this is the shape:

```bash
cantiere init                       # set up the yard for this repo or workspace
cantiere dispatch "fix flaky test"  # queue a task; an agent picks it up in its own worktree
cantiere crew                       # live view: who is working on what, who is stuck
cantiere steer <task> "use the v2 API instead"
cantiere land <task>                # bring finished work back through its gate
cantiere cleanup <task>             # remove a finished worktree, never unlanded work
```

## Development

Requires Node 22 LTS and pnpm 9+. See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test
pnpm cantiere --help
```

## The Family

Cantiere is one part of a set of local-first tools for AI-first engineering:

| Layer | Project | Role |
|-------|---------|------|
| Knowledge | [Nocciolo](https://github.com/zanuka/nocciolo) | The kernel: durable project memory and decisions |
| Instruments | [Strumentario](https://github.com/zanuka/strumentario) | The tool tray: concurrency-safe MCP tools many agents call at once, with evals and a change journal |
| Production | [Maglio](https://github.com/zanuka/maglio) | The forge hammer: declarative factory blueprints, stages, and stop conditions |
| Maintenance | [Riparo](https://github.com/zanuka/riparo) | The repair shop: dependency advisories, minimal patches, verified PRs |
| Orchestration | **Cantiere** | The shipyard: runs the crews that use all of the above |

How they fit together:

- **Maglio defines the work, Cantiere runs it.** A Maglio blueprint describes stages, profiles, and stop conditions; Cantiere executes those stages across many agents in parallel.
- **Strumentario is what the crews call.** Agents reach shared content and tools through Strumentario's MCP server and CLI. Its change journal tells Cantiere which agent changed what.
- **Nocciolo is what the crews remember.** Agents start with durable project knowledge instead of re-deriving it every session.
- **Riparo is a job Cantiere can schedule.** Dependency scans and patches become ordinary tasks in the queue.

Each project keeps its own boundary. Maglio is not a multi-agent runtime and Strumentario is not an agent runtime; Cantiere is the runtime, and it does not try to be a memory system, a tool server, or a factory scaffolder.

## Core Principles

- **Local control.** Runs on your machines with your agents and your credentials. Nothing requires a hosted service.
- **Never lose work.** Cleanup refuses to remove anything that has not landed. Isolation and durable records come before speed.
- **Humans decide, agents execute.** Agents never talk to each other's humans directly; decisions route through one supervisor and reach a person only when they need one.
- **Quiet by default.** Routine progress stays in the logs. The human sees outcomes, blockers, and decisions.
- **Evidence over trust.** Every landed change has a record of which agent did it, against which task, and how it was verified.
- **Scale by stages.** Make several agents reliable before claiming 10, and 10 before claiming 100.

## Status

Cantiere is at the very beginning: the workspace skeleton, the core task model with its lifecycle state machine, and a `cantiere` CLI whose commands are planned stubs are in place. We are building in the open, starting with the Squad stage.

## Contributing

Ideas, design feedback, and issues are welcome. Small focused PRs on harness adapters, supervision, and docs are the most useful contributions; see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT

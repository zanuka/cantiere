# AGENTS.md: Cantiere

This file is the source of truth for any AI agent working on Cantiere. `CLAUDE.md` imports it.

## Project Identity

Cantiere is a local-first, CLI-first **runtime** for running coding agents in parallel, each in its own isolated git worktree, supervised from durable on-disk state. It scales by stages: Squad (several agents), Crew (10+), Fleet (30 to 100+). Each stage must work reliably before the next one is built.

## Boundary

Cantiere is the runtime. It is **not**:

- a memory system (that is Nocciolo),
- a tool server (that is Strumentario),
- a factory scaffolder (that is Maglio),
- a dependency repair tool (that is Riparo; its scans are just tasks Cantiere can schedule).

Do not absorb those concerns into this repo. Keep the seams explicit and integrate through files, CLIs and adapters.

## The Family

| Layer         | Project                                                | Role                                                       |
| ------------- | ------------------------------------------------------ | ---------------------------------------------------------- |
| Knowledge     | [Nocciolo](https://github.com/zanuka/nocciolo)         | durable project memory and decisions                       |
| Instruments   | [Strumentario](https://github.com/zanuka/strumentario) | concurrency-safe MCP tools many agents call at once        |
| Production    | [Maglio](https://github.com/zanuka/maglio)             | declarative factory blueprints, stages and stop conditions |
| Maintenance   | [Riparo](https://github.com/zanuka/riparo)             | dependency advisories, minimal patches, verified PRs       |
| Orchestration | **Cantiere**                                           | the shipyard that runs the crews using all of the above    |

## Core Principles (non-negotiable)

1. **Never lose work.** Cleanup refuses to remove anything that has not landed. Isolation and durable records come before speed.
2. **Quiet by default.** Routine progress stays in logs. Surface outcomes, blockers and decisions only.
3. **Explicit gates.** Merging, destructive actions and anything irreversible stay behind human approval unless a project opts in.
4. **Local control.** No hosted control plane is required. Runs on the user's machine with their agents and credentials.
5. **Isolation by default.** Every task gets its own worktree and branch; an agent never touches the primary checkout.
6. **Durable state.** A restart is a non-event: reconcile from on-disk records, never from memory.
7. **Evidence over trust.** Every landed change records which agent did it, for which task, and how it was verified.

## Architecture

TypeScript on Node 22 LTS, pnpm workspace, vitest, zod. On-disk formats are language-neutral (JSON / JSONL with JSON Schema) so a later Fleet daemon could be rewritten if needed.

- `packages/core`: task model, store, git. **No CLI dependencies**, so a later Fleet daemon can reuse it.
- `packages/cli`: the `cantiere` binary. Depends on core; core never depends on cli.
- `packages/adapters`: harness adapters (Claude Code, Codex, ...). Never assume one vendor.
- `packages/testing`: fake agent and fixtures.

## Coding Standards

- TypeScript strict (`tsconfig.base.json`), no `any` without a documented reason.
- Small, composable functions and clear module boundaries.
- Mutating commands support `--dry-run`.
- Read commands support `--json`.
- Errors are actionable: say what went wrong and what to do next. No silent failures.
- Never commit secrets; `.env.example` holds placeholders only. Runtime state lives in `.cantiere/` and is git-ignored.

## Workflow

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm cantiere --help
```

Commits and PRs follow Conventional Commits (`feat(core): ...`, `chore(repo): ...`).

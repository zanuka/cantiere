# 0001: Toolchain

Status: Accepted

## Context

Cantiere must stay "boring at any scale": Squad (several agents), Crew (10+), Fleet (30 to 100+). The language and tooling are costly to change once the core exists. The rest of the family (Nocciolo, Strumentario, Maglio, Riparo) already uses TypeScript, so shared conventions and adapters are cheap.

## Options considered

1. **TypeScript on Node 22 LTS, pnpm workspace, vitest, zod.** Matches the family; fast iteration; zod exports JSON Schema for the on-disk formats.
2. **Go single binary.** Easy distribution and strong concurrency story, but a second toolchain for the family, no code sharing with sibling projects, and slower iteration while the model is still changing.

## Decision

TypeScript on Node 22 LTS in a pnpm workspace, tested with vitest, with zod schemas that export JSON Schema. On-disk formats (JSON and JSONL, see [0002](0002-durable-state-format.md)) stay language-neutral so a Fleet-stage daemon could be rewritten in Go or Rust without migrating data.

## Consequences

- Users need Node 22 or later.
- `packages/core` has no CLI dependencies, so a later daemon can reuse or replace it.
- Schemas are the contract, not the TypeScript types, so other languages can validate the same files.

## Reopen when

Measured load at Crew or Fleet scale (for example supervision latency or memory with 30 to 100+ concurrent tasks) cannot be met by the Node implementation after reasonable optimization. The first response is rewriting the daemon only, not the formats.

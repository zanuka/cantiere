# 0005: What `land` does

Status: Accepted

## Context

Principle 3: merging and anything irreversible stay behind human approval. Principle 1: never lose work. Principle 7: record how each change was verified. Principle 4: no hosted dependency by default.

## Options considered

1. **Local merge into the base branch after approval; never push.**
2. **Open a PR through `gh` by default.** Needs credentials and network, and assumes GitHub.
3. **Merge and push automatically.** Violates the explicit-gate principle.

## Decision

`land` performs a local merge into the base branch after approval and never pushes. Gate commands (tests, lint and similar) are configurable and their results are recorded as evidence. A PR mode via `gh` is a later opt-in, not the default.

## Consequences

- Publishing remains a separate human step.
- Cleanup refuses to remove anything that has not landed.
- Verification results are stored with the landing record.

## Reopen when

Projects need a PR-based flow routinely enough that the local-merge default gets in the way. That arrives as an opt-in mode; the default stays unchanged unless users show it is wrong.

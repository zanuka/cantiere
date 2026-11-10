# 0004: Session host

Status: Accepted

## Context

Agents are either interactive (a terminal UI a human may want to look into) or headless (run to completion). Cantiere needs a way to host both, support `attach`, and avoid fragile native dependencies.

## Options considered

1. **A runner interface with two implementations:** tmux for interactive harnesses, a detached process with log capture for headless ones.
2. **Native pty modules (for example node-pty).** Self-contained but native builds, platform breakage and more code to own.
3. **tmux for everything.** Simple, but unnecessary for headless runs and forces tmux on all of them.

## Decision

A runner interface. tmux is the default host for interactive harnesses, so `attach` comes for free. Headless harnesses run as a detached process with log capture. No native pty modules. tmux is a documented prerequisite on macOS and Linux.

## Consequences

- Users need tmux installed for interactive agents.
- Adding another host means implementing the runner interface, not changing callers.
- Windows is not covered by this decision.

## Reopen when

A supported platform cannot use tmux (for example native Windows), or tmux limits become a measured problem at Crew or Fleet scale. A new runner then implements the interface.

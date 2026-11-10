# 0003: Supervision model

Status: Accepted

## Context

Agents run for long periods and must survive the CLI exiting, and Cantiere must survive restarts (principle 6). Principle 4 requires that no hosted control plane or mandatory service is needed.

## Options considered

1. **Daemonless: one detached supervisor wrapper per task plus an idempotent drain that any command can run.**
2. **Always-on daemon from the start.** Simpler for some features but a mandatory service, a single point of failure and extra install burden at Squad scale.
3. **Cron or launchd polling only.** No live supervision; slow reaction to exits and blockers.

## Decision

In the Squad stage there is no daemon. Each task gets one detached supervisor wrapper that launches the agent, records exit and events, and writes durable state. Any `cantiere` command also runs an idempotent drain that reconciles on-disk records (for example noting a task whose wrapper has exited). An optional long-running supervisor arrives in the Crew stage.

## Consequences

- Nothing to install, start or keep alive; a restart needs no recovery step beyond the drain.
- The drain must be safe to run concurrently and repeatedly.
- Reaction time depends on the wrapper plus whenever a command runs, until the Crew-stage supervisor exists.

## Reopen when

Crew-stage work (10+ tasks) needs capabilities the wrapper-plus-drain cannot provide, such as scheduling, concurrency limits or timely notifications. The optional supervisor then ships as an addition, still reading the same on-disk state.

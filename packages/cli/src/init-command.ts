import path from "node:path";
import { parseArgs } from "node:util";
import {
  applyInit,
  InitError,
  type InitPlan,
  planInit,
  SESSION_HOSTS,
  type SessionHost,
} from "@cantiere/core";
import type { Io, RunContext } from "./cli.js";

export const INIT_HELP = [
  "Usage: cantiere init [options]",
  "",
  "Set up the yard for this repository: write .cantiere/config.json, create the runtime",
  "directories and keep them out of git via .git/info/exclude. Re-running changes nothing.",
  "",
  "Options:",
  "  --harness <name>       agent harness binary (default: claude)",
  "  --session-host <host>  tmux (default) or process",
  "  --max-agents <n>       maximum concurrent agents (default: 4)",
  "  --base-branch <name>   branch tasks start from (default: detected)",
  "  --dry-run              show what would be written and write nothing",
  "  -y, --yes              do not ask for confirmation",
  "  --json                 print the result as JSON (implies --yes)",
  "  -h, --help             show this help",
  "",
].join("\n");

class UsageError extends Error {}

function parseMaxAgents(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new UsageError(`--max-agents must be a positive whole number, got "${value}".`);
  }
  return Number(value);
}

function parseSessionHost(value: string): SessionHost {
  if (!(SESSION_HOSTS as readonly string[]).includes(value)) {
    throw new UsageError(
      `--session-host must be one of ${SESSION_HOSTS.join(", ")}, got "${value}".`,
    );
  }
  return value as SessionHost;
}

function relativeTo(root: string, target: string): string {
  const rel = path.relative(root, target);
  return rel.startsWith("..") ? target : rel;
}

function renderPlan(plan: InitPlan, dryRun: boolean): string {
  const lines = [`cantiere init: ${plan.root}`, "", "Preflight:"];
  for (const check of plan.preflight) {
    lines.push(
      check.ok
        ? `  ok       ${check.name}${check.path && check.path !== check.name ? ` (${check.path})` : ""}`
        : `  MISSING  ${check.name}: ${check.fix}`,
    );
  }
  for (const warning of plan.warnings) lines.push("", `Warning: ${warning}`);
  lines.push("");
  if (plan.writes.length === 0) {
    lines.push("Nothing to do: the yard is already set up. No files were changed.");
  } else {
    lines.push(dryRun ? "Planned writes (dry run, nothing written):" : "Writes:");
    for (const write of plan.writes) {
      lines.push(
        `  ${write.kind.padEnd(13)} ${relativeTo(plan.root, write.path)}  (${write.detail})`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/** `cantiere init`. Returns the process exit code. */
export async function runInit(argv: readonly string[], io: Io, ctx: RunContext): Promise<number> {
  let values: ReturnType<typeof parse>["values"];
  try {
    values = parse(argv).values;
  } catch (error) {
    io.err(`${(error as Error).message}\nRun \`cantiere init --help\` for usage.\n`);
    return 2;
  }
  if (values.help) {
    io.out(INIT_HELP);
    return 0;
  }

  const json = values.json === true;
  const dryRun = values["dry-run"] === true;
  try {
    const plan = await planInit({
      cwd: ctx.cwd,
      env: ctx.env,
      ...(values.harness === undefined ? {} : { harness: values.harness }),
      ...(values["base-branch"] === undefined ? {} : { baseBranch: values["base-branch"] }),
      ...(values["session-host"] === undefined
        ? {}
        : { sessionHost: parseSessionHost(values["session-host"]) }),
      ...(values["max-agents"] === undefined
        ? {}
        : { maxConcurrentAgents: parseMaxAgents(values["max-agents"]) }),
    });
    const preflightOk = plan.preflight.every((check) => check.ok);

    const report = (written: boolean) => {
      const changed = written && plan.writes.length > 0;
      if (json) {
        io.out(
          `${JSON.stringify(
            {
              ok: preflightOk,
              dryRun,
              changed,
              root: plan.root,
              config: plan.config,
              configPath: plan.configPath,
              configStatus: plan.configStatus,
              plannedWrites: plan.writes,
              preflight: plan.preflight,
              warnings: plan.warnings,
            },
            null,
            2,
          )}\n`,
        );
      } else {
        io.out(renderPlan(plan, dryRun));
        if (changed) io.out('\nDone. Next: cantiere dispatch "<task>"\n');
      }
    };

    if (dryRun || !preflightOk) {
      report(false);
      if (!preflightOk && !json)
        io.err(
          "Preflight failed, nothing was written. Fix the items marked MISSING and run `cantiere init` again.\n",
        );
      return preflightOk ? 0 : 1;
    }
    if (plan.writes.length > 0 && !json && values.yes !== true && io.confirm) {
      io.out(
        renderPlan(plan, true).replace("(dry run, nothing written)", "(awaiting confirmation)"),
      );
      if (!(await io.confirm("Proceed?"))) {
        io.out("Aborted; nothing was written.\n");
        return 1;
      }
      await applyInit(plan);
      io.out('\nDone. Next: cantiere dispatch "<task>"\n');
      return 0;
    }
    await applyInit(plan);
    report(true);
    return 0;
  } catch (error) {
    if (error instanceof InitError || error instanceof UsageError) {
      if (json) io.out(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
      else io.err(`${error.message}\n`);
      return error instanceof UsageError ? 2 : 1;
    }
    throw error;
  }
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    options: {
      harness: { type: "string" },
      "session-host": { type: "string" },
      "max-agents": { type: "string" },
      "base-branch": { type: "string" },
      "dry-run": { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
}

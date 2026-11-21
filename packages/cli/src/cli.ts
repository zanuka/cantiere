import { createRequire } from "node:module";
import { PLANNED_COMMANDS } from "./commands.js";
import { runInit } from "./init-command.js";

export interface Io {
  out(text: string): void;
  err(text: string): void;
  /** Asks a yes/no question. Absent when there is no terminal to ask on. */
  confirm?(question: string): Promise<boolean>;
}

/** Where a command runs and what it can see; injected so tests never touch the real process. */
export interface RunContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

const require = createRequire(import.meta.url);

export function version(): string {
  const pkg = require("../package.json") as { version: string };
  return pkg.version;
}

export function helpText(): string {
  const width = Math.max(...PLANNED_COMMANDS.map((c) => c.usage.length));
  const rows = PLANNED_COMMANDS.map(
    (c) => `  ${c.usage.padEnd(width)}  ${c.summary}${c.implemented ? "" : " (planned)"}`,
  ).join("\n");
  return [
    "cantiere: the shipyard where your agent crews work",
    "",
    "Usage: cantiere <command> [options]",
    "",
    "Commands (`init` is available; the rest are planned stubs):",
    rows,
    "",
    "Options:",
    "  -h, --help     show this help",
    "  -v, --version  print the version",
    "",
  ].join("\n");
}

/** Runs the CLI and returns the process exit code. */
export async function run(
  argv: readonly string[],
  io: Io,
  ctx: RunContext = { cwd: process.cwd(), env: process.env },
): Promise<number> {
  const [first] = argv;

  if (first === undefined || first === "-h" || first === "--help") {
    io.out(helpText());
    return 0;
  }
  if (first === "-v" || first === "--version") {
    io.out(`${version()}\n`);
    return 0;
  }

  if (first === "init") return runInit(argv.slice(1), io, ctx);

  const command = PLANNED_COMMANDS.find((c) => c.name === first);
  if (command) {
    io.err(
      `cantiere ${command.name} is planned but not implemented yet.\n` +
        "Run `cantiere --help` to see the command sketch, or follow progress at " +
        "https://github.com/zanuka/cantiere/issues\n",
    );
    return 1;
  }

  io.err(`Unknown command: ${first}\nRun \`cantiere --help\` to list available commands.\n`);
  return 2;
}

#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { run } from "./cli.js";

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

process.exitCode = await run(process.argv.slice(2), {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  // Only ask when a person is there to answer; piped runs proceed like --yes.
  ...(process.stdin.isTTY && process.stderr.isTTY ? { confirm } : {}),
});

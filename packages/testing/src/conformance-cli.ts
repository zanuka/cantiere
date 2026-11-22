#!/usr/bin/env node
import { runConformanceCommand } from "./conformance-command.js";

process.exitCode = await runConformanceCommand(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});

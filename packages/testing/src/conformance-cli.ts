#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { HarnessAdapter } from "@cantiere/adapters";
import { formatConformanceReport, runAdapterConformance } from "./conformance.js";

const USAGE = `Usage: cantiere-adapter-conformance <module> [--export <name>]

Runs the Cantiere adapter conformance suite against the adapter exported by <module>
(a built JavaScript file or package name). The adapter is the default export, or the
named export given with --export. Exits 0 when conformant, 1 when a check fails, 2 on usage errors.`;

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    process.stdout.write(`${USAGE}\n`);
    return args.length === 0 ? 2 : 0;
  }
  const exportFlag = args.indexOf("--export");
  const exportName = exportFlag >= 0 ? args[exportFlag + 1] : "default";
  const target = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--export");
  if (!target || !exportName) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const specifier =
    target.startsWith(".") || path.isAbsolute(target)
      ? pathToFileURL(path.resolve(target)).href
      : target;
  let mod: Record<string, unknown>;
  try {
    mod = (await import(specifier)) as Record<string, unknown>;
  } catch (e) {
    process.stderr.write(
      `Cannot load ${target}: ${e instanceof Error ? e.message : String(e)}\nBuild your adapter first and pass the compiled .js file.\n`,
    );
    return 2;
  }
  let adapter = mod[exportName];
  if (typeof adapter === "function") adapter = (adapter as () => unknown)();
  if (typeof adapter !== "object" || adapter === null) {
    process.stderr.write(
      `${target} has no export "${exportName}" holding an adapter (or a function returning one).\n`,
    );
    return 2;
  }
  const report = await runAdapterConformance(adapter as HarnessAdapter);
  process.stdout.write(`${formatConformanceReport(report)}\n`);
  return report.passed ? 0 : 1;
}

process.exitCode = await main(process.argv);

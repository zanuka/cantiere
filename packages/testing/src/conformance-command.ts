import path from "node:path";
import { pathToFileURL } from "node:url";
import type { HarnessAdapter } from "@cantiere/adapters";
import { formatConformanceReport, runAdapterConformance } from "./conformance.js";

const USAGE = `Usage: cantiere-adapter-conformance <file> [--export <name>]

Runs the Cantiere adapter conformance suite against the adapter exported by <file>
(a built JavaScript file, resolved from the current directory). The adapter is the default
export, or the named export given with --export. Exits 0 when conformant, 1 when a check fails,
2 on usage errors.`;

export interface ConformanceCommandIo {
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** Runs the `cantiere-adapter-conformance` command and returns its exit code. */
export async function runConformanceCommand(
  args: string[],
  io: ConformanceCommandIo,
): Promise<number> {
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    io.stdout(`${USAGE}\n`);
    return args.length === 0 ? 2 : 0;
  }
  const exportFlag = args.indexOf("--export");
  const exportName = exportFlag >= 0 ? args[exportFlag + 1] : "default";
  const target = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--export");
  if (!target || !exportName) {
    io.stderr(`${USAGE}\n`);
    return 2;
  }
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(path.resolve(io.cwd, target)).href)) as Record<
      string,
      unknown
    >;
  } catch (e) {
    io.stderr(
      `Cannot load ${target}: ${e instanceof Error ? e.message : String(e)}\nBuild your adapter first and pass the compiled .js file.\n`,
    );
    return 2;
  }
  let adapter = mod[exportName];
  if (typeof adapter === "function") adapter = (adapter as () => unknown)();
  if (typeof adapter !== "object" || adapter === null) {
    io.stderr(
      `${target} has no export "${exportName}" holding an adapter (or a function returning one).\n`,
    );
    return 2;
  }
  const report = await runAdapterConformance(adapter as HarnessAdapter);
  io.stdout(`${formatConformanceReport(report)}\n`);
  return report.passed ? 0 : 1;
}

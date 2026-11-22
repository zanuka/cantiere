import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runConformanceCommand } from "./conformance-command.js";

const fakeAdapterUrl = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-adapter.ts"),
).href;

let dir: string;

async function run(...args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await runConformanceCommand(args, {
    cwd: dir,
    stdout: (t) => {
      stdout += t;
    },
    stderr: (t) => {
      stderr += t;
    },
  });
  return { code, stdout, stderr };
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cantiere-conformance-cli-"));
  await mkdir(path.join(dir, "dist"));
  await writeFile(
    path.join(dir, "dist", "index.mjs"),
    [
      `import { createFakeAdapter } from ${JSON.stringify(fakeAdapterUrl)};`,
      "export default createFakeAdapter();",
      "export const makeAdapter = () => createFakeAdapter();",
      "export const broken = { ...createFakeAdapter(), apiVersion: 7 };",
      "export const notAnAdapter = 42;",
    ].join("\n"),
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("cantiere-adapter-conformance", () => {
  it("resolves a bare relative path from the working directory and passes", async () => {
    const { code, stdout } = await run("dist/index.mjs");
    expect(stdout).toContain("Conformant.");
    expect(code).toBe(0);
  });

  it("calls a factory named with --export", async () => {
    const { code } = await run("--export", "makeAdapter", "./dist/index.mjs");
    expect(code).toBe(0);
  });

  it("exits 1 when the adapter fails a check", async () => {
    const { code, stdout } = await run("dist/index.mjs", "--export", "broken");
    expect(stdout).not.toContain("Conformant.");
    expect(code).toBe(1);
  });

  it("exits 2 when the export is not an adapter", async () => {
    const { code, stderr } = await run("dist/index.mjs", "--export", "notAnAdapter");
    expect(stderr).toContain('no export "notAnAdapter"');
    expect(code).toBe(2);
  });

  it("exits 2 when the file cannot be loaded", async () => {
    const { code, stderr } = await run("dist/missing.js");
    expect(stderr).toContain("Cannot load dist/missing.js");
    expect(code).toBe(2);
  });

  it("exits 2 on missing arguments", async () => {
    expect((await run()).code).toBe(2);
    expect((await run("dist/index.mjs", "--export")).code).toBe(2);
    expect((await run("--help")).code).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import { run, version } from "./cli.js";
import { PLANNED_COMMANDS } from "./commands.js";

async function capture(argv: string[]) {
  let out = "";
  let err = "";
  const code = await run(argv, {
    out: (t) => {
      out += t;
    },
    err: (t) => {
      err += t;
    },
  });
  return { code, out, err };
}

describe("cantiere cli", () => {
  it("--help lists every README command, marking the unbuilt ones as planned", async () => {
    const { code, out } = await capture(["--help"]);
    expect(code).toBe(0);
    for (const c of PLANNED_COMMANDS) {
      expect(out).toContain(c.usage);
    }
    expect(out).toContain("(planned)");
    expect(out).not.toMatch(/cantiere init .*\(planned\)/);
  });

  it("no arguments prints help", async () => {
    expect((await capture([])).out).toContain("Usage: cantiere");
  });

  it("-h prints help and -v prints the version", async () => {
    expect((await capture(["-h"])).out).toContain("Usage: cantiere");
    expect((await capture(["-v"])).out.trim()).toBe(version());
  });

  it("a bare help subcommand is not an alias for --help", async () => {
    const { code, err } = await capture(["help"]);
    expect(code).toBe(2);
    expect(err).toContain("Unknown command: help");
  });

  it("--version prints the package version", async () => {
    const { code, out } = await capture(["--version"]);
    expect(code).toBe(0);
    expect(out.trim()).toBe(version());
    expect(version()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("a planned command fails with an actionable message", async () => {
    const { code, err } = await capture(["crew"]);
    expect(code).toBe(1);
    expect(err).toContain("planned but not implemented");
    expect(err).toContain("cantiere --help");
  });

  it("an unknown command exits 2 and points at --help", async () => {
    const { code, err } = await capture(["nope"]);
    expect(code).toBe(2);
    expect(err).toContain("cantiere --help");
  });
});

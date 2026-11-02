import { describe, expect, it } from "vitest";
import { run, version } from "./cli.js";
import { PLANNED_COMMANDS } from "./commands.js";

function capture(argv: string[]) {
  let out = "";
  let err = "";
  const code = run(argv, {
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
  it("--help lists every README command as planned", () => {
    const { code, out } = capture(["--help"]);
    expect(code).toBe(0);
    for (const c of PLANNED_COMMANDS) {
      expect(out).toContain(c.usage);
    }
    expect(out).toContain("(planned)");
  });

  it("no arguments prints help", () => {
    expect(capture([]).out).toContain("Usage: cantiere");
  });

  it("--version prints the package version", () => {
    const { code, out } = capture(["--version"]);
    expect(code).toBe(0);
    expect(out.trim()).toBe(version());
    expect(version()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("a planned command fails with an actionable message", () => {
    const { code, err } = capture(["crew"]);
    expect(code).toBe(1);
    expect(err).toContain("planned but not implemented");
    expect(err).toContain("cantiere --help");
  });

  it("an unknown command exits 2 and points at --help", () => {
    const { code, err } = capture(["nope"]);
    expect(code).toBe(2);
    expect(err).toContain("cantiere --help");
  });
});

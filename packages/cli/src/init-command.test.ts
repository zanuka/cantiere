import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commitFile, git, isolateGitEnv } from "../../core/src/git.fixture.js";
import { run } from "./cli.js";

let base: string;
let repo: string;
let bin: string;

async function init(args: string[], cwd = repo, env: NodeJS.ProcessEnv = { PATH: bin }) {
  let out = "";
  let err = "";
  const code = await run(
    ["init", ...args],
    {
      out: (t) => {
        out += t;
      },
      err: (t) => {
        err += t;
      },
    },
    { cwd, env },
  );
  return { code, out, err };
}

function fakeBinary(name: string): void {
  const file = path.join(bin, name);
  writeFileSync(file, "#!/bin/sh\n");
  chmodSync(file, 0o755);
}

const read = (...parts: string[]) => readFileSync(path.join(repo, ...parts), "utf8");

beforeEach(async () => {
  isolateGitEnv();
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cantiere-init-")));
  repo = path.join(base, "repo");
  bin = path.join(base, "bin");
  mkdirSync(repo);
  mkdirSync(bin);
  fakeBinary("claude");
  fakeBinary("tmux");
  await git(repo, "init", "--quiet", "-b", "trunk");
  await commitFile(repo, "README.md", "hello\n", "initial");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("cantiere init", () => {
  it("sets up the yard: config, runtime dirs and an exclude entry (never .gitignore)", async () => {
    const { code, out } = await init([]);
    expect(code).toBe(0);
    expect(out).toContain("config.json");

    const config = JSON.parse(read(".cantiere", "config.json"));
    expect(config).toMatchObject({
      schemaVersion: 1,
      harness: "claude",
      sessionHost: "tmux",
      maxConcurrentAgents: 4,
      baseBranch: "trunk",
      gateCommands: [],
      branchPrefix: "cantiere/",
      worktreeRoot: path.join(base, "repo.worktrees"),
    });
    expect(existsSync(path.join(repo, ".cantiere", "tasks"))).toBe(true);
    expect(existsSync(path.join(repo, ".cantiere", "locks"))).toBe(true);
    expect(read(".git", "info", "exclude")).toContain("/.cantiere/\n");
    expect(existsSync(path.join(repo, ".gitignore"))).toBe(false);
    expect(await git(repo, "status", "--porcelain")).toBe("");
  });

  it("re-running changes nothing and says so, and keeps user edits", async () => {
    await init([]);
    const file = path.join(repo, ".cantiere", "config.json");
    const edited = {
      ...JSON.parse(read(".cantiere", "config.json")),
      maxConcurrentAgents: 9,
      gateCommands: ["pnpm test"],
    };
    writeFileSync(file, `${JSON.stringify(edited, null, 2)}\n`);
    const configBefore = read(".cantiere", "config.json");
    const excludeBefore = read(".git", "info", "exclude");

    const { code, out } = await init(["--harness", "claude", "--max-agents", "2"]);
    expect(code).toBe(0);
    expect(out).toContain("Nothing to do");
    expect(out).toContain("max-agents");
    expect(read(".cantiere", "config.json")).toBe(configBefore);
    expect(read(".git", "info", "exclude")).toBe(excludeBefore);

    const json = JSON.parse((await init(["--json"])).out);
    expect(json).toMatchObject({ ok: true, changed: false, plannedWrites: [] });
  });

  it("--dry-run writes nothing and lists the planned writes", async () => {
    const excludeBefore = read(".git", "info", "exclude");
    const { code, out } = await init(["--dry-run"]);
    expect(code).toBe(0);
    expect(out).toContain("dry run");
    expect(out).toContain(path.join(".cantiere", "config.json"));
    expect(out).toContain("exclude");
    expect(existsSync(path.join(repo, ".cantiere"))).toBe(false);
    expect(read(".git", "info", "exclude")).toBe(excludeBefore);
  });

  it("--json prints a machine-readable result", async () => {
    const first = JSON.parse((await init(["--json"])).out);
    expect(first).toMatchObject({ ok: true, dryRun: false, changed: true, root: repo });
    expect(first.config.baseBranch).toBe("trunk");
    expect(first.preflight.map((c: { name: string }) => c.name)).toEqual(["git", "claude", "tmux"]);

    const dry = JSON.parse((await init(["--json", "--dry-run"], repo)).out);
    expect(dry).toMatchObject({ dryRun: true, changed: false, plannedWrites: [] });
  });

  it("--dry-run --json lists planned writes on a fresh repo without writing", async () => {
    const dry = JSON.parse((await init(["--json", "--dry-run"])).out);
    expect(dry.changed).toBe(false);
    expect(dry.plannedWrites.map((w: { kind: string }) => w.kind)).toEqual([
      "mkdir",
      "mkdir",
      "mkdir",
      "write-config",
      "write-exclude",
    ]);
    expect(existsSync(path.join(repo, ".cantiere"))).toBe(false);
  });

  it("refuses outside a git repository with an actionable error", async () => {
    const plain = path.join(base, "plain");
    mkdirSync(plain);
    const { code, err } = await init([], plain);
    expect(code).toBe(1);
    expect(err).toContain("not inside a git repository");
    expect(err).toContain("git init");
    expect(existsSync(path.join(plain, ".cantiere"))).toBe(false);

    const json = JSON.parse((await init(["--json"], plain)).out);
    expect(json.ok).toBe(false);
  });

  it("appends to an existing exclude file once, preserving its content", async () => {
    const exclude = path.join(repo, ".git", "info", "exclude");
    writeFileSync(exclude, "*.swp");
    await init([]);
    await init([]);
    const text = read(".git", "info", "exclude");
    expect(text.startsWith("*.swp\n")).toBe(true);
    expect(text.match(/^\/\.cantiere\/$/gm)).toHaveLength(1);
  });

  it("fails the preflight without writing when the harness or tmux is missing", async () => {
    const missingHarness = await init(["--harness", "no-such-agent"]);
    expect(missingHarness.code).toBe(1);
    expect(missingHarness.out).toContain("MISSING  no-such-agent");
    expect(existsSync(path.join(repo, ".cantiere"))).toBe(false);

    const noTmux = await init([], repo, { PATH: path.join(base, "empty") });
    expect(noTmux.out).toContain("MISSING  tmux");
    expect(existsSync(path.join(repo, ".cantiere"))).toBe(false);

    const headless = await init(["--session-host", "process"], repo, { PATH: bin });
    expect(headless.code).toBe(0);
    expect(JSON.parse(read(".cantiere", "config.json")).sessionHost).toBe("process");
  });

  it("does not require tmux when the session host is process", async () => {
    const result = await init(["--session-host", "process", "--json"], repo, {
      PATH: bin,
    });
    expect(JSON.parse(result.out).preflight.map((c: { name: string }) => c.name)).toEqual([
      "git",
      "claude",
    ]);
  });

  it("refuses to overwrite an invalid config", async () => {
    mkdirSync(path.join(repo, ".cantiere"));
    writeFileSync(path.join(repo, ".cantiere", "config.json"), "{ not json");
    const { code, err } = await init([]);
    expect(code).toBe(1);
    expect(err).toContain("not valid JSON");
    expect(read(".cantiere", "config.json")).toBe("{ not json");
  });

  it("fills the bare config a store created, and works from a linked worktree", async () => {
    mkdirSync(path.join(repo, ".cantiere"));
    writeFileSync(path.join(repo, ".cantiere", "config.json"), '{\n  "schemaVersion": 1\n}\n');
    const linked = path.join(base, "linked");
    await git(repo, "worktree", "add", "--quiet", "-b", "other", linked);
    const { code } = await init([], linked);
    expect(code).toBe(0);
    expect(JSON.parse(read(".cantiere", "config.json")).harness).toBe("claude");
    expect(existsSync(path.join(linked, ".cantiere"))).toBe(false);
  });

  it("rejects bad flags with exit 2", async () => {
    expect((await init(["--max-agents", "0"])).code).toBe(2);
    expect((await init(["--session-host", "screen"])).code).toBe(2);
    expect((await init(["--nope"])).code).toBe(2);
    expect((await init(["--help"])).out).toContain("Usage: cantiere init");
  });
});

import {
  buildCommandEnv,
  type HarnessAdapter,
  UnsupportedCapabilityError,
} from "@cantiere/adapters";
import { describe, expect, it } from "vitest";
import {
  type ConformanceReport,
  formatConformanceReport,
  runAdapterConformance,
} from "./conformance.js";
import { createFakeAdapter } from "./fake-adapter.js";
import { adapterConformanceSuite } from "./vitest.js";

const failing = (report: ConformanceReport) =>
  report.results.filter((r) => r.status === "fail").map((r) => r.name);

// The fake adapter passes the suite, registered the way a third party would use it.
adapterConformanceSuite(createFakeAdapter({ steps: [] }), {
  samples: {
    asking: '{"fakeAgent":1,"type":"question","question":"ok?"}\n',
    working: '{"fakeAgent":1,"type":"status","status":"working"}\n',
  },
});

describe("conformance report", () => {
  it("passes the fake adapter with no failures", async () => {
    const report = await runAdapterConformance(createFakeAdapter());
    expect(failing(report)).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.results.filter((r) => r.status === "pass").length).toBeGreaterThan(10);
    expect(formatConformanceReport(report)).toContain("Conformant.");
  });
});

describe("conformance catches a broken adapter", () => {
  const good = createFakeAdapter();
  const broken = (patch: Partial<HarnessAdapter>): HarnessAdapter => ({ ...good, ...patch });

  it("wrong apiVersion", async () => {
    const report = await runAdapterConformance(broken({ apiVersion: 7 }));
    expect(failing(report)[0]).toMatch(/^shape/);
    expect(report.passed).toBe(false);
  });

  it("missing contract env", async () => {
    const report = await runAdapterConformance(
      broken({
        buildCommand: (t, c) => ({ ...good.buildCommand(t, c), env: { PATH: "/usr/bin" } }),
      }),
    );
    expect(failing(report).join()).toMatch(/environment contract/);
  });

  it("baseEnv overriding the contract", async () => {
    const report = await runAdapterConformance(
      broken({
        buildCommand: (t, c) => ({
          ...good.buildCommand(t, c),
          env: { ...buildCommandEnv(t, c), ...c.baseEnv },
        }),
      }),
    );
    expect(failing(report).join()).toMatch(/cannot be overridden/);
  });

  it("wrong cwd", async () => {
    const report = await runAdapterConformance(
      broken({ buildCommand: (t, c) => ({ ...good.buildCommand(t, c), cwd: c.repo }) }),
    );
    expect(failing(report).join()).toMatch(/valid \{argv, env, cwd\}/);
  });

  it("prepareWorkspace ignoring dryRun", async () => {
    const { writeFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const report = await runAdapterConformance(
      broken({
        async prepareWorkspace(worktree, ctx) {
          await writeFile(path.join(worktree, "x.json"), "{}");
          return good.prepareWorkspace(worktree, ctx);
        },
      }),
    );
    expect(failing(report).join()).toMatch(/dry run/);
  });

  it("prepareWorkspace writing into the primary repository", async () => {
    const { writeFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const report = await runAdapterConformance(
      broken({
        async prepareWorkspace(worktree, ctx) {
          if (!ctx.dryRun) await writeFile(path.join(ctx.repo, "leak.txt"), "x");
          return good.prepareWorkspace(worktree, ctx);
        },
      }),
    );
    expect(failing(report).join()).toMatch(/writes only inside the worktree/);
  });

  it("deliver that drops the message", async () => {
    const report = await runAdapterConformance(broken({ deliver: async () => {} }), {
      timeoutMs: 300,
    });
    expect(failing(report).join()).toMatch(/steering text/);
  });

  it("deliver that silently succeeds without steerInput", async () => {
    const report = await runAdapterConformance(
      broken({
        capabilities: { ...good.capabilities, steerInput: false },
        deliver: async () => {},
      }),
    );
    expect(failing(report).join()).toMatch(/steerInput is not declared/);
  });

  it("deliver that rejects properly without steerInput passes", async () => {
    const report = await runAdapterConformance(
      broken({
        capabilities: { ...good.capabilities, steerInput: false },
        deliver: async () => {
          throw new UnsupportedCapabilityError(
            "fake",
            "steerInput",
            "Use a harness with steering.",
          );
        },
      }),
    );
    expect(failing(report)).toEqual([]);
  });

  it("detectState that throws", async () => {
    const report = await runAdapterConformance(
      broken({
        detectState: () => {
          throw new Error("boom");
        },
      }),
    );
    expect(failing(report).join()).toMatch(/tolerates empty/);
  });

  it("detectState that misses the supplied sample", async () => {
    const report = await runAdapterConformance(broken({ detectState: () => [] }), {
      samples: { asking: "Which one?" },
    });
    expect(failing(report).join()).toMatch(/supplied sample/);
  });

  it("resume declared without resumeCommand", async () => {
    const { resumeCommand: _omit, ...rest } = good;
    const report = await runAdapterConformance(rest as HarnessAdapter);
    expect(failing(report)[0]).toMatch(/^shape/);
  });

  it("does not throw for something that is not an adapter", async () => {
    const report = await runAdapterConformance({} as HarnessAdapter);
    expect(report.passed).toBe(false);
  });
});

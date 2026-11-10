import { describe, expect, it } from "vitest";
import { branchName, generateTaskId, slugify, TASK_ID_PATTERN } from "./id.js";

describe("generateTaskId", () => {
  it("is 13 filename-safe characters", () => {
    const id = generateTaskId();
    expect(id).toMatch(TASK_ID_PATTERN);
    expect(id).toMatch(/^[a-z0-9]+$/);
  });

  it("sorts by creation time", () => {
    const times = [0, 1, 31, 32, 1_000, 1_700_000_000_000, 1_700_000_000_001, 4_000_000_000_000];
    const ids = times.map((t) => generateTaskId({ now: () => t, randomInt: () => 0 }));
    expect([...ids].sort()).toEqual(ids);
  });

  it("is deterministic given sources and varies by randomness", () => {
    const a = generateTaskId({ now: () => 5, randomInt: () => 1 });
    expect(a).toBe(generateTaskId({ now: () => 5, randomInt: () => 1 }));
    expect(a).not.toBe(generateTaskId({ now: () => 5, randomInt: () => 2 }));
  });

  it("rejects invalid timestamps with guidance", () => {
    expect(() => generateTaskId({ now: () => -1 })).toThrow(/timestamp/);
    expect(() => generateTaskId({ now: () => 1.5 })).toThrow(/timestamp/);
  });
});

describe("slugify", () => {
  it.each([
    ["Fix flaky test", "fix-flaky-test"],
    ["  --Hello, World!--  ", "hello-world"],
    ["Café déjà vu", "cafe-deja-vu"],
    ["", "task"],
    ["!!!", "task"],
    ["日本語", "task"],
  ])("%j -> %j", (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it("truncates without a trailing dash", () => {
    const slug = slugify("a".repeat(39) + " bbbb");
    expect(slug).toBe("a".repeat(39));
    expect(slugify("x".repeat(100)).length).toBe(40);
  });
});

describe("branchName", () => {
  it("builds cantiere/<id>-<slug>", () => {
    const id = generateTaskId({ now: () => 1, randomInt: () => 0 });
    expect(branchName(id, "Fix flaky test")).toBe(`cantiere/${id}-fix-flaky-test`);
  });

  it("rejects malformed ids", () => {
    expect(() => branchName("nope", "x")).toThrow(/Invalid task id/);
  });
});

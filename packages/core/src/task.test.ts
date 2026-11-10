import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  generateTaskId,
  renderTaskSchema,
  SCHEMA_VERSION,
  TaskSchema,
  taskJsonSchema,
} from "./index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const valid = {
  schemaVersion: SCHEMA_VERSION,
  id: generateTaskId({ now: () => 1, randomInt: () => 0 }),
  title: "Fix flaky test",
  prompt: "Find and fix the flaky test.",
  kind: "agent",
  repo: "/work/repo",
  baseRef: "main",
  harness: "claude-code",
  createdAt: "2026-11-10T00:00:00.000Z",
  source: "manual",
};

describe("TaskSchema", () => {
  it("accepts a minimal task and defaults labels", () => {
    expect(TaskSchema.parse(valid).labels).toEqual([]);
  });

  it("accepts provisioned fields, profile and parent", () => {
    const parent = generateTaskId({ now: () => 2, randomInt: () => 0 });
    const task = TaskSchema.parse({
      ...valid,
      branch: "b",
      worktreePath: "/w",
      profile: "p",
      parent,
      labels: ["x"],
    });
    expect(task.parent).toBe(parent);
  });

  it.each([
    ["wrong schemaVersion", { schemaVersion: 2 }],
    ["bad id", { id: "NOPE" }],
    ["unknown kind", { kind: "other" }],
    ["unknown source", { source: "github" }],
    ["empty title", { title: "" }],
    ["bad createdAt", { createdAt: "yesterday" }],
    ["unknown field", { extra: 1 }],
  ])("rejects %s", (_name, patch) => {
    expect(TaskSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
});

describe("JSON Schema", () => {
  it("carries a schemaVersion const", () => {
    const schema = taskJsonSchema() as {
      properties: Record<string, { const?: number }>;
      required: string[];
    };
    expect(schema.properties.schemaVersion?.const).toBe(SCHEMA_VERSION);
    expect(schema.required).toContain("schemaVersion");
  });

  it("matches schema/task.schema.json (run `pnpm schema` to regenerate)", () => {
    const onDisk = readFileSync(path.join(root, "schema/task.schema.json"), "utf8");
    // Compare parsed JSON: `pnpm schema` runs the formatter over the file.
    expect(JSON.parse(onDisk)).toEqual(JSON.parse(renderTaskSchema()));
  });
});

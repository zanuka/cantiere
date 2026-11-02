import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, SchemaVersionSchema } from "./index.js";

describe("core", () => {
  it("validates the on-disk schema version", () => {
    expect(SchemaVersionSchema.parse(SCHEMA_VERSION)).toBe(1);
    expect(SchemaVersionSchema.safeParse(2).success).toBe(false);
  });
});

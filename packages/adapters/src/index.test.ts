import { describe, expect, it } from "vitest";
import { ADAPTERS_PACKAGE } from "./index.js";

describe("adapters", () => {
  it("exposes a package marker", () => {
    expect(ADAPTERS_PACKAGE).toBe("@cantiere/adapters");
  });
});

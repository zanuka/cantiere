import { describe, expect, it } from "vitest";
import { ADAPTER_API_VERSION, ADAPTERS_PACKAGE } from "./index.js";

describe("adapters", () => {
  it("exposes a package marker and the api version", () => {
    expect(ADAPTERS_PACKAGE).toBe("@cantiere/adapters");
    expect(ADAPTER_API_VERSION).toBe(1);
  });
});

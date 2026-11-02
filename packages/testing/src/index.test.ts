import { describe, expect, it } from "vitest";
import { TESTING_PACKAGE } from "./index.js";

describe("testing", () => {
  it("exposes a package marker", () => {
    expect(TESTING_PACKAGE).toBe("@cantiere/testing");
  });
});

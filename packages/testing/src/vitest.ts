import type { HarnessAdapter } from "@cantiere/adapters";
import { describe, expect, it } from "vitest";
import { type ConformanceOptions, runAdapterConformance } from "./conformance.js";

/**
 * Registers the conformance suite for `adapter` as vitest tests (one per check). Call it from a test
 * file in your adapter's repo:
 *
 *   import { adapterConformanceSuite } from "@cantiere/testing/vitest";
 *   adapterConformanceSuite(myAdapter);
 */
export function adapterConformanceSuite(
  adapter: HarnessAdapter,
  options: ConformanceOptions = {},
): void {
  describe(`adapter conformance: ${adapter.id}`, async () => {
    const report = await runAdapterConformance(adapter, options);
    for (const result of report.results) {
      it.skipIf(result.status === "skip")(result.name, () => {
        expect(result.status === "fail" ? result.message : undefined).toBeUndefined();
      });
    }
  });
}

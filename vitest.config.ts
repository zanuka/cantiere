import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));
const src = (pkg: string, file = "index.ts") => path.join(root, "packages", pkg, "src", file);

export default defineConfig({
  resolve: {
    alias: [
      { find: "@cantiere/testing/vitest", replacement: src("testing", "vitest.ts") },
      { find: /^@cantiere\/core$/, replacement: src("core") },
      { find: /^@cantiere\/adapters$/, replacement: src("adapters") },
      { find: /^@cantiere\/testing$/, replacement: src("testing") },
    ],
  },
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    environment: "node",
  },
});

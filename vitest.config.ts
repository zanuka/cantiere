import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));
const src = (pkg: string) => path.join(root, "packages", pkg, "src/index.ts");

export default defineConfig({
  resolve: {
    alias: {
      "@cantiere/core": src("core"),
      "@cantiere/adapters": src("adapters"),
      "@cantiere/testing": src("testing"),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    environment: "node",
  },
});

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderTaskSchema } from "../packages/core/src/schema-files.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "schema");
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, "task.schema.json"), renderTaskSchema());
console.log("wrote schema/task.schema.json");

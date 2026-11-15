import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  renderEventSchema,
  renderSnapshotSchema,
  renderTaskSchema,
} from "../packages/core/src/schema-files.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "schema");
mkdirSync(out, { recursive: true });

const files = {
  "task.schema.json": renderTaskSchema(),
  "event.schema.json": renderEventSchema(),
  "task-snapshot.schema.json": renderSnapshotSchema(),
};
for (const [name, text] of Object.entries(files)) {
  writeFileSync(path.join(out, name), text);
  console.log(`wrote schema/${name}`);
}

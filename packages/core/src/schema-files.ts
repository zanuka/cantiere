import { taskJsonSchema } from "./task.js";

/** Exact text of `schema/task.schema.json`. */
export function renderTaskSchema(): string {
  return `${JSON.stringify(taskJsonSchema(), null, 2)}\n`;
}

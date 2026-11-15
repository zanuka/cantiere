import { eventJsonSchema, snapshotJsonSchema } from "./events.js";
import { taskJsonSchema } from "./task.js";

const render = (schema: Record<string, unknown>) => `${JSON.stringify(schema, null, 2)}\n`;

/** Exact text of `schema/task.schema.json`. */
export function renderTaskSchema(): string {
  return render(taskJsonSchema());
}

/** Exact text of `schema/event.schema.json`. */
export function renderEventSchema(): string {
  return render(eventJsonSchema());
}

/** Exact text of `schema/task-snapshot.schema.json`. */
export function renderSnapshotSchema(): string {
  return render(snapshotJsonSchema());
}

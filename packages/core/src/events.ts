import { z } from "zod";
import { SCHEMA_VERSION } from "./schema-version.js";
import { IllegalTransitionError, type TaskState, TaskStateSchema, transition } from "./state.js";
import { TaskIdSchema, TaskSchema } from "./task.js";

/** Who produced an event. */
export const ActorSchema = z.enum(["cantiere", "agent", "human"]);
export type Actor = z.infer<typeof ActorSchema>;

/**
 * The event envelope (see docs/events.md). It is deliberately loose: unknown top-level fields,
 * unknown event types and newer envelope versions are all read and preserved, never dropped.
 */
export const EventEnvelopeSchema = z.looseObject({
  /** Envelope version. Readers interpret only versions they know and preserve the rest. */
  v: z.number().int().positive(),
  ts: z.iso.datetime(),
  taskId: TaskIdSchema,
  /** 1-based, contiguous and strictly increasing within a task. */
  seq: z.number().int().positive(),
  type: z.string().min(1),
  actor: ActorSchema,
  data: z.record(z.string(), z.unknown()),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

/** What a caller supplies; the store assigns `v`, `ts`, `taskId` and `seq`. */
export interface EventInput {
  type: string;
  actor: Actor;
  data?: Record<string, unknown>;
}

/** Payloads of the event types the runtime interprets. Every other type is preserved opaquely. */
export const TaskCreatedDataSchema = z.object({ task: TaskSchema }).strict();
export const TaskProvisionedDataSchema = z
  .object({ branch: z.string().min(1), worktreePath: z.string().min(1) })
  .strict();
export const TaskTransitionedDataSchema = z
  .object({
    to: TaskStateSchema,
    reason: z.string().min(1).optional(),
    approved: z.boolean().optional(),
  })
  .strict();

export const EVENT_TYPES = {
  taskCreated: "task.created",
  taskProvisioned: "task.provisioned",
  taskTransitioned: "task.transitioned",
} as const;

export const EVENT_DATA_SCHEMAS = {
  [EVENT_TYPES.taskCreated]: TaskCreatedDataSchema,
  [EVENT_TYPES.taskProvisioned]: TaskProvisionedDataSchema,
  [EVENT_TYPES.taskTransitioned]: TaskTransitionedDataSchema,
} as const;

/**
 * The snapshot cached in `tasks/<id>/task.json`: the task definition plus state derived from the
 * event log. It is always rebuildable from the log, and rebuilding is deterministic.
 */
export const TaskSnapshotSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    task: TaskSchema,
    state: TaskStateSchema,
    /** `seq` of the last event folded in. */
    seq: z.number().int().positive(),
    /** `ts` of the last event folded in. */
    updatedAt: z.iso.datetime(),
    /** `ts` of the event that put the task into `state`. */
    stateSince: z.iso.datetime(),
  })
  .strict();
export type TaskSnapshot = z.infer<typeof TaskSnapshotSchema>;

/** A candidate or recorded event carries data that does not match its type's schema. */
export class InvalidEventError extends Error {
  constructor(
    readonly eventType: string,
    detail: string,
  ) {
    super(`Invalid ${eventType} event: ${detail}`);
    this.name = "InvalidEventError";
  }
}

/** The log cannot be folded into a state: the recorded history is inconsistent. */
export class CorruptEventLogError extends Error {
  constructor(
    readonly taskId: string,
    readonly seq: number | undefined,
    detail: string,
  ) {
    super(
      `Event log for task ${taskId} is corrupt${seq === undefined ? "" : ` at seq ${seq}`}: ${detail} ` +
        "Restore events.jsonl from a backup or inspect it by hand; do not delete it.",
    );
    this.name = "CorruptEventLogError";
  }
}

function parseData<S extends z.ZodType>(event: EventEnvelope, schema: S): z.infer<S> {
  const result = schema.safeParse(event.data);
  if (!result.success) {
    throw new InvalidEventError(event.type, result.error.issues.map((i) => i.message).join("; "));
  }
  return result.data;
}

function interpreted(event: EventEnvelope): boolean {
  return event.v <= SCHEMA_VERSION;
}

/**
 * Folds one event into a snapshot. This is the single place that derives state from events, and it
 * reuses the lifecycle state machine (`transition`) rather than defining a second one. Unknown
 * event types (and envelopes newer than this reader) advance `seq` and `updatedAt` only.
 *
 * Throws {@link IllegalTransitionError} or {@link InvalidEventError} when the event cannot apply.
 */
export function applyEvent(snapshot: TaskSnapshot | undefined, event: EventEnvelope): TaskSnapshot {
  if (snapshot === undefined) {
    if (!interpreted(event) || event.type !== EVENT_TYPES.taskCreated) {
      throw new InvalidEventError(
        event.type,
        `the first event of a task must be ${EVENT_TYPES.taskCreated} (envelope v${SCHEMA_VERSION}).`,
      );
    }
    const { task } = parseData(event, TaskCreatedDataSchema);
    return {
      schemaVersion: SCHEMA_VERSION,
      task,
      state: "queued",
      seq: event.seq,
      updatedAt: event.ts,
      stateSince: event.ts,
    };
  }

  const next: TaskSnapshot = { ...snapshot, seq: event.seq, updatedAt: event.ts };
  if (!interpreted(event)) return next;

  switch (event.type) {
    case EVENT_TYPES.taskCreated:
      throw new InvalidEventError(event.type, "the task already exists.");
    case EVENT_TYPES.taskProvisioned: {
      const { branch, worktreePath } = parseData(event, TaskProvisionedDataSchema);
      if (snapshot.state !== "provisioning") {
        throw new InvalidEventError(
          event.type,
          `worktree details can only be recorded while provisioning (state is ${snapshot.state}).`,
        );
      }
      return { ...next, task: { ...snapshot.task, branch, worktreePath } };
    }
    case EVENT_TYPES.taskTransitioned: {
      const { to, reason, approved } = parseData(event, TaskTransitionedDataSchema);
      const provisioned = Boolean(snapshot.task.branch && snapshot.task.worktreePath);
      const state: TaskState = transition(snapshot.state, to, {
        provisioned,
        ...(approved === undefined ? {} : { approved }),
        ...(reason === undefined ? {} : { reason }),
      });
      return { ...next, state, stateSince: event.ts };
    }
    default:
      return next;
  }
}

/** Derives the snapshot from a complete log. Pure and deterministic: same events, same snapshot. */
export function foldEvents(taskId: string, events: readonly EventEnvelope[]): TaskSnapshot {
  let snapshot: TaskSnapshot | undefined;
  for (const event of events) {
    if (event.taskId !== taskId) {
      throw new CorruptEventLogError(
        taskId,
        event.seq,
        `it holds an event for task ${event.taskId}.`,
      );
    }
    try {
      snapshot = applyEvent(snapshot, event);
    } catch (error) {
      if (error instanceof InvalidEventError || error instanceof IllegalTransitionError) {
        throw new CorruptEventLogError(taskId, event.seq, error.message);
      }
      throw error;
    }
  }
  if (snapshot === undefined) {
    throw new CorruptEventLogError(taskId, undefined, "it holds no events.");
  }
  return snapshot;
}

/** JSON Schema (draft 2020-12) for {@link EventEnvelopeSchema}. */
export function eventJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(EventEnvelopeSchema, { target: "draft-2020-12", io: "input" }) as Record<
    string,
    unknown
  >;
}

/** JSON Schema (draft 2020-12) for {@link TaskSnapshotSchema}. */
export function snapshotJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(TaskSnapshotSchema, { target: "draft-2020-12", io: "input" }) as Record<
    string,
    unknown
  >;
}

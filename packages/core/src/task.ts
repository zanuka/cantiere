import { z } from "zod";
import { TASK_ID_PATTERN } from "./id.js";
import { SCHEMA_VERSION } from "./schema-version.js";

export const TaskIdSchema = z
  .string()
  .regex(TASK_ID_PATTERN, "task id must be 13 lowercase Crockford base32 characters");

/** `agent` runs a coding agent; `command` is reserved for non-agent jobs (for example Riparo scans). */
export const TaskKindSchema = z.enum(["agent", "command"]);

/** `manual` today; `maglio` once work orders dispatch tasks. */
export const TaskSourceSchema = z.enum(["manual", "maglio"]);

/**
 * The definition of a task: what to run, where, and with which harness. Lifecycle state is
 * modelled separately (see `state.ts`); the on-disk snapshot follows ADR 0002 and is defined
 * with the store (issue #4).
 */
export const TaskSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    id: TaskIdSchema,
    title: z.string().min(1),
    prompt: z.string(),
    kind: TaskKindSchema,
    repo: z.string().min(1),
    baseRef: z.string().min(1),
    /** Set when the worktree is provisioned. */
    branch: z.string().min(1).optional(),
    /** Set when the worktree is provisioned. */
    worktreePath: z.string().min(1).optional(),
    harness: z.string().min(1),
    /** Opaque to the runtime; interpreted by the harness adapter. */
    profile: z.string().optional(),
    createdAt: z.iso.datetime(),
    labels: z.array(z.string().min(1)).default([]),
    source: TaskSourceSchema,
    /** Parent task id, for stage chains. */
    parent: TaskIdSchema.optional(),
  })
  .strict();

export type Task = z.infer<typeof TaskSchema>;
export type TaskKind = z.infer<typeof TaskKindSchema>;
export type TaskSource = z.infer<typeof TaskSourceSchema>;

/** JSON Schema (draft 2020-12) for {@link TaskSchema}, the language-neutral contract. */
export function taskJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(TaskSchema, { target: "draft-2020-12", io: "input" }) as Record<
    string,
    unknown
  >;
}

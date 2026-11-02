import { z } from "zod";

/** Version of the on-disk format Cantiere writes. Formats stay language-neutral (JSON / JSONL). */
export const SCHEMA_VERSION = 1;

export const SchemaVersionSchema = z.literal(SCHEMA_VERSION);

/** Placeholder: the task model, store and git code land in follow-up issues (#3, #4, #5). */
export const CORE_PACKAGE = "@cantiere/core";

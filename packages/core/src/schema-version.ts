import { z } from "zod";

/** Version of the on-disk format Cantiere writes. Formats stay language-neutral (JSON / JSONL). */
export const SCHEMA_VERSION = 1;

export const SchemaVersionSchema = z.literal(SCHEMA_VERSION);

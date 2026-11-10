/** Crockford base32, lowercase: filename-safe and sorts the same as the numbers it encodes. */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

const TIME_CHARS = 9; // 45 bits of milliseconds: good for ~1000 years
const RANDOM_CHARS = 4;
const SLUG_MAX = 40;

export const TASK_ID_PATTERN = /^[0-9a-hjkmnp-tv-z]{13}$/;

export interface IdSources {
  /** Milliseconds since epoch. */
  now?: () => number;
  /** Returns an integer in [0, max). */
  randomInt?: (max: number) => number;
}

function encode(value: number, width: number): string {
  let out = "";
  let rest = value;
  for (let i = 0; i < width; i++) {
    out = ALPHABET[rest % 32] + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

/** Short, sortable (by creation time), filename-safe task id, e.g. `01k3m9x2q7a4b`. */
export function generateTaskId(sources: IdSources = {}): string {
  const now = (sources.now ?? Date.now)();
  if (!Number.isSafeInteger(now) || now < 0 || now >= 32 ** TIME_CHARS) {
    throw new Error(
      `Cannot generate a task id from timestamp ${now}: expected a non-negative integer of milliseconds.`,
    );
  }
  const rand = sources.randomInt ?? ((max: number) => Math.floor(Math.random() * max));
  let suffix = "";
  for (let i = 0; i < RANDOM_CHARS; i++) suffix += ALPHABET[rand(32)];
  return encode(now, TIME_CHARS) + suffix;
}

/** Lowercase, dash-separated, ascii-only slug for branch names. Never empty. */
export function slugify(text: string, maxLength = SLUG_MAX): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug === "" ? "task" : slug;
}

/** Branch name for a task: `cantiere/<id>-<slug>`. */
export function branchName(id: string, title: string): string {
  if (!TASK_ID_PATTERN.test(id)) {
    throw new Error(`Invalid task id "${id}": expected 13 lowercase Crockford base32 characters.`);
  }
  return `cantiere/${id}-${slugify(title)}`;
}

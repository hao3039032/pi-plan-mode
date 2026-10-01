import { existsSync } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

/**
 * Plan documents: every completed plan is persisted as Markdown inside a dedicated output
 * directory (default `plans/`) so the user can read it with any editor, and the agent may
 * draft/iterate documents there while planning inside the sandbox.
 */

export const DEFAULT_PLAN_OUTPUT_DIR = "plans";
const MAX_PLAN_DOC_PATH_LENGTH = 4096;
const MAX_SLUG_CODEPOINTS = 40;
const COLLISION_LIMIT = 50;

export function resolvePlanOutputDir(configured: string | undefined, cwd: string) {
  const trimmed = configured?.trim();
  if (!trimmed) return resolve(cwd, DEFAULT_PLAN_OUTPUT_DIR);
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed);
}

/** Derive a filename-safe slug from the plan's first Markdown heading. */
export function planDocSlug(plan: string) {
  for (const line of plan.split(/\r?\n/u)) {
    const heading = /^#{1,6}\s+(.*)$/u.exec(line.trim());
    if (!heading) continue;
    const slug = slugify(heading[1] ?? "");
    if (slug) return slug;
  }
  return "plan";
}

function slugify(value: string) {
  const normalized = value
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/u, "")
    .toLowerCase();
  const codePoints = [...normalized];
  return codePoints.length > MAX_SLUG_CODEPOINTS ? codePoints.slice(0, MAX_SLUG_CODEPOINTS).join("") : normalized;
}

export function planDocFilename(date: Date, slug: string) {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}-${slug}.md`;
}

/** Pick a non-colliding doc path for a plan; deterministic for identical inputs. */
export function allocatePlanDocPath(outputDir: string, plan: string, now = new Date()) {
  const base = planDocFilename(now, planDocSlug(plan));
  let candidate = join(outputDir, base);
  for (let attempt = 2; attempt <= COLLISION_LIMIT; attempt += 1) {
    if (!existsSync(candidate)) return candidate;
    candidate = join(outputDir, base.replace(/\.md$/u, `-${attempt}.md`));
  }
  return join(outputDir, base.replace(/\.md$/u, `-${Date.now()}.md`));
}

export async function writePlanDoc(path: string, plan: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${plan.trim()}\n`, { encoding: "utf8" });
}

/** Newest Markdown file in the output dir, optionally only files modified since `sinceMs`. */
export async function newestPlanMarkdown(outputDir: string, sinceMs?: number) {
  let entries: string[];
  try {
    entries = await readdir(outputDir);
  } catch {
    return undefined;
  }
  let newest: { path: string; mtimeMs: number } | undefined;
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".md")) continue;
    const path = join(outputDir, entry);
    try {
      const stats = await stat(path);
      if (!stats.isFile()) continue;
      if (sinceMs !== undefined && stats.mtimeMs < sinceMs) continue;
      if (!newest || stats.mtimeMs > newest.mtimeMs) newest = { path, mtimeMs: stats.mtimeMs };
    } catch {
      continue;
    }
  }
  return newest?.path;
}

/** Display path relative to `from` when possible, otherwise the absolute path. */
export function displayPath(path: string | undefined, from: string | undefined) {
  if (!path) return undefined;
  if (!from) return path;
  const rel = relative(from, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return path;
  return rel;
}

export function isValidPlanDocPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_PLAN_DOC_PATH_LENGTH &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    })
  );
}

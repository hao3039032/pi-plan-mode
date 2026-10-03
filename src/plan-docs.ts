import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { lstat, mkdir, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

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

/**
 * Pick a non-colliding doc path for a plan; deterministic for identical inputs. Any existing
 * directory entry (including a dangling symlink) counts as taken, so a planted link is never reused.
 */
export function allocatePlanDocPath(outputDir: string, plan: string, now = new Date()) {
  const base = planDocFilename(now, planDocSlug(plan));
  const isTaken = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;
  for (let attempt = 1; attempt <= COLLISION_LIMIT; attempt += 1) {
    const candidate = join(outputDir, attempt === 1 ? base : base.replace(/\.md$/u, `-${attempt}.md`));
    if (!isTaken(candidate)) return candidate;
  }
  for (;;) {
    const candidate = join(outputDir, base.replace(/\.md$/u, `-${randomUUID()}.md`));
    if (!isTaken(candidate)) return candidate;
  }
}

/**
 * Whether `path` may receive a plan document for the workflow whose verified real output directory
 * is `outputDir`: it must be a direct child of that directory, the directory must still resolve to
 * itself, and an existing entry must be a regular file with a single link.
 */
export async function isSafePlanDocTarget(path: string, outputDir: string) {
  if (!isAbsolute(path) || resolve(path) !== path || dirname(path) !== outputDir) return false;
  const realOutputDir = await realpath(outputDir).catch(() => undefined);
  if (realOutputDir !== outputDir) return false;
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? null : undefined));
  if (existing === undefined) return false;
  return existing === null || (existing.isFile() && existing.nlink === 1);
}

/**
 * Write a plan document through a fresh temp file in the verified output directory and rename it
 * over the target, so a symlink or hard link planted at the target is replaced, never followed.
 */
export async function writePlanDoc(path: string, plan: string, outputDir: string) {
  if (!(await isSafePlanDocTarget(path, outputDir))) {
    throw new Error(`refusing to write plan document outside the verified plan output directory: ${path}`);
  }
  const temporary = join(outputDir, `.${basename(path)}.${randomUUID()}.tmp`);
  // "wx" is O_CREAT|O_EXCL: it never follows or reuses an existing entry at the temp name.
  await writeFile(temporary, `${plan.trim()}\n`, { encoding: "utf8", flag: "wx" });
  try {
    await rename(temporary, path);
  } catch (error: unknown) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
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

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/gu;

/**
 * Resolve a write/edit tool `path` the way pi's built-in tools do (`@` prefix, Unicode spaces,
 * `~`, `file://`, relative to cwd) so the containment check sees the same target the tool writes.
 */
export function resolveToolTargetPath(input: string, cwd: string) {
  let normalized = input.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~") normalized = homedir();
  else if (normalized.startsWith("~/")) normalized = join(homedir(), normalized.slice(2));
  else if (/^file:\/\//u.test(normalized)) normalized = fileURLToPath(normalized);
  return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

/**
 * Whether `target` (absolute) lies strictly inside `outputDir` after resolving symlinks through the
 * nearest existing ancestor of each. An existing symlink is resolved (a dangling one is rejected)
 * and an existing hard-linked file is rejected, so neither can redirect a write outside.
 */
export async function isPathInsidePlanOutputDir(target: string, outputDir: string) {
  const realOutputDir = await realpathThroughExistingAncestor(resolve(outputDir));
  const realTarget = await realpathThroughExistingAncestor(resolve(target), { rejectHardLinks: true });
  if (!realOutputDir || !realTarget) return false;
  const rel = relative(realOutputDir, realTarget);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export async function realpathThroughExistingAncestor(path: string, options: { rejectHardLinks?: boolean } = {}) {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    const stats = await lstat(current).catch(() => undefined);
    if (stats) {
      let real: string;
      try {
        // Throws for a dangling symlink, which must not be treated as a missing path.
        real = await realpath(current);
      } catch {
        return undefined;
      }
      if (options.rejectHardLinks && missing.length === 0) {
        const targetStats = stats.isSymbolicLink() ? await stat(real).catch(() => undefined) : stats;
        if (!targetStats || (targetStats.isFile() && targetStats.nlink > 1)) return undefined;
      }
      return missing.length > 0 ? join(real, ...missing.reverse()) : real;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    missing.push(basename(current));
    current = parent;
  }
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

/** Whether `path` equals `directory` or lies under it (both absolute, already resolved). */
export function isAtOrUnderPath(path: string, directory: string) {
  const rel = relative(directory, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export interface PlanOutputDirRequest {
  cwd: string;
  /** Current `planOutputDir` setting (undefined means the default `plans`). */
  configured: string | undefined;
  /** Real output directory frozen by the workflow being restored, if any. */
  frozen?: string;
  /** Directories the output dir may neither be at/under nor contain (agent dir, srt profile dir). */
  protectedDirs: readonly string[];
  /** Files the output dir may neither be nor contain (pi-plan-vanguard settings). */
  protectedFiles: readonly string[];
}

export type PlanOutputDirResolution = { ok: true; outputDir: string } | { ok: false; reason: string };

/**
 * Create and verify the real plan output directory for a workflow. A relative (or default)
 * setting and a restored directory inside the working directory must stay inside realpath(cwd)
 * with no symlinked path component; an absolute setting is trusted as configured. A restored
 * directory outside the working directory is accepted only when it is the configured absolute
 * directory. No result may overlap the pi agent dir, the srt profile dir, or settings files.
 */
export async function preparePlanOutputDir(request: PlanOutputDirRequest): Promise<PlanOutputDirResolution> {
  const fail = (reason: string): PlanOutputDirResolution => ({ ok: false, reason });
  const realCwd = await realpath(resolve(request.cwd)).catch(() => undefined);
  if (!realCwd) return fail(`the working directory ${request.cwd} is unavailable`);
  const configured = request.configured?.trim() || undefined;
  const configuredAbsolute = configured && isAbsolute(configured) ? resolve(configured) : undefined;

  let insideRelative: string | undefined;
  let trustedPath: string | undefined;
  if (request.frozen !== undefined) {
    const frozen = request.frozen;
    if (!isAbsolute(frozen) || resolve(frozen) !== frozen) return fail(`the recorded plan output directory ${frozen} is not a normalized absolute path`);
    const rel = relative(realCwd, frozen);
    if (isStrictlyInside(rel)) insideRelative = rel;
    else if (configuredAbsolute && (await realpathThroughExistingAncestor(configuredAbsolute)) === frozen) trustedPath = frozen;
    else return fail(`the recorded plan output directory ${frozen} is outside the working directory and is not the configured planOutputDir`);
  } else if (configuredAbsolute) {
    trustedPath = configuredAbsolute;
  } else {
    const rel = relative(resolve(request.cwd), resolve(request.cwd, configured ?? DEFAULT_PLAN_OUTPUT_DIR));
    if (!isStrictlyInside(rel)) return fail(`planOutputDir ${configured ?? DEFAULT_PLAN_OUTPUT_DIR} must stay inside the working directory`);
    insideRelative = rel;
  }

  const candidate = insideRelative !== undefined ? join(realCwd, insideRelative) : (trustedPath as string);
  if (insideRelative !== undefined) {
    const problem = await symlinkedComponent(realCwd, insideRelative, false);
    if (problem) return fail(problem);
  }
  const predicted = await realpathThroughExistingAncestor(candidate);
  if (!predicted) return fail(`the plan output directory ${candidate} cannot be resolved`);
  const overlapBefore = await protectedOverlap(predicted, request);
  if (overlapBefore) return fail(overlapBefore);
  try {
    await mkdir(candidate, { recursive: true });
  } catch (error: unknown) {
    return fail(`the plan output directory ${candidate} could not be created (${error instanceof Error ? error.message : String(error)})`);
  }
  if (insideRelative !== undefined) {
    const problem = await symlinkedComponent(realCwd, insideRelative, true);
    if (problem) return fail(problem);
  }
  const real = await realpath(candidate).catch(() => undefined);
  const stats = real ? await stat(real).catch(() => undefined) : undefined;
  if (!real || !stats?.isDirectory()) return fail(`the plan output directory ${candidate} is not a directory`);
  if (insideRelative !== undefined && real !== candidate) {
    return fail(`the plan output directory ${candidate} resolves outside the working directory`);
  }
  if (request.frozen !== undefined && real !== request.frozen) {
    return fail(`the recorded plan output directory ${request.frozen} no longer resolves to itself`);
  }
  const overlapAfter = await protectedOverlap(real, request);
  if (overlapAfter) return fail(overlapAfter);
  return { ok: true, outputDir: real };
}

function isStrictlyInside(rel: string) {
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Describe the first symlinked (or non-directory) component of `root/rel`; missing tails are allowed unless `requireAll`. */
async function symlinkedComponent(root: string, rel: string, requireAll: boolean) {
  let current = root;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    const stats = await lstat(current).catch(() => undefined);
    if (!stats) return requireAll ? `the plan output directory component ${current} is missing` : undefined;
    if (stats.isSymbolicLink()) return `the plan output directory component ${current} is a symlink`;
    if (!stats.isDirectory()) return `the plan output directory component ${current} is not a directory`;
  }
  return undefined;
}

async function protectedOverlap(outputDir: string, request: PlanOutputDirRequest) {
  for (const directory of request.protectedDirs) {
    const real = (await realpathThroughExistingAncestor(resolve(directory))) ?? resolve(directory);
    if (isAtOrUnderPath(outputDir, real) || isAtOrUnderPath(real, outputDir)) {
      return `the plan output directory ${outputDir} overlaps the protected pi directory ${real}`;
    }
  }
  for (const file of request.protectedFiles) {
    const real = (await realpathThroughExistingAncestor(resolve(file))) ?? resolve(file);
    if (isAtOrUnderPath(real, outputDir)) {
      return `the plan output directory ${outputDir} contains the protected settings file ${real}`;
    }
  }
  return undefined;
}

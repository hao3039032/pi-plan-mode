import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  allocatePlanDocPath,
  displayPath,
  isPathInsidePlanOutputDir,
  isSafePlanDocTarget,
  isValidPlanDocPath,
  newestPlanMarkdown,
  planDocFilename,
  planDocSlug,
  preparePlanOutputDir,
  resolvePlanOutputDir,
  resolveToolTargetPath,
  writePlanDoc,
} from "../src/plan-docs.js";

test("resolvePlanOutputDir defaults to plans under the working directory", () => {
  assert.equal(resolvePlanOutputDir(undefined, "/repo"), "/repo/plans");
  assert.equal(resolvePlanOutputDir(" specs ", "/repo"), "/repo/specs");
  assert.equal(resolvePlanOutputDir("/abs/plans", "/repo"), "/abs/plans");
  assert.equal(resolvePlanOutputDir("", "/repo"), "/repo/plans");
});

test("planDocSlug derives a filesystem-safe slug from the first heading", () => {
  assert.equal(planDocSlug("# Add SRT Sandboxing to Plan Mode!\nbody"), "add-srt-sandboxing-to-plan-mode");
  assert.equal(planDocSlug("## 计划：重构工具策略\n正文"), "计划-重构工具策略");
  assert.equal(planDocSlug("no heading here"), "plan");
  const long = `# ${"a".repeat(200)}`;
  assert.ok([...planDocSlug(long)].length <= 40);
});

test("planDocFilename formats the date prefix", () => {
  assert.equal(planDocFilename(new Date(2026, 0, 5), "my-plan"), "2026-01-05-my-plan.md");
});

test("allocatePlanDocPath avoids collisions with -N suffixes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-docs-"));
  try {
    const plan = "# Deploy the service";
    const first = allocatePlanDocPath(directory, plan, new Date(2026, 0, 5));
    assert.ok(first.endsWith("2026-01-05-deploy-the-service.md"));
    await writeFile(first, "x");
    const second = allocatePlanDocPath(directory, plan, new Date(2026, 0, 5));
    assert.ok(second.endsWith("2026-01-05-deploy-the-service-2.md"));
    await writeFile(second, "x");
    const third = allocatePlanDocPath(directory, plan, new Date(2026, 0, 5));
    assert.ok(third.endsWith("2026-01-05-deploy-the-service-3.md"));
    // A dangling symlink planted at the predictable name counts as taken.
    await symlink(join(directory, "missing-target.md"), third);
    const fourth = allocatePlanDocPath(directory, plan, new Date(2026, 0, 5));
    assert.ok(fourth.endsWith("2026-01-05-deploy-the-service-4.md"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("writePlanDoc trims content and writes only direct children of the verified output directory", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-plan-mode-docs-")));
  try {
    const outputDir = join(directory, "plans");
    await mkdir(outputDir);
    const path = join(outputDir, "2026-01-05-plan.md");
    await writePlanDoc(path, "# Plan\n\nbody\n\n", outputDir);
    assert.equal(await readFile(path, "utf8"), "# Plan\n\nbody\n");
    await writePlanDoc(path, "# Plan\n\nrevised", outputDir);
    assert.equal(await readFile(path, "utf8"), "# Plan\n\nrevised\n");
    // No temp files are left behind.
    assert.deepEqual(await readdir(outputDir), ["2026-01-05-plan.md"]);
    await assert.rejects(writePlanDoc(join(outputDir, "nested", "a.md"), "# A", outputDir), /refusing/u);
    await assert.rejects(writePlanDoc(join(directory, "a.md"), "# A", outputDir), /refusing/u);
    assert.equal(existsSync(join(directory, "a.md")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("plan document targets reject planted symlinks and hard links and never write through them", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-plan-mode-docs-")));
  try {
    const outputDir = join(directory, "plans");
    const outside = join(directory, "outside");
    await mkdir(outputDir);
    await mkdir(outside);
    await writeFile(join(outside, "keep.md"), "keep");
    await symlink(join(outside, "victim.md"), join(outputDir, "dangling.md"));
    await symlink(join(outside, "keep.md"), join(outputDir, "linked.md"));
    await link(join(outside, "keep.md"), join(outputDir, "hard.md"));
    await mkdir(join(outputDir, "dir.md"));
    await writeFile(join(outputDir, "regular.md"), "x");

    assert.equal(await isSafePlanDocTarget(join(outputDir, "new.md"), outputDir), true);
    assert.equal(await isSafePlanDocTarget(join(outputDir, "regular.md"), outputDir), true);
    for (const name of ["dangling.md", "linked.md", "hard.md", "dir.md"]) {
      assert.equal(await isSafePlanDocTarget(join(outputDir, name), outputDir), false, name);
      await assert.rejects(writePlanDoc(join(outputDir, name), "# Attack", outputDir), /refusing/u);
    }
    assert.equal(existsSync(join(outside, "victim.md")), false);
    assert.equal(await readFile(join(outside, "keep.md"), "utf8"), "keep");

    // The output directory itself must still resolve to the frozen real path.
    const alias = join(directory, "alias");
    await symlink(outputDir, alias);
    assert.equal(await isSafePlanDocTarget(join(alias, "new.md"), alias), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preparePlanOutputDir creates and freezes a real directory inside the working directory", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-plan-mode-outdir-")));
  try {
    const cwd = join(root, "repo");
    const agentDir = join(root, "agent");
    const outside = join(root, "outside");
    await mkdir(cwd);
    await mkdir(outside);
    const base = { cwd, protectedDirs: [agentDir, join(agentDir, "srt")], protectedFiles: [join(agentDir, "pi-plan-mode.json")] };

    assert.deepEqual(await preparePlanOutputDir({ ...base, configured: undefined }), { ok: true, outputDir: join(cwd, "plans") });
    assert.deepEqual(await preparePlanOutputDir({ ...base, configured: "docs/specs" }), { ok: true, outputDir: join(cwd, "docs", "specs") });
    const escaping = await preparePlanOutputDir({ ...base, configured: "../elsewhere" });
    assert.equal(escaping.ok, false);
    assert.equal(existsSync(join(root, "elsewhere")), false);

    // A symlinked output directory or path component is rejected and nothing is created through it.
    await symlink(outside, join(cwd, "linked"));
    const linked = await preparePlanOutputDir({ ...base, configured: "linked" });
    assert.equal(linked.ok, false);
    assert.match(linked.ok ? "" : linked.reason, /symlink/u);
    const nested = await preparePlanOutputDir({ ...base, configured: "linked/plans" });
    assert.equal(nested.ok, false);
    assert.equal(existsSync(join(outside, "plans")), false);

    // An absolute setting is trusted, but never inside (or containing) the pi agent dir.
    const absolute = join(root, "absolute-plans");
    assert.deepEqual(await preparePlanOutputDir({ ...base, configured: absolute }), { ok: true, outputDir: absolute });
    assert.equal((await preparePlanOutputDir({ ...base, configured: join(agentDir, "plans") })).ok, false);
    assert.equal((await preparePlanOutputDir({ ...base, configured: root })).ok, false);

    // A restored (frozen) directory must be inside the working directory or be the configured absolute dir.
    assert.equal((await preparePlanOutputDir({ ...base, configured: undefined, frozen: join(cwd, "plans") })).ok, true);
    assert.equal((await preparePlanOutputDir({ ...base, configured: undefined, frozen: absolute })).ok, false);
    assert.equal((await preparePlanOutputDir({ ...base, configured: absolute, frozen: absolute })).ok, true);
    assert.equal((await preparePlanOutputDir({ ...base, configured: undefined, frozen: join(cwd, "linked") })).ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("newestPlanMarkdown finds the most recent draft and honors the time floor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-docs-"));
  try {
    assert.equal(await newestPlanMarkdown(directory), undefined);
    const older = join(directory, "a-draft.md");
    const newer = join(directory, "z-draft.md");
    await writeFile(older, "older", { flag: "wx" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const floor = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(newer, "newer", { flag: "wx" });
    assert.equal(await newestPlanMarkdown(directory), newer);
    assert.equal(await newestPlanMarkdown(directory, floor), newer);
    const beforeFloor = await newestPlanMarkdown(directory, floor + 10_000);
    assert.equal(beforeFloor, undefined);
    await writeFile(join(directory, "notes.txt"), "not markdown");
    assert.equal(await newestPlanMarkdown(directory), newer);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("displayPath prefers a relative path and isValidPlanDocPath bounds values", () => {
  assert.equal(displayPath("/repo/plans/a.md", "/repo"), "plans/a.md");
  assert.equal(displayPath("/elsewhere/a.md", "/repo"), "/elsewhere/a.md");
  assert.equal(displayPath(undefined, "/repo"), undefined);
  assert.equal(isValidPlanDocPath("/repo/plans/a.md"), true);
  assert.equal(isValidPlanDocPath(""), false);
  assert.equal(isValidPlanDocPath("a\nb"), false);
  assert.equal(isValidPlanDocPath("x".repeat(5000)), false);
});

test("resolveToolTargetPath mirrors pi's built-in write/edit path resolution", () => {
  assert.equal(resolveToolTargetPath("plans/a.md", "/repo"), "/repo/plans/a.md");
  assert.equal(resolveToolTargetPath("@plans/a.md", "/repo"), "/repo/plans/a.md");
  assert.equal(resolveToolTargetPath("plans/../src/a.ts", "/repo"), "/repo/src/a.ts");
  assert.equal(resolveToolTargetPath("/abs/plans/a.md", "/repo"), "/abs/plans/a.md");
  assert.equal(resolveToolTargetPath("~/plans/a.md", "/repo"), join(homedir(), "plans", "a.md"));
  assert.equal(resolveToolTargetPath("file:///repo/plans/a.md", "/elsewhere"), "/repo/plans/a.md");
  assert.equal(resolveToolTargetPath("plans/a\u00A0b.md", "/repo"), "/repo/plans/a b.md");
});

test("isPathInsidePlanOutputDir admits only real paths inside the output directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-docs-"));
  try {
    const outputDir = join(directory, "plans");
    // The output directory may not exist yet; its nearest existing ancestor anchors the check.
    assert.equal(await isPathInsidePlanOutputDir(join(outputDir, "draft.md"), outputDir), true);
    assert.equal(await isPathInsidePlanOutputDir(join(outputDir, "nested", "draft.md"), outputDir), true);
    assert.equal(await isPathInsidePlanOutputDir(outputDir, outputDir), false);
    assert.equal(await isPathInsidePlanOutputDir(join(directory, "README.md"), outputDir), false);
    assert.equal(await isPathInsidePlanOutputDir(join(directory, "plans-evil", "a.md"), outputDir), false);

    await mkdir(outputDir);
    const outside = join(directory, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "target.md"), "x");
    await symlink(outside, join(outputDir, "linked-dir"));
    await symlink(join(outside, "target.md"), join(outputDir, "linked-file.md"));
    await symlink(join(outside, "missing.md"), join(outputDir, "dangling.md"));
    await symlink(join(outputDir, "real.md"), join(outputDir, "inner-link.md"));
    await writeFile(join(outputDir, "real.md"), "x");
    await link(join(outside, "target.md"), join(outputDir, "hard.md"));
    assert.equal(await isPathInsidePlanOutputDir(join(outputDir, "linked-dir", "a.md"), outputDir), false);
    assert.equal(await isPathInsidePlanOutputDir(join(outputDir, "linked-file.md"), outputDir), false);
    assert.equal(await isPathInsidePlanOutputDir(join(outputDir, "dangling.md"), outputDir), false);
    assert.equal(await isPathInsidePlanOutputDir(join(outputDir, "hard.md"), outputDir), false);
    assert.equal(await isPathInsidePlanOutputDir(join(outputDir, "inner-link.md"), outputDir), true);
    assert.equal(await isPathInsidePlanOutputDir(join(outputDir, "real.md"), outputDir), true);

    // Workflows pass their frozen real output directory (preparePlanOutputDir rejects a symlinked
    // one), so only a write path through an alias that resolves into it is admitted.
    const aliasDir = join(directory, "alias-plans");
    await symlink(outputDir, aliasDir);
    assert.equal(await isPathInsidePlanOutputDir(join(aliasDir, "new.md"), outputDir), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

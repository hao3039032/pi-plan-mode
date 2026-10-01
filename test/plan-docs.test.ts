import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  allocatePlanDocPath,
  displayPath,
  isValidPlanDocPath,
  newestPlanMarkdown,
  planDocFilename,
  planDocSlug,
  resolvePlanOutputDir,
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
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("writePlanDoc creates the output directory and trims content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-docs-"));
  try {
    const path = join(directory, "nested", "plans", "2026-01-05-plan.md");
    await writePlanDoc(path, "# Plan\n\nbody\n\n");
    const { readFile } = await import("node:fs/promises");
    assert.equal(await readFile(path, "utf8"), "# Plan\n\nbody\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
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

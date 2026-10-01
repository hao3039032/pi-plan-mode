import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { createMockContext as createBaseMockContext, createMockPi as createBaseMockPi } from "../../../test/support.js";
import planModeExtension from "../src/plan-mode.js";
import type { SrtRuntimeDiagnosis } from "../src/srt-sandbox.js";

export {
  builtinTool,
  createCustomSelectorHarness,
  driveCustomSelector,
  extensionTool,
} from "../../../test/support.js";

const PLAN_HELPERS = ["plan_mode_question", "plan_mode_complete"];

export function createMockPi(options: Parameters<typeof createBaseMockPi>[0] = {}) {
  return createBaseMockPi({
    ...options,
    activeTools: [...new Set([...(options.activeTools ?? []), ...PLAN_HELPERS])],
  });
}

/** A healthy sandbox diagnosis used by default in tests. */
export const passingSandboxDiagnosis: SrtRuntimeDiagnosis = {
  ok: true,
  platform: "linux",
  srtCommand: "/usr/local/bin/srt",
  missingDependencies: [],
};

/** A diagnosis with srt and every Linux dependency missing. */
export const missingSrtDiagnosis: SrtRuntimeDiagnosis = {
  ok: false,
  platform: "linux",
  missingDependencies: ["srt", "bwrap", "socat", "rg"],
};

// Per-file temp root: holds the injected srt profile dir and serves as TMPDIR, so the private
// scratch dirs of workflows that tests leave active are removed with it instead of piling up in /tmp.
const originalTmpdir = process.env.TMPDIR;
const testTempRoot = mkdtempSync(join(tmpdir(), "pi-plan-mode-test-"));
mkdirSync(join(testTempRoot, "tmp"));
process.env.TMPDIR = join(testTempRoot, "tmp");
/** srt profile directory injected into every test planMode() so tests never write under $HOME. */
export const TEST_SRT_PROFILE_DIR = join(testTempRoot, "srt");
const removeTestTempRoot = () => rmSync(testTempRoot, { recursive: true, force: true });
process.once("exit", removeTestTempRoot);
afterAll(async () => {
  // Let detached restore re-probes and sandbox cleanups started by the last test settle first.
  await new Promise((resolve) => setTimeout(resolve, 50));
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  removeTestTempRoot();
});

/** Default working directory for mock contexts, so Plan workflows write plan docs into the temp root. */
export const TEST_CWD = join(testTempRoot, "cwd");
mkdirSync(TEST_CWD);

export function createMockContext(overrides: Parameters<typeof createBaseMockContext>[0] = {}) {
  return createBaseMockContext({ cwd: TEST_CWD, ...overrides });
}

/** Sandbox dependencies for planMode(): a stubbed probe and a temp profile dir so tests never spawn srt or touch $HOME. */
export function sandboxDeps(diagnosis: SrtRuntimeDiagnosis = passingSandboxDiagnosis) {
  return {
    srtProfileDir: TEST_SRT_PROFILE_DIR,
    diagnoseSandbox: async () => ({ ...diagnosis }) as SrtRuntimeDiagnosis,
    buildSetupGuide: (candidate: SrtRuntimeDiagnosis) => `SRT SETUP GUIDE ${candidate.ok ? "ok" : "missing"}`,
  };
}

/**
 * planMode with a passing sandbox probe by default. Tests that exercise the sandbox gate
 * should call the extension default export directly with sandboxDeps(diagnosis).
 */
export function planMode(
  pi: Parameters<typeof planModeExtension>[0],
  dependencies: Parameters<typeof planModeExtension>[1] = {},
) {
  return planModeExtension(pi, { ...sandboxDeps(), ...dependencies });
}

export default planMode;

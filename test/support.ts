import { createMockPi as createBaseMockPi } from "../../../test/support.js";
import planModeExtension from "../src/plan-mode.js";
import type { SrtRuntimeDiagnosis } from "../src/srt-sandbox.js";

export {
  builtinTool,
  createCustomSelectorHarness,
  createMockContext,
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

/** Sandbox dependencies for planMode(): a stubbed probe so tests never spawn srt. */
export function sandboxDeps(diagnosis: SrtRuntimeDiagnosis = passingSandboxDiagnosis) {
  return {
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

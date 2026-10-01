import assert from "node:assert/strict";
import { test } from "vitest";
import { canSelectToolInPlanMode, classifyPlanModeTool, withRequiredPlanModeTools } from "../src/plan-mode.js";
import { isAutoAdmittedPlanTool } from "../src/tool-policy.js";
import { isPlanOutputWriteToolName, powershellBlockReason, readCommand, readToolPath } from "../src/tool-policy.js";
import { builtinTool, extensionTool } from "./support.js";

test("tool selection allows safe built-ins and non-built-ins only", () => {
  type PlanTool = Parameters<typeof canSelectToolInPlanMode>[0];
  assert.equal(canSelectToolInPlanMode(builtinTool("read") as PlanTool), true);
  assert.equal(canSelectToolInPlanMode(builtinTool("bash") as PlanTool), true);
  assert.equal(canSelectToolInPlanMode(builtinTool("edit") as PlanTool), false);
  assert.equal(canSelectToolInPlanMode(builtinTool("write") as PlanTool), false);
  assert.equal(canSelectToolInPlanMode(builtinTool("powershell") as PlanTool), false);
  assert.equal(canSelectToolInPlanMode(extensionTool("custom") as PlanTool), true);
  assert.equal(canSelectToolInPlanMode(extensionTool("edit") as PlanTool), true);
  assert.deepEqual(withRequiredPlanModeTools(["read", "plan_mode_question", "read"]), [
    "read",
    "plan_mode_question",
    "plan_mode_complete",
  ]);
});

test("classifyPlanModeTool marks bash sandboxed, powershell blocked, readers read-only", () => {
  type PlanTool = Parameters<typeof classifyPlanModeTool>[0];
  assert.equal(classifyPlanModeTool(builtinTool("bash") as PlanTool), "sandboxed");
  assert.equal(classifyPlanModeTool(builtinTool("read") as PlanTool), "read-only");
  assert.equal(classifyPlanModeTool(builtinTool("grep") as PlanTool), "read-only");
  assert.equal(classifyPlanModeTool(builtinTool("powershell") as PlanTool), "blocked");
  assert.equal(classifyPlanModeTool(builtinTool("update_plan") as PlanTool), "session");
  const readOnlyExtension = { ...extensionTool("lsp_diagnostics"), annotations: { readOnlyHint: true } } as PlanTool;
  assert.equal(classifyPlanModeTool(readOnlyExtension), "read-only");
  const mutatingExtension = { ...extensionTool("custom"), annotations: { readOnlyHint: false } } as PlanTool;
  assert.equal(classifyPlanModeTool(mutatingExtension), "user-opt-in");
  const noAnnotations = extensionTool("custom") as PlanTool;
  assert.equal(classifyPlanModeTool(noAnnotations), "user-opt-in");
  assert.equal(isAutoAdmittedPlanTool(builtinTool("update_plan") as PlanTool), true);
  assert.equal(isAutoAdmittedPlanTool(readOnlyExtension), true);
  assert.equal(isAutoAdmittedPlanTool(mutatingExtension), false);
  assert.equal(classifyPlanModeTool(extensionTool("custom") as PlanTool), "user-opt-in");
});

test("readCommand extracts the bash command string from tool input", () => {
  assert.equal(readCommand({ command: "ls -la" }), "ls -la");
  assert.equal(readCommand({}), "");
  assert.equal(readCommand(undefined), "");
  assert.equal(readCommand({ command: 42 }), "");
});

test("plan-output write helpers recognize write/edit and read their path argument", () => {
  assert.equal(isPlanOutputWriteToolName("write"), true);
  assert.equal(isPlanOutputWriteToolName("edit"), true);
  assert.equal(isPlanOutputWriteToolName("bash"), false);
  assert.equal(isPlanOutputWriteToolName("update_plan"), false);
  assert.equal(readToolPath({ path: "plans/a.md", content: "x" }), "plans/a.md");
  assert.equal(readToolPath({ file_path: "plans/a.md" }), undefined);
  assert.equal(readToolPath(undefined), undefined);
});

test("powershellBlockReason explains the v1 bash-only sandbox", () => {
  const reason = powershellBlockReason();
  assert.match(reason, /bash/);
  assert.match(reason, /srt/iu);
});

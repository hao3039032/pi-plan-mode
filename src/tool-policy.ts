import type { ToolInfo } from "@earendil-works/pi-coding-agent";

// Plan-mode exploration is enforced by the Anthropic Sandbox Runtime (SRT) OS sandbox: the bash
// tool runs every command inside a sandboxed process tree, so no command-text allowlist applies.
// PowerShell is blocked in v1 because the SRT wrap covers the bash tool only.
export const SAFE_BUILTIN_PLAN_TOOLS = new Set(["read", "bash", "grep", "find", "ls"]);
export type PlanModeToolPolicy = "read-only" | "sandboxed" | "user-opt-in" | "blocked";

// edit/write stay unselectable for the Plan policy; the tool_call hook admits the built-in
// versions only for targets inside the plan output directory (see isPlanOutputWriteToolName).
const BLOCKED_BUILTIN_TOOLS = new Set(["edit", "write", "powershell"]);
const PLAN_OUTPUT_WRITE_TOOLS = new Set(["edit", "write"]);

export function isBuiltinTool(tool: ToolInfo) {
  return tool.sourceInfo.source === "builtin";
}

export function classifyPlanModeTool(tool: ToolInfo): PlanModeToolPolicy {
  if (!isBuiltinTool(tool)) return "user-opt-in";
  if (BLOCKED_BUILTIN_TOOLS.has(tool.name)) return "blocked";
  if (tool.name === "bash") return "sandboxed";
  return SAFE_BUILTIN_PLAN_TOOLS.has(tool.name) ? "read-only" : "blocked";
}

export function canSelectToolInPlanMode(tool: ToolInfo) {
  return classifyPlanModeTool(tool) !== "blocked";
}

/** Built-in tool names that may write inside the plan output directory during Plan mode. */
export function isPlanOutputWriteToolName(name: string) {
  return PLAN_OUTPUT_WRITE_TOOLS.has(name);
}

/** The `path` argument of the built-in write/edit tools (WriteToolInput / EditToolInput). */
export function readToolPath(input: unknown) {
  const candidate = input as { path?: unknown } | undefined;
  return typeof candidate?.path === "string" ? candidate.path : undefined;
}

export function readCommand(input: unknown) {
  const command = input as { command?: unknown } | undefined;
  return typeof command?.command === "string" ? command.command : "";
}

export function powershellBlockReason() {
  return "Plan mode runs shell commands through the SRT OS sandbox, which covers the bash tool only in this release. Use bash for exploration; PowerShell sandboxing arrives with srt-win support.";
}

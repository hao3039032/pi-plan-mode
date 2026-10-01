import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import {
  canSelectToolInPlanMode,
  classifyPlanModeTool,
  isAutoAdmittedPlanTool,
  isBuiltinTool,
} from "./tool-policy.js";

export function toolNameFromLegacyKey(key: string, tools: ToolInfo[]) {
  const directName = tools.find((tool) => tool.name === key)?.name;
  if (directName) return directName;
  const [name] = key.split("\u001f");
  return tools.find((tool) => tool.name === name) ? name : undefined;
}

export function compareTools(left: ToolInfo, right: ToolInfo) {
  const leftBuiltin = isBuiltinTool(left);
  const rightBuiltin = isBuiltinTool(right);
  if (leftBuiltin !== rightBuiltin) return leftBuiltin ? -1 : 1;
  return left.name.localeCompare(right.name);
}

export function toolPolicyLabel(tool: ToolInfo) {
  const policy = classifyPlanModeTool(tool);
  if (policy === "read-only") return isBuiltinTool(tool) ? "built-in read-only" : `read-only hinted: ${toolSourceLabel(tool)}`;
  if (policy === "sandboxed") return "built-in · SRT-sandboxed shell";
  if (policy === "session") return "built-in session tracker";
  if (policy === "blocked") return "built-in blocked";
  return `user opt-in: ${toolSourceLabel(tool)}`;
}

function toolSourceLabel(tool: ToolInfo) {
  const sourceInfo = tool.sourceInfo;
  const source = `${sourceInfo.scope}/${sourceInfo.source}`;
  return sourceInfo.path ? `${source} ${sourceInfo.path}` : source;
}

export function unique(values: string[]) {
  return Array.from(new Set(values));
}

export function filterAvailableSelectedToolNames(names: string[], tools: ToolInfo[]) {
  const availableNames = new Set(tools.filter(canSelectToolInPlanMode).map((tool) => tool.name));
  return unique(names.filter((name) => availableNames.has(name)));
}

export function defaultPlanModeToolNames(tools: ToolInfo[], configuredNames: string[] | undefined) {
  if (configuredNames !== undefined) return unique(configuredNames);
  // Automatic policy: every harmless tool (sandboxed bash, read-only built-ins and read-only
  // hinted extension/MCP tools, session tools) is admitted without selection.
  return tools.filter((tool) => isAutoAdmittedPlanTool(tool)).map((tool) => tool.name);
}

interface PlanModeToolSelectionSnapshot {
  selectedToolNames?: string[];
  selectedToolKeys?: string[];
  defaultPlanTools?: string[];
}

export function snapshotPlanModeSelectedNames(tools: ToolInfo[], selection: PlanModeToolSelectionSnapshot) {
  const selectedToolNames =
    selection.selectedToolNames ??
    selection.selectedToolKeys
      ?.map((key) => toolNameFromLegacyKey(key, tools))
      .filter((name): name is string => name !== undefined);
  return new Set(
    selectedToolNames === undefined
      ? defaultPlanModeToolNames(tools, selection.defaultPlanTools)
      : unique(selectedToolNames),
  );
}

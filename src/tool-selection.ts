import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit";
import { planModeToolAvailability } from "./tool-availability.js";
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
  if (policy === "blocked") {
    return tool.sourceInfo?.source ? "built-in blocked" : "policy metadata unavailable";
  }
  if (policy === "read-only") {
    return isBuiltinTool(tool) ? "built-in read-only" : `read-only hinted: ${toolSourceLabel(tool)}`;
  }
  if (policy === "sandboxed") return "built-in · SRT-sandboxed shell";
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

/** Sanitized single-line presentation of untrusted tool names (MCP/extension supplied). */
export function terminalToolName(value: string) {
  const safe = sanitizeTerminalText(value).trim() || "(unnamed tool)";
  return safe.length > 120 ? `${safe.slice(0, 119)}…` : safe;
}

/** Search tools that are not active can still run through codemode/deferred nested calls. */
function inactiveToolGuidance(tool: ToolInfo) {
  if (!["grep", "find", "ls"].includes(tool.name)) return undefined;
  return `To enable '${tool.name}' on Pi with defaultTools support, use a full list including '${tool.name}' in this session's Pi settings (preserve existing/default tools), then restart Pi.`;
}

function exposureNote(tool: ToolInfo) {
  if (tool.exposure === "codemode" || tool.exposure === "deferred") return "callable via other tools";
  if (tool.exposure === "model-only") return "model calls only";
  return undefined;
}

export interface PlanModeToolMenuItem {
  name: string;
  label: string;
  description: string;
  searchText: string;
  disabled: boolean;
  disabledReason?: string;
}

/**
 * Unified menu presentation for one tool: sanitized label and description, the Plan policy
 * verdict, an exposure note, and the availability semantics from planModeToolAvailability.
 */
export function planModeToolSelection(
  tool: ToolInfo,
  activeNames: ReadonlySet<string>,
  retained: boolean,
): PlanModeToolMenuItem {
  const selectable = canSelectToolInPlanMode(tool);
  const availability = planModeToolAvailability(tool, activeNames, "selection");
  const active = availability === "available";
  // A blocked policy outranks inactivity (edit/write show blocked in both states).
  const label = !selectable
    ? `${tool.name} — blocked by Plan policy`
    : active
      ? tool.name
      : `${tool.name} — inactive in Pi`;
  const policy = active
    ? toolPolicyLabel(tool)
    : retained
      ? "not active yet; retained for first-request resolution"
      : "not active in this Pi session";
  const note = active ? exposureNote(tool) : undefined;
  const description = [policy, note, tool.description ?? "No description available"]
    .filter((part) => part !== undefined)
    .join(" · ");
  const disabledReason = !selectable
    ? "Blocked by Plan-mode policy"
    : !active
      ? retained
        ? "Not active yet; retained and resolved before the first request"
        : (inactiveToolGuidance(tool) ?? "Not active in Pi; Plan mode will not activate it")
      : undefined;
  return {
    name: tool.name,
    label: terminalToolName(label),
    description: sanitizeTerminalText(description),
    searchText: sanitizeTerminalText([policy, note, description].filter(Boolean).join(" ")),
    disabled: !selectable || !active,
    ...(disabledReason !== undefined ? { disabledReason: sanitizeTerminalText(disabledReason) } : {}),
  };
}

/** Selected names that resolve to a selectable, selection-available tool right now. */
export function filterAvailableSelectedToolNames(
  names: string[],
  tools: ToolInfo[],
  activeNames: ReadonlySet<string>,
) {
  const availableNames = new Set(
    tools
      .filter(
        (tool) =>
          canSelectToolInPlanMode(tool) && planModeToolAvailability(tool, activeNames, "selection") === "available",
      )
      .map((tool) => tool.name),
  );
  return unique(names.filter((name) => availableNames.has(name)));
}

export function defaultPlanModeToolNames(tools: ToolInfo[], configuredNames: string[] | undefined) {
  if (configuredNames !== undefined) return unique(configuredNames);
  // Automatic policy: every harmless tool (sandboxed bash, read-only built-ins and read-only
  // hinted extension/MCP tools) is admitted without selection.
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

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { displayPath, newestPlanMarkdown } from "./plan-docs.js";
import type { PlanModeState } from "./state.js";

const STATUS_KEY = "plan-mode";
const PLAN_WIDGET_KEY = "plan-mode-plan";
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

export function updatePlanModeUi(ctx: ExtensionContext, state: PlanModeState, toolSummary: () => string) {
  ctx.ui.setStatus(STATUS_KEY, formatStatus(state));
  let lines: string[] | undefined;
  if (state.enabled && state.latestPlan) {
    lines = ["Proposed plan ready", "Use /plan to implement, save, revise, or exit Plan mode."];
  } else if (state.enabled) {
    lines = [
      "Plan mode: planning (srt sandbox)",
      toolSummary(),
      "Finish with plan_mode_complete when decision-ready.",
    ];
  } else if (state.savedPlan) {
    lines = ["Plan saved for later", "Use /plan to show, implement, or clear it."];
  } else if (state.activeImplementation) {
    lines = ["Implementation plan active", "Use /plan to show, replace, or clear it."];
  }

  publishPlanModeWidget(ctx, lines);
}

export function renderPlanModeWidget(lines: readonly string[], theme: Theme, width: number): string[] {
  const renderWidth = Math.max(0, width);
  return [
    theme.fg("borderMuted", "─".repeat(renderWidth)),
    ...lines.map((line) => truncateToWidth(sanitizePlanModeWidgetLine(line), renderWidth, "")),
  ];
}

export function sanitizePlanModeWidgetLine(value: string): string {
  let text = "";
  for (const character of stripTerminalSequences(value).replace(BIDI_CONTROLS, "")) {
    const codePoint = character.codePointAt(0) ?? 0;
    const isControl = codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    text += isControl ? " " : character;
  }
  return text;
}

export function clearPlanModeUi(ctx: ExtensionContext) {
  ctx.ui.setStatus(STATUS_KEY, undefined);
  ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined);
}

export async function showStoredPlan(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: PlanModeState,
  options: { planOutputDir?: string; draftSinceMs?: number } = {},
) {
  const readyPlan = state.enabled ? state.latestPlan?.trim() : undefined;
  const savedPlan = state.savedPlan?.plan.trim();
  if (savedPlan && (ctx.mode === "print" || ctx.mode === "json")) {
    throw new Error("Saved plan display is unavailable in print/JSON mode. Use TUI or RPC.");
  }
  const activePlan = state.activeImplementation?.plan.trim();
  let plan = readyPlan ?? savedPlan ?? activePlan;
  let title = readyPlan ? "Proposed Plan" : savedPlan ? "Saved Plan" : "Active Implementation Plan";
  let docPath = readyPlan
    ? state.planDocPath
    : savedPlan
      ? state.savedPlan?.docPath
      : state.activeImplementation?.docPath;
  if (!plan && state.enabled && options.planOutputDir) {
    const draftPath = await newestPlanMarkdown(options.planOutputDir, options.draftSinceMs);
    if (draftPath) {
      plan = (await readTextFile(draftPath))?.trim() || undefined;
      docPath = draftPath;
      title = "Plan Draft";
    }
  }
  if (!plan) {
    ctx.ui.notify("No completed plan is available. Use /plan finalize when planning is complete.", "info");
    return;
  }
  showPlanModePlan(pi, ctx, title, plan, docPath, ctx.cwd);
}

function footerLine(docPath: string | undefined, from: string | undefined) {
  const display = displayPath(docPath, from);
  return display ? `📄 ${display}` : undefined;
}

export function showPlanModePlan(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  title: string,
  plan: string,
  docPath?: string,
  cwd?: string,
) {
  const footer = footerLine(docPath, cwd);
  const content = footer ? `**${title}**\n\n${plan}\n\n---\n${footer}` : `**${title}**\n\n${plan}`;
  try {
    pi.sendMessage(
      {
        customType: "proposed-plan",
        content,
        display: true,
      },
      { triggerTurn: false },
    );
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Unable to show completed plan: ${detail}`, "error");
  }
}

async function readTextFile(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export function planModeStatusText(state: PlanModeState, toolSummary: () => string) {
  if (state.enabled) {
    if (state.latestPlan) {
      return `Plan mode is active and a proposed plan is ready. ${toolSummary()}`;
    }
    return `Plan mode is active. Shell runs in the srt sandbox. ${toolSummary()} Explore, ask, and finish with plan_mode_complete when decision-ready.`;
  }
  if (state.savedPlan) return "A plan is saved for later.";
  if (state.activeImplementation) return "An implementation plan is active.";
  return "Plan mode is off.";
}

function publishPlanModeWidget(ctx: ExtensionContext, lines: readonly string[] | undefined) {
  if (!lines) {
    ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined);
    return;
  }
  if (ctx.mode !== "tui") {
    ctx.ui.setWidget(PLAN_WIDGET_KEY, [...lines]);
    return;
  }

  const snapshot = [...lines];
  ctx.ui.setWidget(PLAN_WIDGET_KEY, (_tui, theme) => ({
    render: (width) => renderPlanModeWidget(snapshot, theme, width),
    invalidate: () => {},
  }));
}

function formatStatus(state: PlanModeState) {
  if (state.enabled) {
    if (state.awaitingAction || state.latestPlan) return "plan ready";
    return "plan active (srt)";
  }
  if (state.savedPlan) return "plan saved";
  if (state.activeImplementation) return "plan implementing";
  return undefined;
}

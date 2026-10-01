import { randomUUID } from "node:crypto";
import { existsSync, watch } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
  type InputEvent,
  type InputSource,
} from "@earendil-works/pi-coding-agent";
import { completePlanArguments } from "./command.js";
import {
  normalizePlanModeCompletion,
  PLAN_MODE_COMPLETE_PARAMS,
  PLAN_MODE_COMPLETE_TOOL_NAME,
  planModeCompleted,
  renderPlanModeCompletion,
} from "./completion-tool.js";
import { isStaleExtensionContextError } from "./extension-runtime.js";
import {
  createFinalizationRequestCoordinator,
  FINALIZE_PLAN_PROMPT,
  type FinalizationRunOutcome,
  RETRY_FINALIZE_PLAN_PROMPT,
} from "./finalization-request.js";
import { createDeferredFreshHandoffCoordinator } from "./fresh-handoff-coordinator.js";
import {
  formatHistoryImplementationPrompt,
  formatImplementationHandoff,
  formatTransferredPlanPrompt,
  startFreshImplementationFromState,
} from "./fresh-implementation.js";
import {
  createImplementationRetentionCoordinator,
  implementationRetentionPreview,
} from "./implementation-retention.js";
import {
  invalidPlanMessage,
  latestAssistantStopReason,
  latestAssistantText,
  messageTextContent,
  parseProposedPlan,
} from "./message-transform.js";
import {
  createModeContractMessage,
  hasModeContractArtifact,
  latestModeContract,
  MODE_CONTRACT_MESSAGE_TYPE,
  type PlanModeContract,
  reconcileModeContract,
} from "./mode-contract.js";
import {
  allocatePlanDocPath,
  displayPath,
  isAtOrUnderPath,
  isPathInsidePlanOutputDir,
  isSafePlanDocTarget,
  newestPlanMarkdown,
  preparePlanOutputDir,
  realpathThroughExistingAncestor,
  resolvePlanOutputDir,
  resolveToolTargetPath,
  writePlanDoc,
} from "./plan-docs.js";
import { createPlanActionController, type FreshImplementationTiming } from "./plan-action-controller.js";
import { createPlanExportController } from "./plan-export-controller.js";
import {
  clearPlanModeUi,
  planModeStatusText as formatPlanModeStatusText,
  showPlanModePlan,
  showStoredPlan,
  updatePlanModeUi,
} from "./presentation.js";
import type { PlanModePromptSandboxInfo } from "./prompt.js";
import {
  answerPlanModeQuestions,
  normalizePlanModeQuestionParams,
  PLAN_MODE_QUESTION_PARAMS,
  PLAN_MODE_QUESTION_TOOL_NAME,
  planModeQuestionCancelled,
} from "./question-tool.js";
import { assertPlanModeHelperToolsAvailable, planModeHelperToolsAvailable } from "./required-tools.js";
import {
  buildPlanSandboxProfile,
  buildSrtSetupGuide,
  createSrtScratchDir,
  DEFAULT_SRT_DENY_READ,
  describeSrtDiagnosis,
  diagnoseSrtRuntime,
  removeSrtProfile,
  removeSrtScratchDir,
  srtProfileSettingsPath,
  type SrtRuntimeDiagnosis,
  type SrtSandboxProfile,
  writeSrtProfile,
  wrapCommandForSrt,
} from "./srt-sandbox.js";
import { preflightSavedPlanImplementation, savedPlanBlocksNewWorkflow } from "./saved-plan-preflight.js";
import {
  awaitPlanModeSettingsWrites,
  configuredImplementationPlanRetention,
  configuredPlanModeToggleShortcut,
  configuredPlanOutputDir,
  configuredPlanSandbox,
  configuredThinkingLevel,
  type ImplementationPlanRetention,
  type PlanModeSettings,
  type PlanModeSettingsPatch,
  legacyPlanModeSettingsPath,
  planModeSettingsPath,
  readPlanModeSettings,
  type UpdatePlanModeSettingsOptions,
  updatePlanModeSettings,
} from "./settings.js";
import {
  type ImplementationRuntimeSelection,
  type PlanCompletionSource,
  type PlanModeSandboxState,
  type PlanModeState,
  type PlanSandboxSnapshot,
  type PlanModeWorkflowToolPolicy,
  restorePlanModeState,
} from "./state.js";
import {
  canSelectToolInPlanMode,
  classifyPlanModeTool,
  isBuiltinTool,
  isPlanOutputWriteToolName,
  powershellBlockReason,
  readCommand,
  readToolPath,
} from "./tool-policy.js";
import { compareTools, snapshotPlanModeSelectedNames, toolPolicyLabel } from "./tool-selection.js";
import { WorkflowMutex, type WorkflowMutexOwner } from "./workflow-mutex.js";

const STATE_ENTRY_TYPE = "plan-mode-state";
const RECOVERED_RUNTIME_ADMISSION_INPUT_MESSAGE_TYPE = "plan-mode-recovered-input";
const BLOCKED_MUTATING_TOOLS = new Set(["edit", "write", "update_plan"]);
/** Subdirectory of the pi agent dir holding srt profiles; never sandbox-writable. */
const SRT_PROFILE_DIR_NAME = "srt";
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
type ActivePlanSandbox = PlanModeSandboxState & PlanSandboxSnapshot & { scratchDir: string };
/** Outcome of creating a workflow sandbox: a verified sandbox or the reason Plan mode cannot use one. */
interface PlanSandboxCreation {
  sandbox?: ActivePlanSandbox;
  diagnosis?: SrtRuntimeDiagnosis;
  error?: unknown;
  /** Set when the plan output directory failed verification (srt itself was not probed). */
  outputDirProblem?: string;
}
/** A restored workflow whose sandbox re-probe failed while an agent run was active. */
interface PendingSandboxLoss {
  sessionManager: ExtensionContext["sessionManager"];
  menuGeneration: number;
  workflowGeneration: number;
  notice: string;
  diagnosis?: SrtRuntimeDiagnosis;
}
interface TrackedPlanCall {
  startedAt: number;
  /** Resolved write/edit target; bash calls scan the output directory instead. */
  target?: string;
}
interface ReadyPresentationIntent {
  nonce: number;
  plan: string;
  source: PlanCompletionSource;
}
interface DeferredFreshImplementation {
  ctx: ExtensionContext;
  sourceSession: object;
  menuGeneration: number;
  workflowGeneration: number;
  workflowOwner: WorkflowMutexOwner | undefined;
  enabled: boolean;
  plan: string;
  source: PlanCompletionSource;
  savedPlan: PlanModeState["savedPlan"];
  retention: ImplementationPlanRetention;
  runtime: ImplementationRuntimeSelection | undefined;
  menuIsCurrent(): boolean;
}
interface PendingWorkflowToolPolicy {
  generation: number;
  mode: "resolve" | "revalidate";
}
type ImplementationRuntimeApplicationResult = "ready" | "blocked" | "stale";
interface ActiveImplementationRuntimeApplication {
  sessionManager: ExtensionContext["sessionManager"];
  completion: Promise<ImplementationRuntimeApplicationResult>;
  drainOnShutdown: boolean;
  holdForAdmission: boolean;
}
interface QueuedRuntimeAdmissionInput {
  sessionManager: ExtensionContext["sessionManager"];
  text: string;
  images?: NonNullable<InputEvent["images"]>;
  source: InputSource;
}
type InteractiveUi = typeof import("./interactive-ui.js");

interface PlanModeDependencies {
  readSettings?(): ReturnType<typeof readPlanModeSettings>;
  updateSettings?(
    patch: PlanModeSettingsPatch,
    options?: UpdatePlanModeSettingsOptions,
  ): ReturnType<typeof updatePlanModeSettings>;
  settingsPath?: string;
  loadInteractiveUi?(): Promise<InteractiveUi>;
  /** Test seam for the srt runtime probe; defaults to the real spawn-based diagnosis. */
  diagnoseSandbox?: typeof diagnoseSrtRuntime;
  buildSetupGuide?: typeof buildSrtSetupGuide;
  /** Directory holding srt profiles; defaults to `<agentDir>/srt`. Tests inject a temp dir. */
  srtProfileDir?: string;
}

// Keep session state, persistence, tool, thinking, and mutex commits in this one closure so an
// activation path cannot bypass the same atomic transition by crossing module-owned state.
export default function planMode(pi: ExtensionAPI, dependencies: PlanModeDependencies = {}) {
  const workflowMutex = new WorkflowMutex(pi);
  let workflowOwner: WorkflowMutexOwner | undefined;
  let currentSession: object | undefined;
  let currentSessionContext: ExtensionContext | undefined;
  let interactiveUiPromise: Promise<InteractiveUi> | undefined;
  const loadInteractiveUi = () => {
    if (dependencies.loadInteractiveUi) return dependencies.loadInteractiveUi();
    if (!interactiveUiPromise) {
      interactiveUiPromise = import("./interactive-ui.js").catch((error) => {
        interactiveUiPromise = undefined;
        throw error;
      });
    }
    return interactiveUiPromise;
  };
  const explicitPlanModeSettingsPath = dependencies.settingsPath;
  let state: PlanModeState = { enabled: false, awaitingAction: false };
  let settings: PlanModeSettings = { thinkingLevel: "inherit" };
  let startupToggleShortcut: ReturnType<typeof configuredPlanModeToggleShortcut>;
  let shortcutInitialized = false;
  let workflowAllowedToolNames: string[] | undefined;
  let pendingWorkflowToolPolicy: PendingWorkflowToolPolicy | undefined;
  let publishedContractMode: PlanModeContract | undefined;
  let modeContractsRelevant = false;
  let readyPresentationIntent: ReadyPresentationIntent | undefined;
  let latestCommandContext: ExtensionCommandContext | undefined;
  let stagedFreshImplementation: DeferredFreshImplementation | undefined;
  const deferredFreshHandoff = createDeferredFreshHandoffCoordinator();
  let nextReadyPresentationNonce = 0;
  let menuGeneration = 0;
  let workflowGeneration = 0;
  let refreshStateBeforeFirstAgentStart = false;
  let activeImplementationRuntimeApplication: ActiveImplementationRuntimeApplication | undefined;
  let pendingRuntimeAdmissionSession: object | undefined;
  let queuedRuntimeAdmissionInputs: QueuedRuntimeAdmissionInput[] = [];
  let menuController = new AbortController();
  let settingsWatch: ReturnType<typeof watch> | undefined;
  let settingsReloadTimer: ReturnType<typeof setTimeout> | undefined;
  // SRT sandbox for the active Plan workflow: set during start (after the runtime probe passes)
  // and mirrored into persisted state. Undefined while idle or while a restored workflow waits
  // for its async re-probe, in which case bash calls fail closed.
  let activeSandbox: ActivePlanSandbox | undefined;
  let planStartInFlight = false;
  let pendingSandboxLoss: PendingSandboxLoss | undefined;
  let workflowStartedAt = 0;
  // Plan-mode bash calls and plan-output write/edit calls keyed by tool call id, used to report
  // Markdown drafts the call created or modified in the plan output directory.
  const trackedPlanCalls = new Map<string, TrackedPlanCall>();
  const implementationRetention = createImplementationRetentionCoordinator();
  const finalizationRequest = createFinalizationRequestCoordinator();
  const persistState = () => pi.appendEntry<PlanModeState>(STATE_ENTRY_TYPE, state);
  const planExports = createPlanExportController({
    getState: () => state,
    getSettings: () => settings,
    finishReady: (ctx) => {
      exitPlanMode(ctx);
    },
  });
  const planActions = createPlanActionController({
    loadInteractiveUi,
    getState: () => state,
    captureLifecycle: captureMenuLifecycle,
    statusText: planStatusText,
    // ExtensionContext.thinkingLevel was added after the supported Pi 0.80.6 floor.
    // ExtensionAPI has exposed the same runtime value throughout that compatibility range.
    getThinkingLevel: () => pi.getThinkingLevel(),
    getSettings: () => settings,
    implementationOutcome,
    getExportDestination: (ctx) => planExports.getDestination(ctx),
    show: (ctx) => {
      void showStoredPlanForCurrentState(ctx);
    },
    finalize: requestFinalPlan,
    implementHere: startImplementation,
    implementFresh: startFreshImplementation,
    exportPlan: exportPlan,
    settings: showSettings,
    save: savePlanForLater,
    stay: updateUi,
    exitReady: (ctx) => {
      if (exitPlanMode(ctx)) {
        ctx.ui.notify("Plan mode disabled. Proposed plan discarded.", "info");
      }
    },
    clearSaved: (ctx) => {
      if (exitPlanMode(ctx)) ctx.ui.notify("Saved plan cleared.", "info");
    },
  });

  pi.registerTool({
    name: PLAN_MODE_QUESTION_TOOL_NAME,
    label: "Plan question",
    description:
      "Ask one to three structured questions only when the latest effective Plan contract explicitly says /plan mode is active. Tool visibility alone does not activate Plan mode. Never call for ordinary planning requests, the writing-plans skill, roadmaps, checklists, or plan-file work.",
    parameters: PLAN_MODE_QUESTION_PARAMS,
    async execute(_toolCallId, params: unknown, _signal, _onUpdate, ctx) {
      if (!state.enabled || !workflowMutex.isOwner(workflowOwner)) {
        return planModeQuestionCancelled(
          [],
          "plan_mode_inactive",
          "Error: plan_mode_question is only available while Plan mode is active.",
        );
      }

      const parsed = normalizePlanModeQuestionParams(params);
      if (!parsed.ok) {
        return planModeQuestionCancelled([], "invalid_input", `Error: ${parsed.error}`);
      }
      finalizationRequest.satisfy();

      if (!ctx.hasUI) {
        return planModeQuestionCancelled(
          parsed.questions,
          "ui_unavailable",
          "Unable to ask Plan-mode questions because interactive UI is not available.",
        );
      }

      const sessionGeneration = menuGeneration;
      const questionWorkflowGeneration = workflowGeneration;
      const questionOwner = workflowOwner;
      return answerPlanModeQuestions(parsed.questions, ctx, {
        isCurrent: () =>
          sessionGeneration === menuGeneration &&
          questionWorkflowGeneration === workflowGeneration &&
          workflowMutex.isOwner(questionOwner),
        isEnabled: () => state.enabled,
      });
    },
  });

  pi.registerTool({
    name: PLAN_MODE_COMPLETE_TOOL_NAME,
    label: "Complete plan",
    description:
      "Submit a decision-ready plan only when the latest effective Plan contract explicitly says /plan mode is active, and call it alone as the final action. Tool visibility alone does not activate Plan mode. Never call for ordinary planning requests, the writing-plans skill, roadmaps, checklists, or plan-file work.",
    parameters: PLAN_MODE_COMPLETE_PARAMS,
    renderResult: renderPlanModeCompletion,
    async execute(_toolCallId, params: unknown, _signal, _onUpdate, ctx) {
      if (!state.enabled || !workflowMutex.isOwner(workflowOwner)) {
        throw new Error("plan_mode_complete is only available while Plan mode is active");
      }
      const parsed = normalizePlanModeCompletion(params);
      if (!parsed.ok) throw new Error(parsed.error);

      await acceptCompletedPlan(parsed.plan, PLAN_MODE_COMPLETE_TOOL_NAME, ctx);
      return planModeCompleted(parsed.plan, state.enabled ? displayPath(state.planDocPath, ctx.cwd) : undefined);
    },
  });

  pi.registerCommand("plan", {
    description: "Enter or manage Codex-like Plan mode",
    getArgumentCompletions: completePlanArguments,
    handler: async (args, ctx) => {
      latestCommandContext = ctx;
      const prompt = args.trim();
      const command = prompt.toLowerCase();
      if (command === "start") {
        if (savedPlanBlocksNewWorkflow(ctx, state.savedPlan !== undefined && !state.enabled)) return;
        if (state.enabled) {
          ctx.ui.notify("Plan mode is already active.", "info");
          return;
        }
        await startPlanWorkflow(ctx);
        return;
      }
      if (command === "show") {
        await showStoredPlanForCurrentState(ctx);
        return;
      }
      if (command === "doctor") {
        await runPlanDoctor(ctx);
        return;
      }
      if (command === "finalize") {
        requestFinalPlan(ctx);
        return;
      }
      if (command === "implement") {
        if (!(state.enabled && state.latestPlan?.trim()) && !state.savedPlan?.plan.trim()) {
          ctx.ui.notify("No completed plan is available to implement.", "warning");
          return;
        }
        await startImplementation(ctx);
        return;
      }
      if (command === "save") {
        savePlanForLater(ctx);
        return;
      }
      if (command === "settings") {
        if (!ctx.hasUI) {
          throw new Error("/plan settings requires TUI or RPC mode and is unavailable here.");
        }
        const lifecycle = captureMenuLifecycle();
        await showSettings(ctx, lifecycle.signal, lifecycle.isCurrent);
        return;
      }
      const exportMatch = /^export(?:\s+([\s\S]+))?$/iu.exec(prompt);
      if (exportMatch) {
        const lifecycle = captureMenuLifecycle();
        await exportPlan(ctx, exportMatch[1], lifecycle.signal, lifecycle.isCurrent);
        return;
      }
      if (command === "exit" || command === "off") {
        const notification = planModeDisableNotification();
        if (exitPlanMode(ctx)) ctx.ui.notify(notification, "info");
        return;
      }
      if (command === "tools") {
        if (savedPlanBlocksNewWorkflow(ctx, state.savedPlan !== undefined && !state.enabled)) return;
        if (state.enabled) {
          const message =
            "Plan-mode tools are locked while Planning is active. Exit Plan mode and choose tools before starting again.";
          if (!ctx.hasUI) throw new Error(message);
          ctx.ui.notify(message, "warning");
          return;
        }
        if (!ctx.hasUI) {
          throw new Error("/plan tools requires TUI or RPC mode and is unavailable here.");
        }
        await showLaunchMenu(ctx, "tools");
        return;
      }
      if (prompt) {
        if (savedPlanBlocksNewWorkflow(ctx, state.savedPlan !== undefined && !state.enabled)) return;
        await startPlanWorkflow(ctx, { prompt });
        return;
      }
      if (!ctx.hasUI) {
        throw new Error(
          "The interactive /plan menu is unavailable in print and JSON modes. Use /plan start or /plan <prompt>.",
        );
      }
      if (!state.enabled) {
        if (state.activeImplementation && ctx.hasUI) {
          await showActivePlanMenu(ctx);
          return;
        }
        if (state.savedPlan) {
          await planActions.showSaved(ctx);
          return;
        }
        await showLaunchMenu(ctx);
        return;
      }
      await planActions.showCurrent(ctx);
    },
  });

  const initializePlanModeShortcut = () => {
    if (shortcutInitialized) return;
    // Pi snapshots registrations when binding the editor. Keep even an unset shortcut stable
    // for this runtime; settings saves and file watches take effect after /reload or restart.
    const shortcut = configuredPlanModeToggleShortcut(settings);
    if (shortcut) {
      pi.registerShortcut(shortcut, {
        description: "Toggle Plan mode",
        handler: (ctx) => togglePlanMode(ctx),
      });
    }
    startupToggleShortcut = shortcut;
    shortcutInitialized = true;
  };

  const readPlanModeRuntimeSettings = async () => {
    return dependencies.readSettings?.() ?? readPlanModeSettings(explicitPlanModeSettingsPath);
  };

  const applyPlanModeSettings = async (
    generation: number,
    ctx: ExtensionContext | undefined,
    showWarnings: boolean,
  ) => {
    const loadedSettings = await readPlanModeRuntimeSettings();
    if (generation !== menuGeneration || menuController.signal.aborted) {
      return undefined;
    }
    settings =
      loadedSettings.kind === "loaded"
        ? loadedSettings.settings
        : ({ thinkingLevel: "inherit" } satisfies PlanModeSettings);
    if (!ctx || !showWarnings) return loadedSettings;
    if (loadedSettings.kind === "invalid") {
      ctx.ui.notify(`pi-plan-mode settings ignored: ${loadedSettings.reason}`, "warning");
    }
    if (loadedSettings.notice) {
      ctx.ui.notify(loadedSettings.notice, "warning");
    }
    return loadedSettings;
  };

  const stopPlanModeSettingsWatch = () => {
    if (settingsReloadTimer) {
      clearTimeout(settingsReloadTimer);
      settingsReloadTimer = undefined;
    }
    settingsWatch?.close();
    settingsWatch = undefined;
  };

  const schedulePlanModeSettingsReload = (generation: number) => {
    if (settingsReloadTimer) {
      clearTimeout(settingsReloadTimer);
      settingsReloadTimer = undefined;
    }
    settingsReloadTimer = setTimeout(() => {
      settingsReloadTimer = undefined;
      void applyPlanModeSettings(generation, currentSessionContext, false);
    }, 75);
  };

  const startPlanModeSettingsWatch = (generation: number) => {
    stopPlanModeSettingsWatch();
    if (dependencies.readSettings) return;
    const pathToWatch = explicitPlanModeSettingsPath ?? planModeSettingsPath();
    try {
      const directory = dirname(pathToWatch);
      const fileName = basename(pathToWatch);
      const watcher = watch(directory, { persistent: false }, (event, changedFile) => {
        if (event !== "rename" && event !== "change") return;
        if (!changedFile || changedFile.toString() !== fileName) return;
        schedulePlanModeSettingsReload(generation);
      });
      watcher.on("error", () => {
        stopPlanModeSettingsWatch();
      });
      settingsWatch = watcher;
    } catch {
      stopPlanModeSettingsWatch();
    }
  };

  pi.on("session_start", async (event, ctx) => {
    cancelDeferredFreshImplementation();
    const generation = ++menuGeneration;
    finalizationRequest.reset();
    currentSession = ctx.sessionManager;
    currentSessionContext = ctx;
    workflowOwner = undefined;
    workflowMutex.bindSession(ctx.sessionManager);
    refreshStateBeforeFirstAgentStart = event.reason === "new";
    pendingRuntimeAdmissionSession = undefined;
    queuedRuntimeAdmissionInputs = [];
    menuController.abort(new DOMException("Plan-mode session replaced", "AbortError"));
    menuController = new AbortController();
    readyPresentationIntent = undefined;
    pendingSandboxLoss = undefined;
    latestCommandContext = undefined;
    workflowAllowedToolNames = undefined;
    pendingWorkflowToolPolicy = undefined;
    implementationRetention.reset();
    settings = { thinkingLevel: "inherit" };
    const branch = ctx.sessionManager.getBranch();
    const restoredState = restorePlanModeState(branch, STATE_ENTRY_TYPE);
    restoreModeContractTracking(branch, restoredState);
    state = { enabled: false, awaitingAction: false };
    await applyPlanModeSettings(generation, ctx, true);
    if (generation !== menuGeneration || menuController.signal.aborted) return;
    initializePlanModeShortcut();
    startPlanModeSettingsWatch(generation);
    if (!installRestoredState(restoredState, ctx)) return;
    implementationRetention.restore(state.activeImplementation);
    updateUi(ctx);
    if (restoredState.enabled) {
      scheduleRestoredSandboxRevalidation(ctx);
    }
    // A new session receives its setup entries after session_start, so its input gate refreshes
    // them. Resumed and forked sessions already have the intent and must apply it here because
    // extension-triggered custom-message turns bypass both input and before_agent_start.
    if (event.reason !== "new") await applyPendingImplementationRuntime(ctx);
  });

  pi.on("session_before_tree", (event, ctx) => {
    if (runtimeAdmissionIsPending(ctx.sessionManager)) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          "Wait for fresh implementation startup to admit the pending prompts before changing branches.",
          "warning",
        );
      }
      return { cancel: true };
    }
    const target = ctx.sessionManager.getEntry(event.preparation.targetId);
    if (target?.type !== "custom_message" || target.customType !== MODE_CONTRACT_MESSAGE_TYPE) {
      return;
    }
    if (ctx.hasUI) {
      ctx.ui.notify(
        "Plan mode transition markers are internal. Select the adjacent conversation entry instead.",
        "warning",
      );
    }
    return { cancel: true };
  });

  pi.on("session_tree", async (_event, ctx) => {
    cancelDeferredFreshImplementation();
    advanceWorkflowGeneration();
    menuGeneration += 1;
    menuController.abort(new DOMException("Plan-mode tree branch changed", "AbortError"));
    menuController = new AbortController();
    readyPresentationIntent = undefined;
    pendingSandboxLoss = undefined;
    latestCommandContext = undefined;
    pendingRuntimeAdmissionSession = undefined;
    queuedRuntimeAdmissionInputs = [];
    implementationRetention.reset();
    const branch = ctx.sessionManager.getBranch();
    const restoredState = restorePlanModeState(branch, STATE_ENTRY_TYPE);
    restoreModeContractTracking(branch, restoredState);
    if (!installRestoredState(restoredState, ctx)) return;
    implementationRetention.restore(state.activeImplementation);
    startPlanModeSettingsWatch(menuGeneration);
    updateUi(ctx);
    if (restoredState.enabled) {
      scheduleRestoredSandboxRevalidation(ctx);
    }
    await applyPendingImplementationRuntime(ctx);
  });

  pi.on("thinking_level_select", (event) => {
    if (!state.enabled || !state.appliedThinkingLevel) return;
    if (event.level !== state.appliedThinkingLevel) {
      state = {
        ...state,
        manualThinkingLevel: event.level,
        previousThinkingLevel: undefined,
        appliedThinkingLevel: undefined,
      };
      persistState();
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    cancelDeferredFreshImplementation();
    const shutdownSession = ctx.sessionManager;
    const runtimeApplication =
      activeImplementationRuntimeApplication?.sessionManager === shutdownSession &&
      activeImplementationRuntimeApplication.drainOnShutdown
        ? activeImplementationRuntimeApplication
        : undefined;
    const queuedInputs = takeQueuedRuntimeAdmissionInputs(shutdownSession);
    for (const queued of queuedInputs) {
      pi.sendMessage(
        {
          customType: RECOVERED_RUNTIME_ADMISSION_INPUT_MESSAGE_TYPE,
          content: runtimeAdmissionInputContent(queued),
          display: true,
          details: { source: queued.source },
        },
        { triggerTurn: false },
      );
    }
    finalizationRequest.reset();
    menuGeneration += 1;
    menuController.abort(new DOMException("Plan-mode session shut down", "AbortError"));
    readyPresentationIntent = undefined;
    pendingSandboxLoss = undefined;
    latestCommandContext = undefined;
    refreshStateBeforeFirstAgentStart = false;
    pendingRuntimeAdmissionSession = undefined;
    queuedRuntimeAdmissionInputs = [];
    workflowAllowedToolNames = undefined;
    pendingWorkflowToolPolicy = undefined;
    implementationRetention.reset();
    trackedPlanCalls.clear();
    void discardActiveSandbox();
    if (runtimeApplication) await runtimeApplication.completion;
    if (currentSession !== undefined && currentSession !== shutdownSession) {
      workflowMutex.unbindSession(shutdownSession);
      return;
    }
    await awaitPlanModeSettingsWrites(dependencies.settingsPath);
    if (currentSession !== undefined && currentSession !== shutdownSession) {
      workflowMutex.unbindSession(shutdownSession);
      return;
    }
    captureManualThinkingLevel();
    persistState();
    if (state.enabled) restoreThinkingLevel();
    stopPlanModeSettingsWatch();
    clearUi(ctx);
    releaseWorkflowOwner();
    workflowMutex.unbindSession(ctx.sessionManager);
    if (currentSession === ctx.sessionManager) {
      currentSession = undefined;
      currentSessionContext = undefined;
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    const requiredHelper =
      event.toolName === PLAN_MODE_QUESTION_TOOL_NAME || event.toolName === PLAN_MODE_COMPLETE_TOOL_NAME;
    if (!state.enabled) {
      if (!requiredHelper) return;
      return {
        block: true,
        reason: `${event.toolName} is only available while Plan mode is active.`,
      };
    }
    if (!workflowMutex.isOwner(workflowOwner)) {
      return {
        block: true,
        reason: `Plan mode blocks tool '${event.toolName}' because workflow ownership is unavailable.`,
      };
    }
    if (isPlanOutputWriteToolName(event.toolName)) {
      const target = await planOutputWriteTarget(event.toolName, event.input, ctx);
      if (target !== undefined) {
        trackPlanCall(event.toolCallId, target);
        return;
      }
    }
    if (BLOCKED_MUTATING_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason:
          event.toolName === "update_plan"
            ? "Plan mode blocks update_plan because it tracks execution progress rather than conversational planning."
            : `Plan mode blocks mutating tool '${event.toolName}'.`,
      };
    }
    if (event.toolName === "powershell") {
      return {
        block: true,
        reason: powershellBlockReason(),
      };
    }
    if (requiredHelper) return;

    const calledTool = toolByName(event.toolName);
    const activeToolNames = new Set(safeGetActiveTools());
    if (!calledTool) {
      return {
        block: true,
        reason: activeToolNames.has(event.toolName)
          ? `Plan mode blocks tool '${event.toolName}' because its safe policy metadata is unavailable.`
          : `Plan mode blocks tool '${event.toolName}' because it is not registered or active. Register and activate it before starting the next Plan workflow.`,
      };
    }
    if (classifyPlanModeTool(calledTool) === "blocked") {
      return {
        block: true,
        reason: `Plan mode blocks tool '${event.toolName}' because its built-in policy is blocked and settings cannot enable it.`,
      };
    }
    const allowedToolNames = new Set(planModePolicyToolNames());
    if (!activeToolNames.has(event.toolName)) {
      return {
        block: true,
        reason: allowedToolNames.has(event.toolName)
          ? `Plan mode blocks tool '${event.toolName}' because it was admitted to the active Plan workflow but is currently inactive. Reactivate it to continue without restarting.`
          : `Plan mode blocks tool '${event.toolName}' because it is registered but inactive. Activate it before starting the next Plan workflow.`,
      };
    }
    if (!allowedToolNames.has(event.toolName) && !admitLateActivatedExplicitTool(event.toolName, ctx)) {
      return {
        block: true,
        reason: workflowDesiredToolNames().has(event.toolName)
          ? `Plan mode blocks tool '${event.toolName}' because it was not available when the active Plan workflow froze its tool policy. Exit Plan mode, then start again after the tool is active.`
          : `Plan mode blocks tool '${event.toolName}' because it is not selected by the Plan policy. Exit Plan mode, then enable it with /plan tools or defaultPlanTools before starting again.`,
      };
    }
    if (event.toolName === "bash") {
      const sandbox = activeSandbox;
      if (!sandbox) {
        return {
          block: true,
          reason:
            "Plan mode runs shell commands only inside the srt OS sandbox, and the sandbox is not active in this workflow. Restart with /plan start (or run /plan doctor) once the sandbox is ready.",
        };
      }
      const command = readCommand(event.input);
      const wrapped = wrapCommandForSrt(command, sandbox.srtPath, sandbox.settingsPath, sandbox.scratchDir);
      if (wrapped === undefined) {
        return {
          block: true,
          reason: "Plan mode could not wrap this bash command for the srt sandbox (it contains characters no shell can carry).",
        };
      }
      trackPlanCall(event.toolCallId);
      (event.input as Record<string, unknown>).command = wrapped;
    }
  });

  pi.on("message_start", (event) => {
    if (
      state.enabled &&
      event.message.role === "user" &&
      messageTextContent(event.message).trim() === FINALIZE_PLAN_PROMPT
    ) {
      finalizationRequest.request(workflowGeneration);
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!state.enabled) return;
    const tracked = takeTrackedPlanCall(event.toolCallId);
    const annotations: string[] = [];
    if (event.toolName === "bash" && bashContentLooksLikeSandboxDenial(event.content)) {
      annotations.push(
        "ℹ️ Plan-mode sandbox: this failure is the sandbox boundary (read-only filesystem or restricted network). Do not retry the same operation with different syntax.",
      );
    }
    if (tracked) {
      const draft =
        tracked.target !== undefined
          ? event.isError
            ? undefined
            : planDraftDisplay(tracked.target, ctx.cwd)
          : await detectPlanDraftUpdate(tracked.startedAt, ctx.cwd);
      if (draft) annotations.push(`📄 Plan draft updated → ${draft} (/plan show to view)`);
    }
    if (annotations.length === 0) return;
    return { content: [...event.content, { type: "text" as const, text: annotations.join("\n") }] };
  });

  pi.on("context", async (event, ctx) => {
    resolvePendingWorkflowToolPolicy(ctx);
    const result = implementationRetention.transformContext(event.messages, state);
    if (result.clearActiveImplementationId) {
      clearActiveImplementation(result.clearActiveImplementationId, ctx);
    }
    const messages =
      state.enabled || modeContractsRelevant
        ? reconcileModeContract(
            result.messages,
            state.enabled ? "plan" : "normal",
            state.enabled ? workflowPromptSandboxInfo() : undefined,
          )
        : result.messages;
    return { messages: messages as typeof event.messages };
  });

  pi.on("input", async (event, ctx) => {
    refreshStateForFirstPrompt(ctx);
    const waitsForRuntimeAdmission =
      activeImplementationRuntimeApplication?.sessionManager === ctx.sessionManager ||
      pendingRuntimeAdmissionSession === ctx.sessionManager;
    const queuedInput = waitsForRuntimeAdmission
      ? {
          sessionManager: ctx.sessionManager,
          text: event.text,
          ...(event.images ? { images: [...event.images] } : {}),
          source: event.source,
        }
      : undefined;
    if (queuedInput) queuedRuntimeAdmissionInputs.push(queuedInput);
    const result = await applyPendingImplementationRuntime(ctx, true);
    if (result !== "ready") {
      if (result === "stale" && queuedInput) removeQueuedRuntimeAdmissionInput(queuedInput);
      return { action: "handled" };
    }
    if (queuedInput) return { action: "handled" };
  });

  pi.on("agent_start", (_event, ctx) => {
    if (currentSession !== ctx.sessionManager) return;
    if (pendingRuntimeAdmissionSession === ctx.sessionManager) {
      pendingRuntimeAdmissionSession = undefined;
    }
    const queuedInputs = takeQueuedRuntimeAdmissionInputs(ctx.sessionManager);
    for (const queued of queuedInputs) {
      pi.sendUserMessage(runtimeAdmissionInputContent(queued), {
        deliverAs: "followUp",
        expandPromptTemplates: queued.source !== "extension",
      });
    }
  });

  pi.on("before_agent_start", (_event, ctx) => {
    refreshStateForFirstPrompt(ctx);
    if (!state.enabled || !workflowMutex.isOwner(workflowOwner)) return;
    if (state.latestPlan || state.awaitingAction) {
      cancelDeferredFreshImplementation();
      readyPresentationIntent = undefined;
      state = {
        ...state,
        latestPlan: undefined,
        latestPlanSource: undefined,
        awaitingAction: false,
      };
      persistState();
      updateUi(ctx);
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!state.enabled || !workflowMutex.isOwner(workflowOwner)) return;

    const text = latestAssistantText(event.messages);
    const parsedPlan = parseProposedPlan(text);
    if (parsedPlan.kind !== "valid") {
      finalizationRequest.observeRunEnd(workflowGeneration, finalizationRunOutcome(event.messages));
      if (parsedPlan.kind !== "absent") {
        ctx.ui.notify(invalidPlanMessage(parsedPlan.kind), "warning");
      }
      persistState();
      updateUi(ctx);
      return;
    }
    await acceptCompletedPlan(parsedPlan.plan, "legacy_proposed_plan", ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const settledImplementationId = implementationRetention.implementationSettled(state.activeImplementation);
    if (settledImplementationId) clearActiveImplementation(settledImplementationId, ctx);

    const loss = pendingSandboxLoss;
    if (loss) {
      if (!sandboxLossIsCurrent(loss)) {
        pendingSandboxLoss = undefined;
      } else {
        // The workflow is ending: skip finalization retries and ready presentation for it.
        if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
        pendingSandboxLoss = undefined;
        try {
          completeSandboxLoss(ctx, loss);
        } catch (error: unknown) {
          reportDetachedSandboxFailure(ctx, error);
        }
        return;
      }
    }

    if (finalizationRequest.hasPendingRequest() && state.enabled && workflowMutex.isOwner(workflowOwner)) {
      if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
      const action = finalizationRequest.settle(workflowGeneration);
      if (action === "retry") {
        if (sendPlanModeUserMessage(RETRY_FINALIZE_PLAN_PROMPT, ctx)) return;
        finalizationRequest.reset();
      }
      if (action === "failed") {
        ctx.ui.notify(
          "Plan finalization ended twice without a structured question or completed plan. Plan mode remains active; revise the plan or run /plan finalize again.",
          "warning",
        );
      }
    }

    const intent = readyPresentationIntent;
    if (!intent || !readyPresentationIsCurrent(intent)) return;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

    readyPresentationIntent = undefined;
    stagedFreshImplementation = undefined;
    try {
      if (intent.source === "legacy_proposed_plan") {
        showPlanModePlan(pi, ctx, "Proposed Plan", intent.plan, state.planDocPath, ctx.cwd);
      }
      if (ctx.hasUI && completedPlanIsCurrent(intent)) {
        await planActions.showReady(latestCommandContext ?? ctx);
      }
      const request = stagedFreshImplementation;
      stagedFreshImplementation = undefined;
      if (request) armDeferredFreshImplementation(request);
    } catch (error: unknown) {
      stagedFreshImplementation = undefined;
      if (!isStaleExtensionContextError(error)) throw error;
    }
  });

  function enterPlanMode(
    ctx: ExtensionContext,
    candidate: Pick<PlanModeState, "selectedToolNames" | "selectedToolKeys"> = state,
  ) {
    if (!state.enabled && !allowModeTransition(ctx, "start Plan mode")) return false;
    bindWorkflowSessionIfNeeded(ctx);
    if (state.enabled) return workflowMutex.isOwner(workflowOwner);
    if (!activeSandbox) {
      const message = "Cannot start Plan mode without a verified srt sandbox. Start again through /plan start so the sandbox probe runs.";
      if (!ctx.hasUI) throw new Error(message);
      ctx.ui.notify(message, "error");
      return false;
    }
    const owner = workflowMutex.acquire();
    if (!owner) return reportWorkflowBusy(ctx);
    workflowOwner = owner;

    const previousState = state;
    try {
      assertPlanModeHelperToolsAvailable(safeGetActiveTools());
      if (!publishModeContract("plan", ctx)) {
        releaseWorkflowOwner();
        return false;
      }
    } catch (error: unknown) {
      releaseWorkflowOwner();
      return reportHelperActivationFailure(ctx, error);
    }
    advanceWorkflowGeneration();
    workflowStartedAt = Date.now();
    try {
      modeContractsRelevant = true;
      state = {
        ...state,
        enabled: true,
        awaitingAction: false,
        savedPlan: undefined,
        activeImplementation: undefined,
        pendingImplementationRuntime: undefined,
        selectedToolNames: candidate.selectedToolNames,
        selectedToolKeys: candidate.selectedToolKeys,
        sandbox: { ...activeSandbox },
        planDocPath: undefined,
      };
      beginWorkflowToolPolicy();
      applyPlanThinkingLevel();
      persistState();
      updateUi(ctx);
      // The workflow started from this session's live state; a first prompt after /new must not
      // re-install the branch state and re-probe a sandbox that was just verified.
      refreshStateBeforeFirstAgentStart = false;
      return true;
    } catch (error: unknown) {
      rollbackNewActivation(previousState, ctx);
      throw error;
    }
  }

  /**
   * Gated Plan-mode start: probe the srt runtime, persist the sandbox profile, and only then
   * activate Plan mode. When the sandbox is unavailable the workflow does not start; instead an
   * agent-facing setup guide is injected (with the prompt stashed for the next successful start).
   */
  async function startPlanWorkflow(
    ctx: ExtensionContext,
    options: { prompt?: string; candidate?: Pick<PlanModeState, "selectedToolNames" | "selectedToolKeys"> } = {},
  ) {
    if (state.enabled) {
      if (options.prompt) {
        sendPlanModeUserMessage(options.prompt, ctx);
      } else {
        ctx.ui.notify("Plan mode is already active.", "info");
      }
      return;
    }
    if (planStartInFlight) {
      ctx.ui.notify("Plan mode is already starting; wait for the sandbox check to finish.", "info");
      return;
    }
    // Reject a busy run before spending time on the sandbox probe so atomic-start guarantees
    // (workflow mutex, busy notifications) stay synchronous for callers.
    if (!allowModeTransition(ctx, "start Plan mode")) return;
    planStartInFlight = true;
    try {
      await startPlanWorkflowWithSandbox(ctx, options);
    } finally {
      planStartInFlight = false;
    }
  }

  async function startPlanWorkflowWithSandbox(
    ctx: ExtensionContext,
    options: { prompt?: string; candidate?: Pick<PlanModeState, "selectedToolNames" | "selectedToolKeys"> },
  ) {
    const startSession = currentSession;
    const startMenuGeneration = menuGeneration;
    const startWorkflowGeneration = workflowGeneration;
    const isCurrent = () =>
      currentSession === startSession &&
      menuGeneration === startMenuGeneration &&
      workflowGeneration === startWorkflowGeneration &&
      !state.enabled;
    await discardActiveSandbox();
    const result = await createVerifiedSandbox(ctx);
    if (!isCurrent()) {
      await removeSandboxFiles(result.sandbox);
      return;
    }
    const sandbox = result.sandbox;
    if (!sandbox) {
      reportSandboxStartFailure(result, ctx);
      if (options.prompt) {
        state = { ...state, pendingPlanPrompt: options.prompt };
        persistState();
      }
      return;
    }
    activeSandbox = sandbox;
    const previousState = state;
    const previousOwner = workflowOwner;
    let entered = false;
    try {
      entered = enterPlanMode(ctx, options.candidate ?? state);
    } finally {
      if (!entered) await discardSandbox(sandbox);
    }
    if (!entered) return;
    ctx.ui.notify("Plan mode enabled. Shell runs in the srt sandbox; I will explore and plan, not modify files.", "info");
    const prompt = options.prompt ?? state.pendingPlanPrompt;
    if (!prompt) return;
    state = { ...state, pendingPlanPrompt: undefined };
    persistState();
    if (sendPlanModeUserMessage(prompt, ctx)) return;
    rollbackNewActivation(previousState, ctx, previousOwner);
    await discardSandbox(sandbox);
    state = { ...state, pendingPlanPrompt: prompt };
    persistState();
  }

  function exitPlanMode(ctx: ExtensionContext) {
    if (!allowModeTransition(ctx, "leave or clear Plan mode")) return false;
    return leavePlanMode(ctx);
  }

  /** Leave or clear Plan mode; callers have already checked that a mode transition is allowed. */
  function leavePlanMode(ctx: ExtensionContext) {
    const wasEnabled = state.enabled;
    if ((wasEnabled || modeContractsRelevant) && !publishModeContract("normal", ctx)) {
      return false;
    }
    advanceWorkflowGeneration();
    readyPresentationIntent = undefined;
    workflowAllowedToolNames = undefined;
    void discardActiveSandbox();
    state = {
      ...state,
      enabled: false,
      latestPlan: undefined,
      latestPlanSource: undefined,
      awaitingAction: false,
      savedPlan: undefined,
      activeImplementation: undefined,
      pendingImplementationRuntime: undefined,
      workflowToolPolicy: undefined,
      sandbox: undefined,
      planDocPath: undefined,
      pendingPlanPrompt: undefined,
      manualThinkingLevel: undefined,
    };
    if (wasEnabled) {
      restoreThinkingLevel();
      state = { ...state, manualThinkingLevel: undefined };
    }
    persistState();
    updateUi(ctx);
    if (wasEnabled) releaseWorkflowOwner();
    return true;
  }

  function restoreModeContractTracking(branch: unknown[], restoredState: PlanModeState) {
    publishedContractMode = latestModeContract(branch)?.mode;
    modeContractsRelevant =
      hasModeContractArtifact(branch) ||
      restoredState.enabled ||
      restoredState.savedPlan !== undefined ||
      restoredState.activeImplementation !== undefined ||
      restoredState.pendingImplementationRuntime !== undefined;
  }

  function publishModeContract(mode: PlanModeContract, ctx: ExtensionContext) {
    if (publishedContractMode === mode) return true;
    const { role: _role, timestamp: _timestamp, ...message } = createModeContractMessage(
      mode,
      Date.now(),
      mode === "plan" ? workflowPromptSandboxInfo() : undefined,
    );
    try {
      pi.sendMessage(message, { triggerTurn: false });
      publishedContractMode = mode;
      modeContractsRelevant = true;
      return true;
    } catch (error: unknown) {
      const detail = safeTerminalText(error instanceof Error ? error.message : String(error));
      const notification = `Unable to publish the ${mode === "plan" ? "Plan" : "Normal"} mode contract: ${detail}`;
      if (!ctx.hasUI) throw new Error(notification, { cause: error });
      ctx.ui.notify(notification, "error");
      return false;
    }
  }

  function sendPlanModeUserMessage(message: string, ctx: ExtensionContext) {
    try {
      if (ctx.isIdle()) pi.sendUserMessage(message);
      else pi.sendUserMessage(message, { deliverAs: "followUp" });
      return true;
    } catch (error: unknown) {
      const detail = safeTerminalText(error instanceof Error ? error.message : String(error));
      ctx.ui.notify(`Unable to send Plan-mode message: ${detail}`, "error");
      return false;
    }
  }

  function srtProfileDir() {
    return dependencies.srtProfileDir ?? join(getAgentDir(), SRT_PROFILE_DIR_NAME);
  }

  function planModeSettingsFiles() {
    return explicitPlanModeSettingsPath
      ? [explicitPlanModeSettingsPath]
      : [planModeSettingsPath(), legacyPlanModeSettingsPath()];
  }

  /**
   * Paths no Plan workflow may write: the whole pi agent dir (sessions, settings, srt profiles),
   * the srt profile dir (which a test seam may move), and the pi-plan-mode settings files.
   */
  function protectedPlanModePaths() {
    return { dirs: [getAgentDir(), srtProfileDir()], files: planModeSettingsFiles() };
  }

  /**
   * srt profile for a workflow snapshot: writes only in the frozen plan output directory, the
   * workflow's private scratch directory, and the frozen planSandbox extras; protected paths are
   * always write-denied (srt gives denyWrite precedence over allowWrite).
   */
  function sandboxProfileFor(snapshot: PlanSandboxSnapshot, scratchDir?: string): SrtSandboxProfile {
    const { dirs, files } = protectedPlanModePaths();
    return buildPlanSandboxProfile({
      outputDir: snapshot.outputDir,
      ...(scratchDir ? { scratchDir } : {}),
      profileDir: srtProfileDir(),
      protectedPaths: [...dirs, ...files],
      allowWrite: snapshot.allowWrite,
      denyRead: snapshot.denyRead,
      allowedDomains: snapshot.allowedDomains,
    });
  }

  function promptSandboxInfoFor(snapshot: PlanSandboxSnapshot): PlanModePromptSandboxInfo {
    const profile = sandboxProfileFor(snapshot);
    return {
      writePaths: profile.allowWrite,
      planOutputDir: snapshot.outputDir,
      allowedDomains: profile.allowedDomains,
    };
  }

  /** The active workflow's frozen sandbox boundary, also while a restored workflow awaits its re-probe. */
  function workflowSandboxSnapshot(): PlanSandboxSnapshot | undefined {
    if (activeSandbox) return activeSandbox;
    const persisted = state.enabled ? state.sandbox : undefined;
    if (!persisted?.outputDir || !persisted.allowWrite || !persisted.denyRead || !persisted.allowedDomains) {
      return undefined;
    }
    return {
      outputDir: persisted.outputDir,
      allowWrite: persisted.allowWrite,
      denyRead: persisted.denyRead,
      allowedDomains: persisted.allowedDomains,
    };
  }

  function workflowPromptSandboxInfo() {
    const snapshot = workflowSandboxSnapshot();
    return snapshot ? promptSandboxInfoFor(snapshot) : undefined;
  }

  /** Verified real plan output directory of the active workflow; undefined until its sandbox is verified. */
  function workflowOutputDir() {
    return state.enabled ? activeSandbox?.outputDir : undefined;
  }

  function currentSandboxExtras(): Omit<PlanSandboxSnapshot, "outputDir"> {
    const configured = configuredPlanSandbox(settings);
    return {
      allowWrite: [...(configured.allowWrite ?? [])],
      denyRead: [...(configured.denyRead ?? [])],
      allowedDomains: [...(configured.allowedDomains ?? [])],
    };
  }

  /**
   * Restored session data never widens the sandbox: frozen allowWrite/allowedDomains must be subsets
   * of the current settings and the frozen denyRead must cover the current one (defaults included);
   * otherwise the current settings apply.
   */
  function restorableSandboxExtras(restored: PlanModeSandboxState | undefined) {
    const current = currentSandboxExtras();
    if (!restored?.allowWrite || !restored.denyRead || !restored.allowedDomains) return current;
    const currentAllowWrite = new Set(current.allowWrite);
    const currentDomains = new Set(current.allowedDomains);
    const restoredDenyRead = new Set([...DEFAULT_SRT_DENY_READ, ...restored.denyRead]);
    const noWider =
      restored.allowWrite.every((path) => currentAllowWrite.has(path)) &&
      restored.allowedDomains.every((domain) => currentDomains.has(domain)) &&
      [...DEFAULT_SRT_DENY_READ, ...current.denyRead].every((path) => restoredDenyRead.has(path));
    return noWider
      ? {
          allowWrite: [...restored.allowWrite],
          denyRead: [...restored.denyRead],
          allowedDomains: [...restored.allowedDomains],
        }
      : current;
  }

  /** Create the scratch dir and profile, probe srt, and return the sandbox; nothing is left behind on failure. */
  async function createVerifiedSandbox(
    ctx: ExtensionContext,
    restored?: PlanModeSandboxState,
  ): Promise<PlanSandboxCreation> {
    const { dirs, files } = protectedPlanModePaths();
    const resolution = await preparePlanOutputDir({
      cwd: ctx.cwd ?? process.cwd(),
      configured: configuredPlanOutputDir(settings),
      ...(restored?.outputDir ? { frozen: restored.outputDir } : {}),
      protectedDirs: dirs,
      protectedFiles: files,
    });
    if (!resolution.ok) return { outputDirProblem: resolution.reason };
    const snapshot: PlanSandboxSnapshot = {
      outputDir: resolution.outputDir,
      ...(restored ? restorableSandboxExtras(restored) : currentSandboxExtras()),
    };
    let scratchDir: string | undefined;
    const settingsPath = srtProfileSettingsPath(srtProfileDir(), randomUUID());
    let diagnosis: SrtRuntimeDiagnosis;
    try {
      scratchDir = await createSrtScratchDir();
      await writeSrtProfile(settingsPath, sandboxProfileFor(snapshot, scratchDir));
      diagnosis = await runSandboxDiagnosis(settingsPath);
    } catch (error: unknown) {
      await removeSandboxFiles({ settingsPath, scratchDir });
      return { error };
    }
    if (diagnosis.ok && diagnosis.srtCommand && scratchDir) {
      return { sandbox: { ...snapshot, srtPath: diagnosis.srtCommand, settingsPath, scratchDir }, diagnosis };
    }
    await removeSandboxFiles({ settingsPath, scratchDir });
    return { diagnosis };
  }

  /** Remove a sandbox's profile and scratch dir; paths this extension did not create are ignored. */
  async function removeSandboxFiles(sandbox: Partial<PlanModeSandboxState> | undefined) {
    await removeSrtProfile(sandbox?.settingsPath, srtProfileDir());
    await removeSrtScratchDir(sandbox?.scratchDir);
  }

  /** Report why a new workflow has no sandbox: output-dir and profile failures fail closed; srt problems get the setup guide. */
  function reportSandboxStartFailure(result: PlanSandboxCreation, ctx: ExtensionContext) {
    if (result.outputDirProblem !== undefined) {
      const message = `Plan mode cannot start: ${safeTerminalText(result.outputDirProblem)}. Plan documents must stay in a real directory inside the working directory (or an absolute planOutputDir); fix the path, then run /plan start again.`;
      if (!ctx.hasUI) throw new Error(message);
      ctx.ui.notify(message, "error");
      return;
    }
    if (result.error !== undefined) {
      const message = `Plan mode could not persist its srt sandbox profile: ${terminalErrorDetail(result.error)}`;
      if (!ctx.hasUI) throw new Error(message);
      ctx.ui.notify(message, "error");
      return;
    }
    if (result.diagnosis) injectSrtSetupGuide(result.diagnosis, ctx);
  }

  async function discardActiveSandbox() {
    const previous = activeSandbox;
    activeSandbox = undefined;
    trackedPlanCalls.clear();
    await removeSandboxFiles(previous);
  }

  /** Discard one specific sandbox, clearing it from the workflow only if it is still the active one. */
  async function discardSandbox(sandbox: ActivePlanSandbox) {
    if (activeSandbox === sandbox) {
      activeSandbox = undefined;
      trackedPlanCalls.clear();
    }
    await removeSandboxFiles(sandbox);
  }

  function runSandboxDiagnosis(settingsPath: string) {
    const diagnose = dependencies.diagnoseSandbox ?? diagnoseSrtRuntime;
    return diagnose({ settingsPath });
  }

  /** Deliver the sandbox setup guide: as an agent turn when interactive, as an error otherwise. */
  function injectSrtSetupGuide(diagnosis: SrtRuntimeDiagnosis, ctx: ExtensionContext) {
    const summary = describeSrtDiagnosis(diagnosis);
    const guide = (dependencies.buildSetupGuide ?? buildSrtSetupGuide)(diagnosis);
    let sent = false;
    try {
      if (ctx.isIdle()) pi.sendUserMessage(guide);
      else pi.sendUserMessage(guide, { deliverAs: "followUp" });
      sent = true;
    } catch {
      sent = false;
    }
    if (sent) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          "Plan mode requires the srt sandbox, which is unavailable. A setup guide was sent; approve the install commands, then run /plan start again.",
          "warning",
        );
      }
      return;
    }
    const message = `Plan mode cannot start: ${summary}. Install the Anthropic Sandbox Runtime (npm install -g @anthropic-ai/sandbox-runtime) and its platform dependencies, then retry; run /plan doctor for details.`;
    if (!ctx.hasUI) throw new Error(message);
    ctx.ui.notify(message, "warning");
  }

  /** Re-probe a restored workflow's sandbox off the event path; failures never become unhandled rejections. */
  function scheduleRestoredSandboxRevalidation(ctx: ExtensionContext) {
    void revalidateRestoredSandbox(ctx).catch((error: unknown) => reportDetachedSandboxFailure(ctx, error));
  }

  function reportDetachedSandboxFailure(ctx: ExtensionContext, error: unknown) {
    if (isStaleExtensionContextError(error)) return;
    try {
      if (ctx.hasUI) ctx.ui.notify(`Plan-mode sandbox check failed: ${terminalErrorDetail(error)}`, "error");
    } catch {
      // The context can become stale while a detached re-probe settles.
    }
  }

  /** Re-probe a restored workflow's sandbox; leave Plan mode (with the setup guide for srt problems) when it fails. */
  async function revalidateRestoredSandbox(ctx: ExtensionContext) {
    if (!state.enabled) return;
    const session = ctx.sessionManager;
    const sessionGeneration = menuGeneration;
    const planWorkflowGeneration = workflowGeneration;
    const restored = state.sandbox;
    const isCurrent = () =>
      currentSession === session &&
      sessionGeneration === menuGeneration &&
      planWorkflowGeneration === workflowGeneration &&
      state.enabled;
    const result = await createVerifiedSandbox(ctx, restored);
    if (!isCurrent()) {
      await removeSandboxFiles(result.sandbox);
      return;
    }
    const sandbox = result.sandbox;
    if (sandbox) {
      // Install synchronously so no await separates the currency check from the commit.
      activeSandbox = sandbox;
      const planDocPath =
        state.planDocPath && dirname(state.planDocPath) === sandbox.outputDir ? state.planDocPath : undefined;
      state = { ...state, sandbox: { ...sandbox }, planDocPath };
      persistState();
      // The restored profile and scratch dir are no longer referenced by the workflow.
      if (restored && restored.settingsPath !== sandbox.settingsPath) await removeSandboxFiles(restored);
      return;
    }
    activeSandbox = undefined;
    // The restored profile and scratch dir belong to a workflow that is being left.
    await removeSandboxFiles(restored);
    if (!isCurrent()) return;
    const notice =
      result.outputDirProblem !== undefined
        ? `Leaving Plan mode: ${safeTerminalText(result.outputDirProblem)}.`
        : result.diagnosis
          ? "Leaving Plan mode: the srt sandbox is unavailable in this environment."
          : `Leaving Plan mode: could not persist the srt sandbox profile: ${terminalErrorDetail(result.error)}`;
    const loss: PendingSandboxLoss = {
      sessionManager: session,
      menuGeneration,
      workflowGeneration,
      notice,
      ...(result.diagnosis ? { diagnosis: result.diagnosis } : {}),
    };
    if (!ctx.isIdle()) {
      // Mode transitions are refused during a run; finish leaving once the run settles.
      pendingSandboxLoss = loss;
      return;
    }
    completeSandboxLoss(ctx, loss);
  }

  function sandboxLossIsCurrent(loss: PendingSandboxLoss) {
    return (
      state.enabled &&
      currentSession === loss.sessionManager &&
      menuGeneration === loss.menuGeneration &&
      workflowGeneration === loss.workflowGeneration
    );
  }

  /** Leave a restored workflow whose sandbox is lost; only called while the session is idle. */
  function completeSandboxLoss(ctx: ExtensionContext, loss: PendingSandboxLoss) {
    if (ctx.hasUI) ctx.ui.notify(loss.notice, "warning");
    if (leavePlanMode(ctx) && loss.diagnosis) injectSrtSetupGuide(loss.diagnosis, ctx);
  }

  async function runPlanDoctor(ctx: ExtensionContext) {
    const outputDir = resolvePlanOutputDir(configuredPlanOutputDir(settings), ctx.cwd ?? process.cwd());
    const profile = sandboxProfileFor({ outputDir, ...currentSandboxExtras() });
    const settingsPath = srtProfileSettingsPath(srtProfileDir(), `doctor-${randomUUID()}`);
    let diagnosis: SrtRuntimeDiagnosis;
    try {
      await writeSrtProfile(settingsPath, profile).catch(() => undefined);
      diagnosis = await runSandboxDiagnosis(settingsPath);
    } finally {
      await removeSrtProfile(settingsPath, srtProfileDir());
    }
    const lines = [
      describeSrtDiagnosis(diagnosis),
      `Plan output directory: ${outputDir}${existsSync(outputDir) ? "" : " (missing; Plan start creates it)"}`,
      `Sandbox write paths: ${profile.allowWrite.join(", ")} + a private per-workflow scratch TMPDIR`,
      `Sandbox network domains: ${profile.allowedDomains.length > 0 ? profile.allowedDomains.join(", ") : "none (all denied)"}`,
    ];
    if (!diagnosis.ok) lines.push("Run /plan start to receive the agent setup guide after fixing the environment.");
    ctx.ui.notify(lines.join("\n"), diagnosis.ok ? "info" : "warning");
  }

  async function showStoredPlanForCurrentState(ctx: ExtensionContext) {
    const outputDir = workflowOutputDir();
    await showStoredPlan(pi, ctx, state, {
      ...(outputDir ? { planOutputDir: outputDir } : {}),
      draftSinceMs: workflowStartedAt || undefined,
    });
  }

  function trackPlanCall(toolCallId: string, target?: string) {
    if (trackedPlanCalls.size > 200) trackedPlanCalls.clear();
    trackedPlanCalls.set(toolCallId, { startedAt: Date.now(), ...(target !== undefined ? { target } : {}) });
  }

  function takeTrackedPlanCall(toolCallId: string) {
    const tracked = trackedPlanCalls.get(toolCallId);
    trackedPlanCalls.delete(toolCallId);
    return tracked;
  }

  function bashContentLooksLikeSandboxDenial(content: readonly unknown[]) {
    const text = content
      .map((block) => {
        const candidate = block as { type?: string; text?: string };
        return candidate?.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
      })
      .join("\n");
    return (
      text.includes("Operation not permitted") ||
      text.includes("blocked-by-sandbox-runtime") ||
      text.includes("blocked by network allowlist") ||
      text.includes("connection not allowed by ruleset")
    );
  }

  /** Newest top-level Markdown file in the workflow's output directory modified since the bash call started. */
  async function detectPlanDraftUpdate(startedAt: number, cwd: string | undefined): Promise<string | undefined> {
    const outputDir = workflowOutputDir();
    if (!outputDir) return undefined;
    const updated = await newestPlanMarkdown(outputDir, startedAt);
    return updated ? (displayPath(updated, cwd) ?? updated) : undefined;
  }

  /** Display path of a Markdown write/edit target admitted into the plan output directory. */
  function planDraftDisplay(target: string, cwd: string | undefined) {
    if (!target.toLowerCase().endsWith(".md")) return undefined;
    return displayPath(target, cwd) ?? target;
  }

  /**
   * Built-in write/edit may target files inside the workflow's frozen plan output directory: the
   * tool must be the built-in one (an extension override stays blocked), active, and its `path` must
   * resolve inside the directory after `..` normalization and symlink resolution, and never at or
   * under the pi agent dir or srt profile dir or onto a settings file. Returns the resolved target.
   */
  async function planOutputWriteTarget(toolName: string, input: unknown, ctx: ExtensionContext) {
    const tool = toolByName(toolName);
    if (!tool || !isBuiltinTool(tool)) return undefined;
    if (!safeGetActiveTools().includes(toolName)) return undefined;
    const outputDir = workflowOutputDir();
    if (!outputDir) return undefined;
    const path = readToolPath(input);
    if (!path?.trim()) return undefined;
    const target = resolveToolTargetPath(path, ctx.cwd ?? process.cwd());
    if (await isProtectedPlanModePath(target)) return undefined;
    return (await isPathInsidePlanOutputDir(target, outputDir)) ? target : undefined;
  }

  async function isProtectedPlanModePath(target: string) {
    const candidates = [target];
    const realTarget = await realpathThroughExistingAncestor(target);
    if (realTarget) candidates.push(realTarget);
    const { dirs, files } = protectedPlanModePaths();
    for (const directory of dirs) {
      const forms = [resolve(directory), (await realpathThroughExistingAncestor(resolve(directory))) ?? resolve(directory)];
      if (candidates.some((candidate) => forms.some((form) => isAtOrUnderPath(candidate, form)))) return true;
    }
    for (const file of files) {
      const forms = [resolve(file), (await realpathThroughExistingAncestor(resolve(file))) ?? resolve(file)];
      if (candidates.some((candidate) => forms.includes(candidate))) return true;
    }
    return false;
  }

  async function acceptCompletedPlan(plan: string, source: PlanCompletionSource, ctx: ExtensionContext) {
    const normalized = normalizePlanModeCompletion({ plan });
    if (!normalized.ok) {
      ctx.ui.notify(`Proposed plan is not ready: ${normalized.error}.`, "warning");
      persistState();
      updateUi(ctx);
      return;
    }
    finalizationRequest.satisfy();
    if (
      state.enabled &&
      state.awaitingAction &&
      state.latestPlan === normalized.plan &&
      state.latestPlanSource === source
    ) {
      return;
    }
    state = {
      ...state,
      latestPlan: normalized.plan,
      latestPlanSource: source,
      awaitingAction: true,
    };
    readyPresentationIntent = {
      nonce: ++nextReadyPresentationNonce,
      plan: normalized.plan,
      source,
    };
    await persistPlanDocument(normalized.plan, ctx);
    persistState();
    updateUi(ctx);
  }

  /**
   * Persist the completed plan as Markdown in the workflow's verified output directory; revisions
   * overwrite the workflow's document. A recorded path that is no longer a safe regular file inside
   * that directory (e.g. a planted symlink or hard link) is abandoned for a freshly allocated one.
   */
  async function persistPlanDocument(plan: string, ctx: ExtensionContext) {
    if (!state.enabled) return;
    const outputDir = workflowOutputDir();
    if (!outputDir) {
      ctx.ui.notify("Plan document could not be written: the workflow's sandbox is not verified.", "warning");
      return;
    }
    const planWorkflowGeneration = workflowGeneration;
    try {
      const recorded = state.planDocPath;
      let path = recorded && (await isSafePlanDocTarget(recorded, outputDir)) ? recorded : undefined;
      for (let attempt = 0; ; attempt += 1) {
        path ??= allocatePlanDocPath(outputDir, plan);
        if (await isSafePlanDocTarget(path, outputDir)) break;
        if (attempt >= 2) throw new Error(`no safe document path is available in ${outputDir}`);
        path = undefined;
      }
      await writePlanDoc(path, plan, outputDir);
      if (state.enabled && workflowGeneration === planWorkflowGeneration && state.planDocPath !== path) {
        state = { ...state, planDocPath: path };
      }
    } catch (error: unknown) {
      ctx.ui.notify(`Plan document could not be written: ${terminalErrorDetail(error)}`, "warning");
    }
  }

  function completedPlanIsCurrent(intent: ReadyPresentationIntent) {
    return (
      state.enabled &&
      workflowMutex.isOwner(workflowOwner) &&
      state.awaitingAction &&
      state.latestPlan === intent.plan &&
      state.latestPlanSource === intent.source
    );
  }

  function readyPresentationIsCurrent(intent: ReadyPresentationIntent) {
    return completedPlanIsCurrent(intent) && readyPresentationIntent?.nonce === intent.nonce;
  }

  async function togglePlanMode(ctx: ExtensionContext) {
    if (state.enabled) {
      const notification = planModeDisableNotification();
      if (exitPlanMode(ctx)) ctx.ui.notify(notification, "info");
      return;
    }
    if (savedPlanBlocksNewWorkflow(ctx, state.savedPlan !== undefined)) return;
    await startPlanWorkflow(ctx);
  }

  function planModeDisableNotification() {
    return state.activeImplementation
      ? "Active implementation plan cleared."
      : state.savedPlan
        ? "Saved plan cleared."
        : state.latestPlan
          ? "Plan mode disabled. Proposed plan discarded."
          : "Plan mode disabled.";
  }

  function requestFinalPlan(ctx: ExtensionContext) {
    if (!state.enabled) {
      ctx.ui.notify("Plan mode is not active. Use /plan first.", "warning");
      return;
    }
    finalizationRequest.request(workflowGeneration);
    if (!sendPlanModeUserMessage(FINALIZE_PLAN_PROMPT, ctx)) finalizationRequest.reset();
  }

  function savePlanForLater(ctx: ExtensionContext) {
    const plan = state.enabled ? state.latestPlan?.trim() : undefined;
    if (!plan) {
      const message = "No completed plan is available to save.";
      if (!ctx.hasUI) throw new Error(message);
      ctx.ui.notify(message, "warning");
      return;
    }
    const source = state.latestPlanSource ?? "legacy_proposed_plan";
    if (!allowModeTransition(ctx, "save the plan and leave Plan mode")) return;

    if (!publishModeContract("normal", ctx)) return;
    advanceWorkflowGeneration();
    readyPresentationIntent = undefined;
    workflowAllowedToolNames = undefined;
    void discardActiveSandbox();
    state = {
      ...state,
      enabled: false,
      latestPlan: undefined,
      latestPlanSource: undefined,
      awaitingAction: false,
      savedPlan: { plan, source, ...(state.planDocPath ? { docPath: state.planDocPath } : {}) },
      activeImplementation: undefined,
      pendingImplementationRuntime: undefined,
      workflowToolPolicy: undefined,
      sandbox: undefined,
      planDocPath: undefined,
      pendingPlanPrompt: undefined,
      manualThinkingLevel: undefined,
    };
    restoreThinkingLevel();
    state = { ...state, manualThinkingLevel: undefined };
    persistState();
    updateUi(ctx);
    releaseWorkflowOwner();
    ctx.ui.notify("Plan saved for later. Plan mode disabled.", "info");
  }

  async function startFreshImplementation(
    ctx: ExtensionContext,
    menuIsCurrent: () => boolean,
    runtime: ImplementationRuntimeSelection | undefined,
    timing: FreshImplementationTiming,
  ) {
    const retention = configuredImplementationPlanRetention(settings);
    if (timing === "immediate") {
      await startFreshImplementationFromState(ctx, {
        getState: () => state,
        menuIsCurrent,
        retention,
        stateEntryType: STATE_ENTRY_TYPE,
        runtime,
      });
      return;
    }

    const initialState = state;
    const savedPlan = initialState.enabled ? undefined : initialState.savedPlan;
    const plan = (initialState.enabled ? initialState.latestPlan : savedPlan?.plan)?.trim();
    const source = initialState.enabled ? initialState.latestPlanSource : savedPlan?.source;
    if (!plan || !source || !menuIsCurrent()) return;
    stagedFreshImplementation = {
      ctx,
      sourceSession: ctx.sessionManager,
      menuGeneration,
      workflowGeneration,
      workflowOwner,
      enabled: initialState.enabled,
      plan,
      source,
      savedPlan,
      retention,
      runtime: runtime
        ? {
            ...(runtime.model ? { model: { ...runtime.model } } : {}),
            ...(runtime.thinkingLevel ? { thinkingLevel: runtime.thinkingLevel } : {}),
          }
        : undefined,
      menuIsCurrent,
    };
  }

  function armDeferredFreshImplementation(request: DeferredFreshImplementation) {
    deferredFreshHandoff.schedule(
      async (taskIsCurrent) => {
        const isCurrent = () => taskIsCurrent() && deferredFreshImplementationIsCurrent(request);
        if (!isCurrent()) return;
        await startFreshImplementationFromState(request.ctx, {
          getState: () => state,
          menuIsCurrent: isCurrent,
          retention: request.retention,
          stateEntryType: STATE_ENTRY_TYPE,
          runtime: request.runtime,
        });
      },
      (error) => {
        if (!deferredFreshImplementationIsCurrent(request)) return;
        try {
          request.ctx.ui.notify(
            `Unable to start the deferred fresh implementation: ${terminalErrorDetail(error)}`,
            "error",
          );
        } catch {
          // The source context can become stale while a detached failure is reported.
        }
      },
    );
  }

  function deferredFreshImplementationIsCurrent(request: DeferredFreshImplementation) {
    if (
      currentSession !== request.sourceSession ||
      menuGeneration !== request.menuGeneration ||
      workflowGeneration !== request.workflowGeneration ||
      workflowOwner !== request.workflowOwner ||
      !request.menuIsCurrent() ||
      state.enabled !== request.enabled
    ) {
      return false;
    }
    return request.enabled
      ? workflowMutex.isOwner(request.workflowOwner) &&
          state.latestPlan === request.plan &&
          state.latestPlanSource === request.source
      : state.savedPlan === request.savedPlan;
  }

  function cancelDeferredFreshImplementation() {
    stagedFreshImplementation = undefined;
    deferredFreshHandoff.cancel();
  }

  async function startImplementation(ctx: ExtensionContext) {
    const savedPlan = state.enabled ? undefined : state.savedPlan;
    const initialPlan = (state.enabled ? state.latestPlan : savedPlan?.plan)?.trim();
    if (!initialPlan) {
      ctx.ui.notify("Plan mode disabled. No proposed plan is available to implement.", "warning");
      return;
    }
    if (!allowModeTransition(ctx, "start plan implementation")) return;
    if (savedPlan) {
      const sessionGeneration = menuGeneration;
      const planWorkflowGeneration = workflowGeneration;
      const isCurrent = () =>
        sessionGeneration === menuGeneration &&
        planWorkflowGeneration === workflowGeneration &&
        !menuController.signal.aborted &&
        !state.enabled &&
        state.savedPlan === savedPlan;
      if (!(await preflightSavedPlanImplementation(ctx, isCurrent))) return;
      if (!allowModeTransition(ctx, "start plan implementation")) return;
    }
    const plan = (state.enabled ? state.latestPlan : savedPlan?.plan)?.trim();
    const source = (state.enabled ? state.latestPlanSource : savedPlan?.source) ?? "legacy_proposed_plan";
    if (!plan) return;

    const previousState = state;
    const previousIntent = readyPresentationIntent;
    const wasEnabled = state.enabled;
    if (!publishModeContract("normal", ctx)) return;
    advanceWorkflowGeneration();
    const retention = configuredImplementationPlanRetention(settings);
    const usesConversationHistory = retention === "clear-on-start";
    readyPresentationIntent = undefined;
    workflowAllowedToolNames = undefined;
    state = {
      ...state,
      enabled: false,
      latestPlan: undefined,
      latestPlanSource: undefined,
      awaitingAction: false,
      savedPlan: undefined,
      pendingImplementationRuntime: undefined,
      activeImplementation: usesConversationHistory
        ? undefined
        : {
            id: randomUUID(),
            plan,
            source,
            startedAt: Date.now(),
            retention,
            ...(state.planDocPath ? { docPath: state.planDocPath } : {}),
          },
      workflowToolPolicy: undefined,
      sandbox: undefined,
      planDocPath: undefined,
      pendingPlanPrompt: undefined,
      manualThinkingLevel: undefined,
    };
    if (wasEnabled) {
      restoreThinkingLevel();
      state = { ...state, manualThinkingLevel: undefined };
    }
    persistState();
    updateUi(ctx);

    const handoff = usesConversationHistory
      ? wasEnabled
        ? formatHistoryImplementationPrompt()
        : formatTransferredPlanPrompt(plan, false)
      : formatImplementationHandoff(plan);
    const sent = sendPlanModeUserMessage(handoff, ctx);
    if (!sent) {
      state = previousState;
      readyPresentationIntent = previousIntent;
      if (wasEnabled) {
        restoreWorkflowToolPolicy(state.workflowToolPolicy);
        publishModeContract("plan", ctx);
        applyPlanThinkingLevel();
      }
      persistState();
      updateUi(ctx);
      return;
    }
    if (wasEnabled) {
      releaseWorkflowOwner();
      void discardActiveSandbox();
    }
  }

  function clearActiveImplementation(id: string, ctx: ExtensionContext) {
    if (state.activeImplementation?.id !== id) return false;
    advanceWorkflowGeneration();
    state = { ...state, activeImplementation: undefined };
    persistState();
    updateUi(ctx);
    return true;
  }

  async function exportPlan(
    ctx: ExtensionContext,
    path: string | undefined,
    signal: AbortSignal,
    isCurrent: () => boolean,
  ) {
    const exitsReadyPlan = state.enabled && Boolean(state.latestPlan?.trim());
    if (exitsReadyPlan && !allowModeTransition(ctx, "export the ready plan and leave Plan mode")) {
      return false;
    }
    return planExports.export(path, ctx, signal, () => {
      return isCurrent() && (!exitsReadyPlan || ctx.isIdle());
    });
  }

  async function showLaunchMenu(ctx: ExtensionContext, initialScreen: "main" | "tools" = "main") {
    const lifecycle = captureMenuLifecycle();
    if (!lifecycle.isCurrent() || lifecycle.signal.aborted) return;
    const ui = await loadInteractiveUi();
    if (!lifecycle.isCurrent() || lifecycle.signal.aborted) return;
    const tools = selectableTools();
    const activeToolNames = new Set(safeGetActiveTools());
    const initialSelectedNames = snapshotPlanModeSelectedNames(tools, toolSelectionSnapshot());
    const retainsInactiveSelection =
      state.selectedToolNames !== undefined ||
      state.selectedToolKeys !== undefined ||
      settings.defaultPlanTools !== undefined;
    const retainedInactiveNames = retainsInactiveSelection ? initialSelectedNames : new Set<string>();
    const registeredNames = new Set(tools.map((tool) => tool.name));
    const pendingNames = Array.from(retainedInactiveNames).filter((name) => !registeredNames.has(name));
    await ui.showPlanLaunchMenu(ctx, {
      statusText: planModeHelperToolsAvailable(safeGetActiveTools())
        ? "Status: Off — visible Plan helpers stay inactive until /plan starts."
        : "Status: Off — required Plan helpers are unavailable under the active tool policy.",
      initialScreen,
      getSelectedNames: () => snapshotPlanModeSelectedNames(tools, toolSelectionSnapshot()),
      toolSummary: (selectedNames) => {
        const allowed = tools
          .filter(
            (tool) => activeToolNames.has(tool.name) && selectedNames.has(tool.name) && canSelectToolInPlanMode(tool),
          )
          .map((tool) => tool.name);
        const pending = pendingNames.filter((name) => selectedNames.has(name)).map(terminalToolName);
        const visiblePending = pending.slice(0, 3);
        const pendingSuffix =
          pending.length > visiblePending.length ? `, +${pending.length - visiblePending.length} more` : "";
        return [
          `Plan policy will allow: ${allowed.length > 0 ? allowed.join(", ") : "none"}.`,
          ...(pending.length > 0 ? [`Pending registration: ${visiblePending.join(", ")}${pendingSuffix}.`] : []),
        ].join(" ");
      },
      tools: [
        ...tools.map((tool) => {
          const selectable = canSelectToolInPlanMode(tool);
          const active = activeToolNames.has(tool.name);
          const retained = retainedInactiveNames.has(tool.name);
          const policy = active
            ? toolPolicyLabel(tool)
            : retained
              ? "not active yet; retained for first-request resolution"
              : "not active in this Pi session";
          const description = tool.description ?? "No description available";
          return {
            name: tool.name,
            description: `${policy} · ${description}`,
            searchText: [policy, description].join(" "),
            disabled: !selectable || !active,
            disabledReason: !active
              ? retained
                ? "Not active yet; retained and resolved before the first request"
                : "Not active in Pi; Plan mode will not activate it"
              : selectable
                ? undefined
                : "Blocked by Plan-mode policy",
          };
        }),
        ...pendingNames.map((name) => {
          const label = terminalToolName(name);
          return {
            name,
            label,
            description: "pending registration · Retained and resolved before the first Plan request",
            searchText: `${label} pending registration retained first Plan request`,
            disabled: true,
            disabledReason:
              "Not registered yet; Plan mode will not activate it and will resolve it before the first request",
          };
        }),
      ],
      ...lifecycle,
      start: async (signal) => {
        if (signal.aborted || !lifecycle.isCurrent()) return;
        await startPlanWorkflow(ctx);
      },
      startWithTools: async (names, signal) => {
        if (signal.aborted || !lifecycle.isCurrent()) return;
        const selectedToolNames = Array.from(
          new Set(names.filter((name) => activeToolNames.has(name) || retainedInactiveNames.has(name))),
        );
        await startPlanWorkflow(ctx, { candidate: { selectedToolNames, selectedToolKeys: undefined } });
      },
      settings: (signal) => showSettings(ctx, signal, lifecycle.isCurrent),
    });
  }

  async function showActivePlanMenu(ctx: ExtensionContext) {
    if (!ctx.hasUI) {
      ctx.ui.notify(planStatusText(), "info");
      return;
    }
    const lifecycle = captureMenuLifecycle();
    if (!lifecycle.isCurrent() || lifecycle.signal.aborted) return;
    const ui = await loadInteractiveUi();
    if (!lifecycle.isCurrent() || lifecycle.signal.aborted) return;
    await ui.showActiveImplementationMenu(ctx, {
      statusText: planStatusText(),
      getExportDestination: () => planExports.getDestination(ctx),
      signal: lifecycle.signal,
      isCurrent: lifecycle.isCurrent,
      show: () => {
        void showStoredPlanForCurrentState(ctx);
      },
      exportPlan: (path, signal) => planExports.export(path, ctx, signal, lifecycle.isCurrent),
      settings: (signal) => showSettings(ctx, signal, lifecycle.isCurrent),
      startNew: async () => {
        await startPlanWorkflow(ctx);
      },
      clear: () => {
        if (exitPlanMode(ctx)) ctx.ui.notify("Active implementation plan cleared.", "info");
      },
    });
  }

  async function showSettings(ctx: ExtensionContext, signal: AbortSignal, isCurrent: () => boolean) {
    if (!isCurrent() || signal.aborted) return false;
    const ui = await loadInteractiveUi();
    if (!isCurrent() || signal.aborted) return false;
    const result = await ui.showPlanModeSettings(ctx, {
      tools: selectableTools(),
      activeToolNames: safeGetActiveTools(),
      signal,
      isCurrent,
      settingsPath: dependencies.settingsPath,
      updateSettings: dependencies.updateSettings ?? updatePlanModeSettings,
      startupToggleShortcut,
      onSaved: (saved) => {
        if (!isCurrent()) return;
        settings = saved;
      },
      ...(dependencies.readSettings
        ? { readSettings: async () => dependencies.readSettings?.() ?? { kind: "missing" } }
        : {}),
    });
    return result.kind === "closed" && "reason" in result && result.reason === "close";
  }

  function allowModeTransition(ctx: ExtensionContext, action: string) {
    if (ctx.isIdle()) return true;
    const message = `Cannot ${action} while an agent run is active. Wait for the run to settle, then retry.`;
    if (!ctx.hasUI) throw new Error(message);
    ctx.ui.notify(message, "warning");
    return false;
  }

  function advanceWorkflowGeneration() {
    cancelDeferredFreshImplementation();
    workflowGeneration += 1;
    pendingWorkflowToolPolicy = undefined;
    finalizationRequest.reset();
  }

  function finalizationRunOutcome(messages: unknown): FinalizationRunOutcome {
    const stopReason = latestAssistantStopReason(messages);
    if (stopReason === undefined || stopReason === "stop") return "normal";
    if (stopReason === "aborted") return "cancelled";
    return "error";
  }

  function captureMenuLifecycle() {
    const sessionGeneration = menuGeneration;
    const planWorkflowGeneration = workflowGeneration;
    const owner = workflowOwner;
    const controller = menuController;
    return {
      signal: controller.signal,
      isCurrent: () =>
        sessionGeneration === menuGeneration &&
        planWorkflowGeneration === workflowGeneration &&
        !controller.signal.aborted &&
        (!state.enabled || workflowMutex.isOwner(owner)),
    };
  }

  function planModePolicyToolNames() {
    if (state.enabled) return workflowAllowedToolNames ?? [];
    return computePlanModePolicyToolNames();
  }

  function workflowDesiredToolNames() {
    const policy = state.workflowToolPolicy;
    if (!state.enabled || !policy) return new Set<string>();
    return new Set(policy.kind === "automatic" ? automaticPlanModeToolNames() : (policy.desiredNames ?? []));
  }

  function beginWorkflowToolPolicy() {
    const kind = toolPolicySelectionIsExplicit() ? "explicit" : "automatic";
    const desiredNames = desiredPlanModeToolNames();
    const allowedNames = resolvePlanModePolicyToolNames(desiredNames);
    const policy: PlanModeWorkflowToolPolicy = {
      kind,
      ...(kind === "explicit" ? { desiredNames } : {}),
      allowedNames,
      resolved: false,
    };
    state = { ...state, workflowToolPolicy: policy };
    pendingWorkflowToolPolicy = { generation: workflowGeneration, mode: "resolve" };
    workflowAllowedToolNames = allowedNames;
  }

  function resolvePendingWorkflowToolPolicy(ctx: ExtensionContext) {
    const pending = pendingWorkflowToolPolicy;
    if (!pending) return;
    if (pending.generation !== workflowGeneration || !state.enabled || !workflowMutex.isOwner(workflowOwner)) {
      pendingWorkflowToolPolicy = undefined;
      return;
    }
    const policy = state.workflowToolPolicy;
    const expectedResolved = pending.mode === "revalidate";
    if (!policy || policy.resolved !== expectedResolved) {
      pendingWorkflowToolPolicy = undefined;
      return;
    }
    const allowedNames =
      pending.mode === "resolve" ? resolveWorkflowToolPolicy(policy) : revalidateFrozenWorkflowToolPolicy(policy);
    const policyChanged = !policy.resolved || !arrayEquals(policy.allowedNames, allowedNames);
    workflowAllowedToolNames = allowedNames;
    state = {
      ...state,
      workflowToolPolicy: { ...policy, allowedNames, resolved: true },
    };
    pendingWorkflowToolPolicy = undefined;
    if (policyChanged) persistState();
    updateUi(ctx);
  }

  // Fork: admit an explicitly selected tool that became active after the workflow froze its policy,
  // e.g. pi-web-access tools activated through web_enable. Callers have already verified that the
  // tool is registered, active, and not blocked by the built-in policy.
  function admitLateActivatedExplicitTool(toolName: string, ctx: ExtensionContext) {
    const policy = state.workflowToolPolicy;
    if (policy?.kind !== "explicit" || !policy.desiredNames?.includes(toolName)) return false;
    workflowAllowedToolNames = [...new Set([...(workflowAllowedToolNames ?? []), toolName])];
    state = {
      ...state,
      workflowToolPolicy: { ...policy, allowedNames: [...new Set([...policy.allowedNames, toolName])] },
    };
    persistState();
    updateUi(ctx);
    return true;
  }

  function toolPolicySelectionIsExplicit() {
    return (
      state.selectedToolNames !== undefined ||
      state.selectedToolKeys !== undefined ||
      settings.defaultPlanTools !== undefined
    );
  }

  function desiredPlanModeToolNames() {
    const tools = activePlanPolicyTools();
    return Array.from(snapshotPlanModeSelectedNames(tools, toolSelectionSnapshot()));
  }

  function automaticPlanModeToolNames() {
    return Array.from(snapshotPlanModeSelectedNames(activePlanPolicyTools(), {}));
  }

  function resolveWorkflowToolPolicy(policy: PlanModeWorkflowToolPolicy) {
    return resolvePlanModePolicyToolNames(
      policy.kind === "automatic" ? automaticPlanModeToolNames() : (policy.desiredNames ?? []),
    );
  }

  function revalidateFrozenWorkflowToolPolicy(policy: PlanModeWorkflowToolPolicy) {
    const currentlyAllowed = new Set(
      policy.kind === "automatic"
        ? resolvePlanModePolicyToolNames(automaticPlanModeToolNames())
        : resolvePlanModePolicyToolNames(policy.allowedNames),
    );
    return policy.allowedNames.filter((name) => currentlyAllowed.has(name));
  }

  function restoreWorkflowToolPolicy(policy: PlanModeWorkflowToolPolicy | undefined) {
    let nextPolicy: PlanModeWorkflowToolPolicy;
    if (!policy) {
      const kind = toolPolicySelectionIsExplicit() ? "explicit" : "automatic";
      const desiredNames = desiredPlanModeToolNames();
      nextPolicy = {
        kind,
        ...(kind === "explicit" ? { desiredNames } : {}),
        allowedNames: resolvePlanModePolicyToolNames(desiredNames),
        resolved: true,
      };
    } else if (policy.resolved) {
      nextPolicy = policy;
    } else {
      nextPolicy = {
        ...policy,
        allowedNames: resolveWorkflowToolPolicy(policy),
      };
    }
    state = { ...state, workflowToolPolicy: nextPolicy };
    workflowAllowedToolNames = nextPolicy.resolved
      ? revalidateFrozenWorkflowToolPolicy(nextPolicy)
      : nextPolicy.allowedNames;
    pendingWorkflowToolPolicy = {
      generation: workflowGeneration,
      mode: nextPolicy.resolved ? "revalidate" : "resolve",
    };
    return !workflowToolPoliciesEqual(policy, nextPolicy);
  }

  function workflowToolPoliciesEqual(left: PlanModeWorkflowToolPolicy | undefined, right: PlanModeWorkflowToolPolicy) {
    return (
      left?.kind === right.kind &&
      left.resolved === right.resolved &&
      arrayEquals(left.allowedNames, right.allowedNames) &&
      arrayEquals(left.desiredNames ?? [], right.desiredNames ?? [])
    );
  }

  function arrayEquals(left: readonly string[], right: readonly string[]) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }

  function computePlanModePolicyToolNames() {
    return resolvePlanModePolicyToolNames(desiredPlanModeToolNames());
  }

  function resolvePlanModePolicyToolNames(desiredNames: readonly string[]) {
    const selectedNames = new Set(desiredNames);
    return activePlanPolicyTools()
      .filter((tool) => selectedNames.has(tool.name) && canSelectToolInPlanMode(tool))
      .map((tool) => tool.name);
  }

  function toolSelectionSnapshot() {
    return {
      selectedToolNames: state.selectedToolNames,
      selectedToolKeys: state.selectedToolKeys,
      defaultPlanTools: settings.defaultPlanTools,
    };
  }

  function selectableTools() {
    return safeGetAllTools()
      .filter((tool) => tool.name !== PLAN_MODE_QUESTION_TOOL_NAME && tool.name !== PLAN_MODE_COMPLETE_TOOL_NAME)
      .sort(compareTools);
  }

  function activePlanPolicyTools() {
    const activeNames = new Set(safeGetActiveTools());
    return selectableTools().filter((tool) => activeNames.has(tool.name));
  }

  function safeGetAllTools() {
    try {
      return pi.getAllTools();
    } catch {
      return [];
    }
  }

  function runtimeAdmissionIsPending(sessionManager: ExtensionContext["sessionManager"]) {
    return (
      activeImplementationRuntimeApplication?.sessionManager === sessionManager ||
      pendingRuntimeAdmissionSession === sessionManager ||
      queuedRuntimeAdmissionInputs.some((queued) => queued.sessionManager === sessionManager)
    );
  }

  function takeQueuedRuntimeAdmissionInputs(sessionManager: ExtensionContext["sessionManager"]) {
    const matching: QueuedRuntimeAdmissionInput[] = [];
    const remaining: QueuedRuntimeAdmissionInput[] = [];
    for (const queued of queuedRuntimeAdmissionInputs) {
      if (queued.sessionManager === sessionManager) matching.push(queued);
      else remaining.push(queued);
    }
    queuedRuntimeAdmissionInputs = remaining;
    return matching;
  }

  function removeQueuedRuntimeAdmissionInput(queuedInput: QueuedRuntimeAdmissionInput) {
    const index = queuedRuntimeAdmissionInputs.indexOf(queuedInput);
    if (index >= 0) queuedRuntimeAdmissionInputs.splice(index, 1);
  }

  function runtimeAdmissionInputContent(queued: QueuedRuntimeAdmissionInput) {
    return queued.images?.length ? [{ type: "text" as const, text: queued.text }, ...queued.images] : queued.text;
  }

  function refreshStateForFirstPrompt(ctx: ExtensionContext) {
    if (!refreshStateBeforeFirstAgentStart) return;
    refreshStateBeforeFirstAgentStart = false;
    implementationRetention.reset();
    const branch = ctx.sessionManager.getBranch();
    const restoredState = restorePlanModeState(branch, STATE_ENTRY_TYPE);
    restoreModeContractTracking(branch, restoredState);
    if (!installRestoredState(restoredState, ctx)) return;
    implementationRetention.restore(state.activeImplementation);
    updateUi(ctx);
    if (restoredState.enabled) {
      scheduleRestoredSandboxRevalidation(ctx);
    }
  }

  async function applyPendingImplementationRuntime(
    ctx: ExtensionContext,
    holdForAdmission = false,
  ): Promise<ImplementationRuntimeApplicationResult> {
    const session = ctx.sessionManager;
    const activeApplication = activeImplementationRuntimeApplication;
    if (activeApplication?.sessionManager === session) {
      if (holdForAdmission) activeApplication.holdForAdmission = true;
      return activeApplication.completion;
    }

    const intent = state.enabled ? undefined : state.pendingImplementationRuntime;
    if (!intent) return "ready";
    const generation = menuGeneration;
    const isCurrent = () =>
      currentSession === session && generation === menuGeneration && !menuController.signal.aborted;
    const notifyCurrent = (message: string) => {
      if (!isCurrent()) return;
      try {
        ctx.ui.notify(message, "warning");
      } catch {
        // The session can become stale while an asynchronous runtime application settles.
      }
    };
    let application!: ActiveImplementationRuntimeApplication;
    const completion = Promise.resolve()
      .then(async (): Promise<ImplementationRuntimeApplicationResult> => {
        if (!isCurrent()) return "stale";
        const pendingState = state;
        const previousThinkingLevel = pi.getThinkingLevel();

        const applyThinking = () => {
          if (!intent.thinkingLevel) return;
          try {
            pi.setThinkingLevel(intent.thinkingLevel);
            const effectiveLevel = pi.getThinkingLevel();
            if (effectiveLevel !== intent.thinkingLevel) {
              notifyCurrent(
                `Implementation thinking ${intent.thinkingLevel} is unsupported by the destination model; Pi is using ${effectiveLevel}.`,
              );
            }
          } catch (error: unknown) {
            notifyCurrent(
              `Implementation thinking ${intent.thinkingLevel} could not be applied: ${safeTerminalText(error instanceof Error ? error.message : String(error))}. The destination default will continue.`,
            );
          }
        };

        if (intent.model) {
          let model: ReturnType<ExtensionContext["modelRegistry"]["find"]>;
          let resolutionFailed = false;
          try {
            model = ctx.modelRegistry.find(intent.model.provider, intent.model.modelId);
          } catch (error: unknown) {
            notifyCurrent(
              `Implementation model ${terminalModelReference(intent.model)} could not be resolved: ${safeTerminalText(error instanceof Error ? error.message : String(error))}. The destination default model will continue.`,
            );
            resolutionFailed = true;
            model = undefined;
          }
          if (!model && !resolutionFailed) {
            notifyCurrent(
              `Implementation model ${terminalModelReference(intent.model)} is no longer available. The destination default model will continue.`,
            );
          }
          if (model) {
            let authenticated = false;
            try {
              const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
              if (!isCurrent()) return "stale";
              if (auth.ok) authenticated = true;
              else {
                notifyCurrent(
                  `Implementation model ${terminalModelReference(intent.model)} could not be authenticated: ${safeTerminalText(auth.error)}. The destination default model will continue.`,
                );
              }
            } catch (error: unknown) {
              notifyCurrent(
                `Implementation model ${terminalModelReference(intent.model)} could not be authenticated: ${safeTerminalText(error instanceof Error ? error.message : String(error))}. The destination default model will continue.`,
              );
            }
            if (!isCurrent()) return "stale";
            if (authenticated) {
              let applied = false;
              let applicationFailed = false;
              application.drainOnShutdown = true;
              try {
                try {
                  applied = await pi.setModel(model);
                } catch (error: unknown) {
                  applicationFailed = true;
                  notifyCurrent(
                    `Implementation model ${terminalModelReference(intent.model)} could not be applied: ${safeTerminalText(error instanceof Error ? error.message : String(error))}. The destination default model will continue.`,
                  );
                }
              } finally {
                application.drainOnShutdown = false;
              }
              if (!isCurrent()) return "stale";
              if (!applied && !applicationFailed) {
                notifyCurrent(
                  `Implementation model ${terminalModelReference(intent.model)} could not be applied after authentication changed. The destination default model will continue.`,
                );
              }
            }
          }
        }
        if (!isCurrent()) return "stale";
        applyThinking();
        if (!isCurrent()) return "stale";

        state = { ...state, pendingImplementationRuntime: undefined };
        try {
          persistState();
        } catch (error: unknown) {
          state = pendingState;
          try {
            if (pi.getThinkingLevel() !== previousThinkingLevel) {
              pi.setThinkingLevel(previousThinkingLevel);
            }
          } catch {
            // Keep the durable intent pending even if a runtime rollback is unavailable.
          }
          try {
            persistState();
          } catch {
            // SessionManager mutates its in-memory branch before a disk append can fail.
            // A best-effort rollback entry keeps that branch aligned with durable pending state.
          }
          notifyCurrent(
            `Unable to apply fresh implementation settings because their one-shot state could not be consumed: ${safeTerminalText(error instanceof Error ? error.message : String(error))}. The implementation request was not sent; retry after session persistence is available.`,
          );
          return "blocked";
        }
        if (application.holdForAdmission) pendingRuntimeAdmissionSession = session;
        return "ready";
      })
      .finally(() => {
        if (activeImplementationRuntimeApplication === application) {
          activeImplementationRuntimeApplication = undefined;
        }
      });
    application = {
      sessionManager: session,
      completion,
      drainOnShutdown: false,
      holdForAdmission,
    };
    activeImplementationRuntimeApplication = application;
    return completion;
  }

  function applyPlanThinkingLevel() {
    if (state.manualThinkingLevel) {
      if (pi.getThinkingLevel() !== state.manualThinkingLevel) {
        pi.setThinkingLevel(state.manualThinkingLevel);
      }
      return;
    }
    const configured = configuredThinkingLevel(settings);
    if (!configured) {
      state = {
        ...state,
        previousThinkingLevel: undefined,
        appliedThinkingLevel: undefined,
      };
      return;
    }
    const current = pi.getThinkingLevel();
    if (!state.appliedThinkingLevel) state.previousThinkingLevel = current;
    if (current !== configured) pi.setThinkingLevel(configured);
    state.appliedThinkingLevel = pi.getThinkingLevel();
  }

  function captureManualThinkingLevel() {
    if (!state.appliedThinkingLevel) return;
    const current = pi.getThinkingLevel();
    if (current === state.appliedThinkingLevel) return;
    state = {
      ...state,
      manualThinkingLevel: current,
      previousThinkingLevel: undefined,
      appliedThinkingLevel: undefined,
    };
  }

  function restoreThinkingLevel() {
    captureManualThinkingLevel();
    const { appliedThinkingLevel, previousThinkingLevel } = state;
    if (appliedThinkingLevel && previousThinkingLevel && pi.getThinkingLevel() === appliedThinkingLevel) {
      pi.setThinkingLevel(previousThinkingLevel);
    }
    state = { ...state, appliedThinkingLevel: undefined, previousThinkingLevel: undefined };
  }

  function safeGetActiveTools() {
    try {
      return pi.getActiveTools();
    } catch {
      return DEFAULT_TOOLS;
    }
  }

  function installRestoredState(candidate: PlanModeState, ctx: ExtensionContext) {
    const previousState = state;
    const previousWorkflowAllowedToolNames = workflowAllowedToolNames;
    const previousPendingWorkflowToolPolicy = pendingWorkflowToolPolicy;
    const previousOwner = workflowOwner;
    const previousSandbox = activeSandbox;
    const wasEnabled = state.enabled;
    activeSandbox = undefined;
    trackedPlanCalls.clear();
    // A dropped sandbox is removed unless the candidate still records it; its re-probe removes it then.
    const releasePreviousSandbox = () => {
      if (previousSandbox && previousSandbox.settingsPath !== candidate.sandbox?.settingsPath) {
        void removeSandboxFiles(previousSandbox);
      }
    };
    if (candidate.enabled && !workflowMutex.isOwner(workflowOwner)) {
      const owner = workflowMutex.acquire();
      if (!owner) {
        state = { enabled: false, awaitingAction: false };
        workflowAllowedToolNames = undefined;
        pendingWorkflowToolPolicy = undefined;
        releasePreviousSandbox();
        // The refused restore never re-probes, so its recorded files would otherwise leak.
        void removeSandboxFiles(candidate.sandbox);
        reportRestoredWorkflowBusy(ctx);
        return false;
      }
      workflowOwner = owner;
    }

    try {
      if (candidate.enabled) {
        try {
          assertPlanModeHelperToolsAvailable(safeGetActiveTools());
        } catch {
          state = { enabled: false, awaitingAction: false };
          workflowAllowedToolNames = undefined;
          pendingWorkflowToolPolicy = undefined;
          if (workflowOwner !== previousOwner) {
            workflowMutex.release(workflowOwner);
            workflowOwner = previousOwner;
          }
          releasePreviousSandbox();
          void removeSandboxFiles(candidate.sandbox);
          reportRestoredHelpersUnavailable(ctx);
          return false;
        }
      }
      if (wasEnabled && !candidate.enabled) {
        readyPresentationIntent = undefined;
        restoreThinkingLevel();
      }
      state = candidate;
      if (state.enabled) workflowStartedAt = Date.now();
      const policyChanged = state.enabled ? restoreWorkflowToolPolicy(state.workflowToolPolicy) : false;
      if (!state.enabled) {
        workflowAllowedToolNames = undefined;
        pendingWorkflowToolPolicy = undefined;
      }
      if (policyChanged) persistState();
      if (state.enabled) applyPlanThinkingLevel();
      else if (wasEnabled) releaseWorkflowOwner();
      releasePreviousSandbox();
      return true;
    } catch (error: unknown) {
      try {
        if (!wasEnabled && state.enabled) restoreThinkingLevel();
      } finally {
        state = previousState;
        workflowAllowedToolNames = previousWorkflowAllowedToolNames;
        pendingWorkflowToolPolicy = previousPendingWorkflowToolPolicy;
        activeSandbox = previousSandbox;
        if (workflowOwner !== previousOwner) {
          workflowMutex.release(workflowOwner);
          workflowOwner = previousOwner;
        }
      }
      throw error;
    }
  }

  function rollbackNewActivation(
    previousState: PlanModeState,
    ctx: ExtensionContext,
    previousOwner?: WorkflowMutexOwner,
  ) {
    const activatedOwner = workflowOwner;
    readyPresentationIntent = undefined;
    try {
      if (state.enabled) {
        publishModeContract("normal", ctx);
        restoreThinkingLevel();
      }
    } finally {
      state = previousState;
      workflowAllowedToolNames = undefined;
      pendingWorkflowToolPolicy = undefined;
      try {
        persistState();
        updateUi(ctx);
      } finally {
        if (activatedOwner !== previousOwner) {
          workflowMutex.release(activatedOwner);
          workflowOwner = previousOwner;
        }
      }
    }
  }

  function bindWorkflowSessionIfNeeded(ctx: ExtensionContext) {
    if (currentSession === ctx.sessionManager) return;
    currentSession = ctx.sessionManager;
    workflowOwner = undefined;
    workflowMutex.bindSession(ctx.sessionManager);
  }

  function releaseWorkflowOwner() {
    const owner = workflowOwner;
    workflowMutex.release(owner);
    if (!workflowMutex.isOwner(owner)) workflowOwner = undefined;
  }

  function reportWorkflowBusy(ctx: ExtensionContext) {
    const message = "Another workflow is active in this session. End it before starting Plan mode.";
    if (!ctx.hasUI) throw new Error(message);
    ctx.ui.notify(message, "warning");
    return false;
  }

  function reportRestoredWorkflowBusy(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    ctx.ui.notify(
      "Plan mode was not restored because another workflow is active in this session. Reload or start Plan mode after it ends.",
      "warning",
    );
  }

  function reportRestoredHelpersUnavailable(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    ctx.ui.notify(
      "Plan mode was not restored because its helper tools are unavailable under the active tool policy.",
      "warning",
    );
  }

  function reportHelperActivationFailure(ctx: ExtensionContext, error: unknown) {
    const detail = safeTerminalText(error instanceof Error ? error.message : String(error));
    const message = `Cannot start Plan mode: ${detail}.`;
    if (!ctx.hasUI) throw new Error(message, { cause: error });
    ctx.ui.notify(message, "error");
    return false;
  }

  function updateUi(ctx: ExtensionContext) {
    updatePlanModeUi(ctx, state, formatToolSummary);
  }

  function clearUi(ctx: ExtensionContext) {
    clearPlanModeUi(ctx);
  }

  function planStatusText() {
    return formatPlanModeStatusText(state, formatToolSummary);
  }

  function implementationOutcome() {
    return implementationRetentionPreview(configuredImplementationPlanRetention(settings));
  }

  function formatToolSummary() {
    const names = planModePolicyToolNames();
    return `Plan policy allows: ${names.length > 0 ? names.join(", ") : "none"}. Model-visible tools stay unchanged.`;
  }

  function toolByName(toolName: string) {
    return safeGetAllTools().find((candidate) => candidate.name === toolName);
  }

  function terminalToolName(value: string) {
    const safe = safeTerminalText(value) || "(unnamed tool)";
    return safe.length > 120 ? `${safe.slice(0, 119)}…` : safe;
  }

  function terminalModelReference(model: { provider: string; modelId: string }) {
    const safe = safeTerminalText(`${model.provider}/${model.modelId}`) || "(unnamed model)";
    return safe.length > 160 ? `${safe.slice(0, 159)}…` : safe;
  }

  function terminalErrorDetail(error: unknown) {
    const safe = safeTerminalText(error instanceof Error ? error.message : String(error));
    if (!safe) return "unknown error";
    return safe.length > 500 ? `${safe.slice(0, 499)}…` : safe;
  }

  function safeTerminalText(value: string) {
    return [...stripVTControlCharacters(value)]
      .map((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 0x1f ||
          (codePoint >= 0x7f && codePoint <= 0x9f) ||
          (codePoint >= 0x202a && codePoint <= 0x202e) ||
          (codePoint >= 0x2066 && codePoint <= 0x2069)
          ? " "
          : character;
      })
      .join("")
      .trim();
  }
}

export { completePlanArguments } from "./command.js";
export {
  extractProposedPlan,
  latestAssistantText,
  parseProposedPlan,
  stripProposedPlanBlocks,
  stripProposedPlanBlocksFromMessage,
} from "./message-transform.js";
export {
  createModeContractMessage,
  modeContractContent,
  reconcileModeContract,
} from "./mode-contract.js";
export { buildPlanModePrompt } from "./prompt.js";
export { normalizePlanModeQuestionParams } from "./question-tool.js";
export { withRequiredPlanModeTools } from "./required-tools.js";
export { normalizePlanModeSettings, readPlanModeSettings } from "./settings.js";
export { canSelectToolInPlanMode, classifyPlanModeTool } from "./tool-policy.js";
export {
  buildSrtSetupGuide,
  buildSrtSettingsContents,
  describeSrtDiagnosis,
  diagnoseSrtRuntime,
  shellQuoteSingle,
  wrapCommandForSrt,
} from "./srt-sandbox.js";
export { allocatePlanDocPath, planDocSlug, resolvePlanOutputDir } from "./plan-docs.js";

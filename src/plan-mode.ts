import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { basename, dirname } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { completePlanArguments } from "./command.js";
import {
	normalizePlanModeCompletion,
	PLAN_MODE_COMPLETE_PARAMS,
	PLAN_MODE_COMPLETE_TOOL_NAME,
	planModeCompleted,
	renderPlanModeCompletion,
} from "./completion-tool.js";
import {
	isStaleExtensionContextError,
	onAgentSettled,
	setPlanThinkingLevel,
} from "./extension-runtime.js";
import {
	createFinalizationRequestCoordinator,
	FINALIZE_PLAN_PROMPT,
	type FinalizationRunOutcome,
	RETRY_FINALIZE_PLAN_PROMPT,
} from "./finalization-request.js";
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
	type PlanModeContract,
	reconcileModeContract,
} from "./mode-contract.js";
import { createPlanActionController } from "./plan-action-controller.js";
import { createPlanExportController } from "./plan-export-controller.js";
import {
	clearPlanModeUi,
	planModeStatusText as formatPlanModeStatusText,
	showStoredPlan,
	updatePlanModeUi,
} from "./presentation.js";
import {
	answerPlanModeQuestions,
	normalizePlanModeQuestionParams,
	PLAN_MODE_QUESTION_PARAMS,
	PLAN_MODE_QUESTION_TOOL_NAME,
	planModeQuestionCancelled,
} from "./question-tool.js";
import { withRequiredPlanModeTools } from "./required-tools.js";
import {
	preflightSavedPlanImplementation,
	savedPlanBlocksNewWorkflow,
} from "./saved-plan-preflight.js";
import {
	awaitPlanModeSettingsWrites,
	configuredImplementationPlanRetention,
	configuredPlanModeToggleShortcut,
	configuredThinkingLevel,
	type PlanModeSettings,
	planModeSettingsPath,
	readPlanModeSettings,
} from "./settings.js";
import { type PlanCompletionSource, type PlanModeState, restorePlanModeState } from "./state.js";
import {
	canSelectToolInPlanMode,
	classifyPlanModeTool,
	findBlockedCommandSegment,
	readCommand,
} from "./tool-policy.js";
import {
	compareTools,
	filterAvailableSelectedToolNames,
	snapshotPlanModeSelectedNames,
	toolPolicyLabel,
} from "./tool-selection.js";
import { WorkflowMutex, type WorkflowMutexOwner } from "./workflow-mutex.js";

const STATE_ENTRY_TYPE = "plan-mode-state";
const PROPOSED_PLAN_MESSAGE_TYPE = "proposed-plan";
const BLOCKED_MUTATING_TOOLS = new Set(["edit", "write", "update_plan"]);
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
interface ReadyPresentationIntent {
	nonce: number;
	plan: string;
	source: PlanCompletionSource;
}
type InteractiveUi = typeof import("./interactive-ui.js");

interface PlanModeDependencies {
	readSettings?(): ReturnType<typeof readPlanModeSettings>;
	settingsPath?: string;
	loadInteractiveUi?(): Promise<InteractiveUi>;
}

// Keep session state, persistence, tool, thinking, and mutex commits in this one closure so an
// activation path cannot bypass the same atomic transition by crossing module-owned state.
export default function planMode(pi: ExtensionAPI, dependencies: PlanModeDependencies = {}) {
	const workflowMutex = new WorkflowMutex(pi);
	let workflowOwner: WorkflowMutexOwner | undefined;
	let currentSession: object | undefined;
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
	let toggleShortcut: ReturnType<typeof configuredPlanModeToggleShortcut>;
	const clearPlanModeShortcutHandler = () => {};
	let activeToolBaseline: string[] = [];
	let workflowAllowedToolNames: string[] | undefined;
	let publishedContractMode: PlanModeContract | undefined;
	let modeContractsRelevant = false;
	let readyPresentationIntent: ReadyPresentationIntent | undefined;
	let latestCommandContext: ExtensionCommandContext | undefined;
	let nextReadyPresentationNonce = 0;
	let menuGeneration = 0;
	let workflowGeneration = 0;
	let refreshStateBeforeFirstAgentStart = false;
	let menuController = new AbortController();
	let settingsWatch: ReturnType<typeof watch> | undefined;
	let settingsReloadTimer: ReturnType<typeof setTimeout> | undefined;
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
		implementationOutcome,
		getExportDestination: (ctx) => planExports.getDestination(ctx),
		show: (ctx) => showStoredPlan(pi, ctx, state),
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

	pi.registerFlag("plan", {
		description: "Start in Codex-like Plan mode",
		type: "boolean",
		default: false,
	});

	pi.registerTool({
		name: PLAN_MODE_QUESTION_TOOL_NAME,
		label: "Plan question",
		description:
			"Ask the user one to three Plan-mode clarification questions with meaningful options, then wait for the answer. Only available while Plan mode is active.",
		promptSnippet: "Ask user decision questions while Plan mode is active",
		promptGuidelines: [
			"In Plan mode, use plan_mode_question for important preferences, tradeoffs, or assumptions that cannot be discovered from read-only exploration.",
		],
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
			"Submit the complete decision-ready implementation plan for user review. Only available while Plan mode is active, and must be the final standalone action.",
		promptSnippet: "Submit the final Plan-mode implementation plan",
		promptGuidelines: [
			"Call plan_mode_complete alone as the final action only after the implementation plan is decision-complete.",
		],
		parameters: PLAN_MODE_COMPLETE_PARAMS,
		renderResult: renderPlanModeCompletion,
		async execute(_toolCallId, params: unknown, _signal, _onUpdate, ctx) {
			if (!state.enabled || !workflowMutex.isOwner(workflowOwner)) {
				throw new Error("plan_mode_complete is only available while Plan mode is active");
			}
			const parsed = normalizePlanModeCompletion(params);
			if (!parsed.ok) throw new Error(parsed.error);

			acceptCompletedPlan(parsed.plan, PLAN_MODE_COMPLETE_TOOL_NAME, ctx);
			return planModeCompleted(parsed.plan);
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
				if (savedPlanBlocksNewWorkflow(ctx, state.savedPlan !== undefined && !state.enabled))
					return;
				if (state.enabled) {
					ctx.ui.notify("Plan mode is already active.", "info");
					return;
				}
				if (enterPlanMode(ctx)) {
					ctx.ui.notify(
						"Plan mode enabled. I will explore and plan, but not modify files.",
						"info",
					);
				}
				return;
			}
			if (command === "show") {
				showStoredPlan(pi, ctx, state);
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
				if (savedPlanBlocksNewWorkflow(ctx, state.savedPlan !== undefined && !state.enabled))
					return;
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
				if (savedPlanBlocksNewWorkflow(ctx, state.savedPlan !== undefined && !state.enabled))
					return;
				enterPlanModeWithPrompt(prompt, ctx);
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

	const applyPlanModeShortcut = (
		nextShortcut: ReturnType<typeof configuredPlanModeToggleShortcut>,
	) => {
		if (toggleShortcut && toggleShortcut !== nextShortcut) {
			pi.registerShortcut(toggleShortcut, {
				handler: clearPlanModeShortcutHandler,
			});
		}
		if (!nextShortcut) {
			toggleShortcut = undefined;
			return;
		}
		if (toggleShortcut === nextShortcut) return;
		pi.registerShortcut(nextShortcut, {
			description: "Toggle Plan mode",
			handler: (ctx) => {
				togglePlanMode(ctx);
			},
		});
		toggleShortcut = nextShortcut;
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
		if (loadedSettings.kind === "loaded") {
			settings = loadedSettings.settings;
		} else {
			settings = { thinkingLevel: "inherit" };
		}
		applyPlanModeShortcut(configuredPlanModeToggleShortcut(settings));
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
			void applyPlanModeSettings(generation, undefined, false);
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
		const generation = ++menuGeneration;
		finalizationRequest.reset();
		currentSession = ctx.sessionManager;
		workflowOwner = undefined;
		workflowMutex.bindSession(ctx.sessionManager);
		establishStableToolEnvelope();
		refreshStateBeforeFirstAgentStart = event.reason === "new";
		menuController.abort(new DOMException("Plan-mode session replaced", "AbortError"));
		menuController = new AbortController();
		readyPresentationIntent = undefined;
		latestCommandContext = undefined;
		workflowAllowedToolNames = undefined;
		implementationRetention.reset();
		settings = { thinkingLevel: "inherit" };
		const branch = ctx.sessionManager.getBranch();
		publishedContractMode = latestModeContract(branch)?.mode;
		modeContractsRelevant =
			hasModeContractArtifact(branch) ||
			branch.some(
				(entry: { type?: string; customType?: string }) =>
					entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE,
			);
		const restoredState = restorePlanModeState(branch, STATE_ENTRY_TYPE);
		state = { enabled: false, awaitingAction: false };
		await applyPlanModeSettings(generation, ctx, true);
		if (generation !== menuGeneration || menuController.signal.aborted) return;
		startPlanModeSettingsWatch(generation);
		const persistFlagActivation = pi.getFlag("plan") === true && !restoredState.enabled;
		const candidate = persistFlagActivation
			? restoredState.savedPlan
				? {
						...restoredState,
						enabled: true,
						latestPlan: restoredState.savedPlan.plan,
						latestPlanSource: restoredState.savedPlan.source,
						awaitingAction: true,
						savedPlan: undefined,
						activeImplementation: undefined,
					}
				: { ...restoredState, enabled: true, activeImplementation: undefined }
			: restoredState;
		if (!installRestoredState(candidate, ctx)) return;
		implementationRetention.restore(state.activeImplementation);
		if (persistFlagActivation && state.enabled) persistState();
		updateUi(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		advanceWorkflowGeneration();
		menuGeneration += 1;
		menuController.abort(new DOMException("Plan-mode tree branch changed", "AbortError"));
		menuController = new AbortController();
		readyPresentationIntent = undefined;
		latestCommandContext = undefined;
		implementationRetention.reset();
		const branch = ctx.sessionManager.getBranch();
		publishedContractMode = latestModeContract(branch)?.mode;
		modeContractsRelevant =
			hasModeContractArtifact(branch) ||
			branch.some(
				(entry: { type?: string; customType?: string }) =>
					entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE,
			);
		if (!installRestoredState(restorePlanModeState(branch, STATE_ENTRY_TYPE), ctx)) return;
		implementationRetention.restore(state.activeImplementation);
		startPlanModeSettingsWatch(menuGeneration);
		updateUi(ctx);
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
		const shutdownSession = ctx.sessionManager;
		finalizationRequest.reset();
		menuGeneration += 1;
		menuController.abort(new DOMException("Plan-mode session shut down", "AbortError"));
		readyPresentationIntent = undefined;
		latestCommandContext = undefined;
		refreshStateBeforeFirstAgentStart = false;
		implementationRetention.reset();
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
		if (currentSession === ctx.sessionManager) currentSession = undefined;
	});

	pi.on("tool_call", async (event) => {
		const requiredHelper =
			event.toolName === PLAN_MODE_QUESTION_TOOL_NAME ||
			event.toolName === PLAN_MODE_COMPLETE_TOOL_NAME;
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
		if (BLOCKED_MUTATING_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason:
					event.toolName === "update_plan"
						? "Plan mode blocks update_plan because it tracks execution progress rather than conversational planning."
						: `Plan mode blocks mutating tool '${event.toolName}'.`,
			};
		}
		if (requiredHelper) return;

		const allowedToolNames = new Set(planModePolicyToolNames());
		if (!allowedToolNames.has(event.toolName)) {
			return {
				block: true,
				reason: `Plan mode blocks tool '${event.toolName}' because it is unavailable or not selected by the Plan policy.`,
			};
		}
		const calledTool = toolByName(event.toolName);
		if (!calledTool || classifyPlanModeTool(calledTool) === "blocked") {
			return {
				block: true,
				reason: `Plan mode blocks tool '${event.toolName}' because its safe policy metadata is unavailable.`,
			};
		}
		if (event.toolName !== "bash") return;

		const blocked = findBlockedCommandSegment(readCommand(event.input), settings.safeSubcommands);
		if (blocked !== undefined) {
			return {
				block: true,
				reason: `Plan mode blocks bash commands outside its reviewed inspection policy or containing explicitly unsafe arguments.\nBlocked command: ${blocked}`,
			};
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

	pi.on("context", async (event, ctx) => {
		const result = implementationRetention.transformContext(event.messages, state);
		if (result.clearActiveImplementationId) {
			clearActiveImplementation(result.clearActiveImplementationId, ctx);
		}
		const messages =
			state.enabled || modeContractsRelevant
				? reconcileModeContract(result.messages, state.enabled ? "plan" : "normal")
				: result.messages;
		return { messages: messages as typeof event.messages };
	});

	pi.on("before_agent_start", (_event, ctx) => {
		if (refreshStateBeforeFirstAgentStart) {
			refreshStateBeforeFirstAgentStart = false;
			implementationRetention.reset();
			const branch = ctx.sessionManager.getBranch();
			publishedContractMode = latestModeContract(branch)?.mode;
			modeContractsRelevant =
				hasModeContractArtifact(branch) ||
				branch.some(
					(entry: { type?: string; customType?: string }) =>
						entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE,
				);
			if (!installRestoredState(restorePlanModeState(branch, STATE_ENTRY_TYPE), ctx)) return;
			implementationRetention.restore(state.activeImplementation);
			updateUi(ctx);
		}
		if (!state.enabled || !workflowMutex.isOwner(workflowOwner)) return;
		if (state.latestPlan || state.awaitingAction) {
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
		acceptCompletedPlan(parsedPlan.plan, "legacy_proposed_plan", ctx);
	});

	onAgentSettled(pi, async (_event, ctx) => {
		const settledImplementationId = implementationRetention.implementationSettled(
			state.activeImplementation,
		);
		if (settledImplementationId) clearActiveImplementation(settledImplementationId, ctx);

		if (
			finalizationRequest.hasPendingRequest() &&
			state.enabled &&
			workflowMutex.isOwner(workflowOwner)
		) {
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
		try {
			if (intent.source === "legacy_proposed_plan") {
				pi.sendMessage(
					{
						customType: PROPOSED_PLAN_MESSAGE_TYPE,
						content: `**Proposed Plan**\n\n${intent.plan}`,
						display: true,
					},
					{ triggerTurn: false },
				);
			}
			if (ctx.hasUI && completedPlanIsCurrent(intent)) {
				await planActions.showReady(latestCommandContext ?? ctx);
			}
		} catch (error: unknown) {
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
		const owner = workflowMutex.acquire();
		if (!owner) return reportWorkflowBusy(ctx);
		workflowOwner = owner;

		const previousState = state;
		try {
			if (!publishModeContract("plan", ctx)) {
				releaseWorkflowOwner();
				return false;
			}
		} catch (error: unknown) {
			releaseWorkflowOwner();
			throw error;
		}
		advanceWorkflowGeneration();
		try {
			modeContractsRelevant = true;
			state = {
				...state,
				enabled: true,
				awaitingAction: false,
				savedPlan: undefined,
				activeImplementation: undefined,
				selectedToolNames: candidate.selectedToolNames,
				selectedToolKeys: candidate.selectedToolKeys,
			};
			workflowAllowedToolNames = computePlanModePolicyToolNames();
			applyPlanThinkingLevel();
			persistState();
			updateUi(ctx);
			return true;
		} catch (error: unknown) {
			rollbackNewActivation(previousState, ctx);
			throw error;
		}
	}

	function enterPlanModeWithPrompt(prompt: string, ctx: ExtensionContext) {
		const previousState = state;
		const previousOwner = workflowOwner;
		const wasEnabled = state.enabled;
		if (!enterPlanMode(ctx)) return;
		if (!wasEnabled) {
			ctx.ui.notify("Plan mode enabled. I will explore and plan, but not modify files.", "info");
		}
		if (sendPlanModeUserMessage(prompt, ctx)) return;
		if (wasEnabled) return;
		rollbackNewActivation(previousState, ctx, previousOwner);
	}

	function exitPlanMode(ctx: ExtensionContext) {
		if (!allowModeTransition(ctx, "leave or clear Plan mode")) return false;
		const wasEnabled = state.enabled;
		if ((wasEnabled || modeContractsRelevant) && !publishModeContract("normal", ctx)) {
			return false;
		}
		advanceWorkflowGeneration();
		readyPresentationIntent = undefined;
		workflowAllowedToolNames = undefined;
		state = {
			...state,
			enabled: false,
			latestPlan: undefined,
			latestPlanSource: undefined,
			awaitingAction: false,
			savedPlan: undefined,
			activeImplementation: undefined,
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

	function publishModeContract(mode: PlanModeContract, ctx: ExtensionContext) {
		if (publishedContractMode === mode) return true;
		const { role: _role, timestamp: _timestamp, ...message } = createModeContractMessage(mode);
		try {
			pi.sendMessage(message, { triggerTurn: false });
			publishedContractMode = mode;
			modeContractsRelevant = true;
			return true;
		} catch (error: unknown) {
			const detail = error instanceof Error ? error.message : String(error);
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
			const detail = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Unable to send Plan-mode message: ${detail}`, "error");
			return false;
		}
	}

	function acceptCompletedPlan(plan: string, source: PlanCompletionSource, ctx: ExtensionContext) {
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
		persistState();
		updateUi(ctx);
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

	function togglePlanMode(ctx: ExtensionContext) {
		if (state.enabled) {
			const notification = planModeDisableNotification();
			if (exitPlanMode(ctx)) ctx.ui.notify(notification, "info");
			return;
		}
		if (savedPlanBlocksNewWorkflow(ctx, state.savedPlan !== undefined)) return;
		if (enterPlanMode(ctx)) {
			ctx.ui.notify("Plan mode enabled. I will explore and plan, but not modify files.", "info");
		}
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
		state = {
			...state,
			enabled: false,
			latestPlan: undefined,
			latestPlanSource: undefined,
			awaitingAction: false,
			savedPlan: { plan, source },
			activeImplementation: undefined,
			manualThinkingLevel: undefined,
		};
		restoreThinkingLevel();
		state = { ...state, manualThinkingLevel: undefined };
		persistState();
		updateUi(ctx);
		releaseWorkflowOwner();
		ctx.ui.notify("Plan saved for later. Plan mode disabled.", "info");
	}

	async function startFreshImplementation(ctx: ExtensionContext, menuIsCurrent: () => boolean) {
		await startFreshImplementationFromState(ctx, {
			getState: () => state,
			menuIsCurrent,
			retention: configuredImplementationPlanRetention(settings),
			stateEntryType: STATE_ENTRY_TYPE,
		});
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
		const source =
			(state.enabled ? state.latestPlanSource : savedPlan?.source) ?? "legacy_proposed_plan";
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
			activeImplementation: usesConversationHistory
				? undefined
				: {
						id: randomUUID(),
						plan,
						source,
						startedAt: Date.now(),
						retention,
					},
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
				publishModeContract("plan", ctx);
				workflowAllowedToolNames = computePlanModePolicyToolNames();
				applyPlanThinkingLevel();
			}
			persistState();
			updateUi(ctx);
			return;
		}
		if (wasEnabled) releaseWorkflowOwner();
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
		await ui.showPlanLaunchMenu(ctx, {
			statusText: "Status: Off — the session tool envelope is already stable.",
			initialScreen,
			getSelectedNames: () => snapshotPlanModeSelectedNames(tools, toolSelectionSnapshot()),
			toolSummary: (selectedNames) => {
				const allowed = tools
					.filter(
						(tool) =>
							toolIsActive(tool.name) &&
							selectedNames.has(tool.name) &&
							canSelectToolInPlanMode(tool),
					)
					.map((tool) => tool.name);
				return `Plan policy will allow: ${allowed.length > 0 ? allowed.join(", ") : "none"}.`;
			},
			tools: tools.map((tool) => {
				const selectable = canSelectToolInPlanMode(tool);
				const active = toolIsActive(tool.name);
				const policy = active ? toolPolicyLabel(tool) : "not active in this Pi session";
				const description = tool.description ?? "No description available";
				return {
					name: tool.name,
					description: `${policy} · ${description}`,
					searchText: [policy, description].join(" "),
					disabled: !selectable || !active,
					disabledReason: !active
						? "Not active in Pi; Plan mode will not activate it"
						: selectable
							? undefined
							: "Blocked by Plan-mode policy",
				};
			}),
			...lifecycle,
			start: (signal) => {
				if (signal.aborted || !lifecycle.isCurrent()) return;
				if (enterPlanMode(ctx)) {
					ctx.ui.notify(
						"Plan mode enabled. I will explore and plan, but not modify files.",
						"info",
					);
				}
			},
			startWithTools: (names, signal) => {
				if (signal.aborted || !lifecycle.isCurrent()) return;
				const selectedToolNames = filterAvailableSelectedToolNames(names, activePlanPolicyTools());
				if (enterPlanMode(ctx, { selectedToolNames, selectedToolKeys: undefined })) {
					ctx.ui.notify("Plan mode enabled with the selected tools.", "info");
				}
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
			show: () => showStoredPlan(pi, ctx, state),
			exportPlan: (path, signal) => planExports.export(path, ctx, signal, lifecycle.isCurrent),
			settings: (signal) => showSettings(ctx, signal, lifecycle.isCurrent),
			startNew: () => {
				if (enterPlanMode(ctx)) {
					ctx.ui.notify(
						"Plan mode enabled. I will explore and plan, but not modify files.",
						"info",
					);
				}
			},
			clear: () => {
				if (exitPlanMode(ctx)) ctx.ui.notify("Active implementation plan cleared.", "info");
			},
		});
	}

	async function showSettings(
		ctx: ExtensionContext,
		signal: AbortSignal,
		isCurrent: () => boolean,
	) {
		if (!isCurrent() || signal.aborted) return false;
		const ui = await loadInteractiveUi();
		if (!isCurrent() || signal.aborted) return false;
		const result = await ui.showPlanModeSettings(ctx, {
			tools: selectableTools(),
			activeToolNames: activeToolBaseline,
			signal,
			isCurrent,
			settingsPath: dependencies.settingsPath,
			onSaved: (saved) => {
				if (!isCurrent()) return;
				settings = saved;
				applyPlanModeShortcut(configuredPlanModeToggleShortcut(saved));
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
		workflowGeneration += 1;
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

	function establishStableToolEnvelope() {
		const activeTools = safeGetActiveTools();
		const stableTools = withRequiredPlanModeTools(activeTools);
		if (
			stableTools.length !== activeTools.length ||
			stableTools.some((toolName, index) => toolName !== activeTools[index])
		) {
			pi.setActiveTools(stableTools);
		}
		activeToolBaseline = stableTools;
	}

	function planModePolicyToolNames() {
		return workflowAllowedToolNames ?? computePlanModePolicyToolNames();
	}

	function computePlanModePolicyToolNames() {
		const tools = activePlanPolicyTools();
		const selectedNames = snapshotPlanModeSelectedNames(tools, toolSelectionSnapshot());
		return tools
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
			.filter(
				(tool) =>
					tool.name !== PLAN_MODE_QUESTION_TOOL_NAME && tool.name !== PLAN_MODE_COMPLETE_TOOL_NAME,
			)
			.sort(compareTools);
	}

	function activePlanPolicyTools() {
		const activeNames = new Set(activeToolBaseline);
		return selectableTools().filter((tool) => activeNames.has(tool.name));
	}

	function toolIsActive(toolName: string) {
		return activeToolBaseline.includes(toolName);
	}

	function safeGetAllTools() {
		try {
			return pi.getAllTools();
		} catch {
			return [];
		}
	}

	function applyPlanThinkingLevel() {
		if (state.manualThinkingLevel) {
			if (pi.getThinkingLevel() !== state.manualThinkingLevel) {
				setPlanThinkingLevel(pi, state.manualThinkingLevel);
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
		if (current !== configured) setPlanThinkingLevel(pi, configured);
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
		if (
			appliedThinkingLevel &&
			previousThinkingLevel &&
			pi.getThinkingLevel() === appliedThinkingLevel
		) {
			setPlanThinkingLevel(pi, previousThinkingLevel);
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
		const previousOwner = workflowOwner;
		const wasEnabled = state.enabled;
		if (candidate.enabled && !workflowMutex.isOwner(workflowOwner)) {
			const owner = workflowMutex.acquire();
			if (!owner) {
				state = { enabled: false, awaitingAction: false };
				workflowAllowedToolNames = undefined;
				reportRestoredWorkflowBusy(ctx);
				return false;
			}
			workflowOwner = owner;
		}

		try {
			if (wasEnabled && !candidate.enabled) {
				readyPresentationIntent = undefined;
				restoreThinkingLevel();
			}
			state = candidate;
			workflowAllowedToolNames = state.enabled ? computePlanModePolicyToolNames() : undefined;
			if (state.enabled) applyPlanThinkingLevel();
			else if (wasEnabled) releaseWorkflowOwner();
			return true;
		} catch (error: unknown) {
			try {
				if (!wasEnabled && state.enabled) restoreThinkingLevel();
			} finally {
				state = previousState;
				workflowAllowedToolNames = previousWorkflowAllowedToolNames;
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
export { withoutPlanModeQuestionTool, withRequiredPlanModeTools } from "./required-tools.js";
export { normalizePlanModeSettings, readPlanModeSettings } from "./settings.js";
export { canSelectToolInPlanMode, classifyPlanModeTool, isSafeCommand } from "./tool-policy.js";

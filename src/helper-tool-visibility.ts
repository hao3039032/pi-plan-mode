import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PLAN_MODE_COMPLETE_TOOL_NAME } from "./completion-tool.js";
import { PLAN_MODE_QUESTION_TOOL_NAME } from "./question-tool.js";
import type { PlanModeToolVisibility } from "./settings.js";

export const PLAN_MODE_HELPER_TOOL_NAMES = [
	PLAN_MODE_QUESTION_TOOL_NAME,
	PLAN_MODE_COMPLETE_TOOL_NAME,
] as const;

export interface PlanModeHelperVisibilitySnapshot {
	activeTools: string[];
	helperToolsUnlocked: boolean;
	helperToolsHiddenByPolicy: string[];
}

interface ToolVisibilityContext {
	isIdle?: () => boolean;
}

export class PlanModeHelperVisibilityPolicy {
	private unlocked = false;
	private readonly hiddenByPolicy = new Set<string>();

	constructor(private readonly pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">) {}

	isUnlocked() {
		return this.unlocked;
	}

	hasHiddenTools() {
		return this.hiddenByPolicy.size > 0;
	}

	toolsAvailable() {
		const active = new Set(this.pi.getActiveTools());
		return PLAN_MODE_HELPER_TOOL_NAMES.every((name) => active.has(name));
	}

	prepareSessionStart(visibility: PlanModeToolVisibility, previous: PlanModeToolVisibility) {
		if (visibility === "after-first-plan" && previous === "always") this.lock();
		if (visibility === "always") this.reveal();
	}

	reconcileInactiveState(visibility: PlanModeToolVisibility) {
		if (visibility === "after-first-plan" && !this.unlocked) this.hideIfLocked();
	}

	deferVisibilityChange(visibility: PlanModeToolVisibility) {
		if (visibility === "after-first-plan") this.lock();
	}

	prepareActivation(ctx: ToolVisibilityContext) {
		if (!this.toolsAvailable() && ctx.isIdle?.() !== true) {
			throw new Error("wait until Pi is idle before revealing the Plan tools");
		}
		this.reveal();
	}

	applyVisibilityChange(
		previous: PlanModeToolVisibility,
		next: PlanModeToolVisibility,
		ctx: ToolVisibilityContext,
	) {
		if (previous === next) return;
		if (next === "always") {
			if (!this.toolsAvailable() && ctx.isIdle?.() !== true) {
				throw new Error("Wait for Pi to become idle before revealing Plan tools.");
			}
			this.reveal();
			return;
		}
		if (ctx.isIdle?.() !== true) {
			throw new Error("Wait for Pi to become idle before hiding Plan tools.");
		}
		this.lock();
		this.hideIfLocked();
	}

	hideIfLocked() {
		if (this.unlocked) return;
		const active = this.pi.getActiveTools();
		const hidden = active.filter((name) => this.isHelperTool(name));
		if (hidden.length === 0) return;
		this.pi.setActiveTools(active.filter((name) => !this.isHelperTool(name)));
		for (const name of hidden) this.hiddenByPolicy.add(name);
	}

	snapshot(): PlanModeHelperVisibilitySnapshot {
		return {
			activeTools: this.pi.getActiveTools(),
			helperToolsUnlocked: this.unlocked,
			helperToolsHiddenByPolicy: [...this.hiddenByPolicy],
		};
	}

	restore(snapshot: PlanModeHelperVisibilitySnapshot) {
		this.pi.setActiveTools(snapshot.activeTools);
		this.unlocked = snapshot.helperToolsUnlocked;
		this.hiddenByPolicy.clear();
		for (const name of snapshot.helperToolsHiddenByPolicy) this.hiddenByPolicy.add(name);
	}

	private reveal() {
		const snapshot = this.snapshot();
		try {
			const active = this.pi.getActiveTools();
			const canonical = [
				...active.filter((name) => !this.isHelperTool(name)),
				...PLAN_MODE_HELPER_TOOL_NAMES,
			];
			if (
				canonical.length !== active.length ||
				canonical.some((name, index) => name !== active[index])
			) {
				this.pi.setActiveTools(canonical);
			}
			if (!this.toolsAvailable()) {
				throw new Error(
					"plan_mode_question and plan_mode_complete are unavailable; leave the restrictive tool mode before starting Plan mode",
				);
			}
			this.unlockAndForgetHidden();
		} catch (error) {
			this.restore(snapshot);
			throw error;
		}
	}

	private lock() {
		this.unlocked = false;
	}

	private unlockAndForgetHidden() {
		this.unlocked = true;
		this.hiddenByPolicy.clear();
	}

	private isHelperTool(name: string) {
		return (PLAN_MODE_HELPER_TOOL_NAMES as readonly string[]).includes(name);
	}
}

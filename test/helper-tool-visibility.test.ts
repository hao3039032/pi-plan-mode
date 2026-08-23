import assert from "node:assert/strict";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import {
	PLAN_MODE_HELPER_TOOL_NAMES,
	PlanModeHelperVisibilityPolicy,
} from "../src/helper-tool-visibility.js";

const HELPERS = [...PLAN_MODE_HELPER_TOOL_NAMES];

test("lazy visibility hides only Plan helpers it owns and restores them in canonical order", () => {
	const mock = createMockPi({
		activeTools: ["read", "plan_mode_complete", "custom", "plan_mode_question"],
	});
	const policy = new PlanModeHelperVisibilityPolicy(mock.pi);

	policy.reconcileInactiveState("after-first-plan");
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "custom"]);
	assert.equal(policy.hasHiddenTools(), true);

	mock.rawPi.setActiveTools(["read", "custom", "external"]);
	policy.prepareActivation(createMockContext().ctx);
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "custom", "external", ...HELPERS]);
	assert.equal(policy.hasHiddenTools(), false);
	assert.equal(policy.isUnlocked(), true);
});

test("lazy visibility stays unlocked after activation and across session reconciliation", () => {
	const mock = createMockPi({ activeTools: ["read", ...HELPERS] });
	const policy = new PlanModeHelperVisibilityPolicy(mock.pi);
	const context = createMockContext();

	policy.reconcileInactiveState("after-first-plan");
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read"]);
	policy.prepareActivation(context.ctx);
	policy.reconcileInactiveState("after-first-plan");

	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", ...HELPERS]);
	assert.equal(policy.isUnlocked(), true);
});

test("always visibility canonicalizes helpers while lazy setting changes reset an inactive runtime", () => {
	const mock = createMockPi({
		activeTools: ["read", "plan_mode_complete", "plan_mode_question"],
	});
	const policy = new PlanModeHelperVisibilityPolicy(mock.pi);
	const context = createMockContext();

	policy.prepareSessionStart("always", "after-first-plan");
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", ...HELPERS]);
	policy.applyVisibilityChange("always", "after-first-plan", context.ctx);
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read"]);
	assert.equal(policy.isUnlocked(), false);
});

test("deferred lazy visibility keeps the current envelope and locks the next safe boundary", () => {
	const mock = createMockPi({ activeTools: ["read", ...HELPERS] });
	const policy = new PlanModeHelperVisibilityPolicy(mock.pi);
	policy.prepareSessionStart("always", "after-first-plan");

	policy.deferVisibilityChange("after-first-plan");
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", ...HELPERS]);
	policy.prepareSessionStart("after-first-plan", "after-first-plan");
	policy.reconcileInactiveState("after-first-plan");
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read"]);
});

test("busy visibility changes and activations preserve the exact external tool state", () => {
	const mock = createMockPi({ activeTools: ["read"] });
	const policy = new PlanModeHelperVisibilityPolicy(mock.pi);
	const busy = createMockContext({ isIdle: () => false });

	assert.throws(() => policy.prepareActivation(busy.ctx), /wait until Pi is idle/i);
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read"]);

	policy.prepareSessionStart("always", "after-first-plan");
	assert.throws(
		() => policy.applyVisibilityChange("always", "after-first-plan", busy.ctx),
		/idle before hiding/i,
	);
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", ...HELPERS]);
});

test("failed activation restores active tools and policy ownership exactly", () => {
	const mock = createMockPi({ activeTools: ["read"] });
	const policy = new PlanModeHelperVisibilityPolicy(mock.pi);
	const snapshot = policy.snapshot();
	const setActiveTools = mock.rawPi.setActiveTools.bind(mock.rawPi);
	mock.rawPi.setActiveTools = (names) => {
		setActiveTools(names.filter((name) => name !== "plan_mode_complete"));
	};

	assert.throws(
		() => policy.prepareActivation(createMockContext().ctx),
		/plan_mode_question and plan_mode_complete are unavailable/i,
	);
	mock.rawPi.setActiveTools = setActiveTools;
	assert.deepEqual(policy.snapshot(), snapshot);
});

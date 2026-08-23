import assert from "node:assert/strict";
import { test } from "vitest";
import { builtinTool, createMockContext, createMockPi } from "../../../test/support.js";
import { createModeContractMessage } from "../src/mode-contract.js";
import planMode from "../src/plan-mode.js";

const PLAN = "# Branch-owned plan\n\n1. Restore this branch.";
const BASELINE = ["read", "bash", "edit", "write", "plan_mode_question", "plan_mode_complete"];

function stateEntry(data: Record<string, unknown>) {
	return { type: "custom", customType: "plan-mode-state", data };
}

function contractEntry(mode: "plan" | "normal") {
	const { role: _role, timestamp: _timestamp, ...message } = createModeContractMessage(mode, 10);
	return { type: "custom_message", ...message };
}

test("manual tree navigation restores branch-owned mode state without changing the tool envelope", async () => {
	const branch: unknown[] = [];
	const sessionManager = {
		getBranch: () => branch,
		getEntries: () => branch,
	};
	const mock = createMockPi({
		activeTools: ["read", "bash", "edit", "write"],
		allTools: [builtinTool("read"), builtinTool("bash"), builtinTool("edit"), builtinTool("write")],
		thinkingLevel: "low",
	});
	planMode(mock.pi, {
		readSettings: async () => ({
			kind: "loaded" as const,
			settings: { thinkingLevel: "medium" as const },
		}),
	});
	const context = createMockContext({ sessionManager });
	await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
	const tree = mock.events.get("session_tree")?.[0];
	assert.ok(tree);
	assert.deepEqual(mock.rawPi.getActiveTools(), BASELINE);

	branch.splice(
		0,
		branch.length,
		contractEntry("plan"),
		stateEntry({
			enabled: true,
			awaitingAction: false,
			previousThinkingLevel: "low",
			appliedThinkingLevel: "medium",
		}),
	);
	await tree({}, context.ctx);
	assert.equal(context.statuses.get("plan-mode"), "plan active");
	assert.equal(mock.thinkingLevel, "medium");
	assert.deepEqual(mock.rawPi.getActiveTools(), BASELINE);

	branch.splice(
		0,
		branch.length,
		contractEntry("normal"),
		stateEntry({
			enabled: false,
			awaitingAction: false,
			savedPlan: { plan: PLAN, source: "plan_mode_complete" },
		}),
	);
	await tree({}, context.ctx);
	assert.equal(context.statuses.get("plan-mode"), "plan saved");
	assert.equal(mock.thinkingLevel, "low");
	assert.deepEqual(mock.rawPi.getActiveTools(), BASELINE);

	branch.splice(
		0,
		branch.length,
		contractEntry("normal"),
		stateEntry({
			enabled: false,
			awaitingAction: false,
			activeImplementation: {
				id: "branch-implementation",
				plan: PLAN,
				source: "plan_mode_complete",
				startedAt: 42,
				retention: "keep",
			},
		}),
	);
	await tree({}, context.ctx);
	assert.equal(context.statuses.get("plan-mode"), "plan implementing");
	assert.deepEqual(mock.rawPi.getActiveTools(), BASELINE);

	branch.splice(0, branch.length);
	await tree({}, context.ctx);
	assert.equal(context.statuses.get("plan-mode"), undefined);
	assert.equal(context.widgets.get("plan-mode-plan"), undefined);
	assert.equal(mock.thinkingLevel, "low");
	assert.deepEqual(mock.rawPi.getActiveTools(), BASELINE);
	assert.equal(mock.sentUserMessages.length, 0);
	assert.equal(mock.sentMessages.length, 0);
});

test("failed inline kickoff publishes a Normal rollback contract and restores inactive state", async () => {
	const mock = createMockPi({ activeTools: ["read", "write"] });
	mock.rawPi.sendUserMessage = () => {
		throw new Error("kickoff failed");
	};
	planMode(mock.pi);
	const context = createMockContext({ mode: "tui", hasUI: true });

	await mock.commands.get("plan")?.handler("plan a rollback", context.ctx);

	assert.equal(context.statuses.get("plan-mode"), undefined);
	assert.equal(mock.sentMessages.length, 2);
	assert.match(JSON.stringify(mock.sentMessages[0]?.message), /CONTRACT v1: PLAN/u);
	assert.match(JSON.stringify(mock.sentMessages[1]?.message), /CONTRACT v1: NORMAL/u);
	assert.equal((mock.entries.at(-1)?.data as { enabled?: boolean } | undefined)?.enabled, false);
	assert.match(context.notifications.at(-1)?.message ?? "", /kickoff failed/u);
});

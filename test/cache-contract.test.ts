import assert from "node:assert/strict";
import { test } from "vitest";
import { builtinTool, createMockContext, createMockPi } from "../../../test/support.js";
import planMode from "../src/plan-mode.js";

interface CapturedRequest {
	phase: "normal" | "plan" | "implementation";
	activeTools: string[];
	systemPrompt: string;
	messages: unknown[];
	activePromptMetadata: Array<{
		name: string;
		promptSnippet: unknown;
		promptGuidelines: unknown;
	}>;
	providerPayload: {
		instructions: string;
		tools: Array<{ name: string; description: unknown; parameters: unknown }>;
		messages: unknown[];
	};
}

async function captureRequest(
	phase: CapturedRequest["phase"],
	mock: ReturnType<typeof createMockPi>,
	ctx: ReturnType<typeof createMockContext>["ctx"],
	messages: unknown[],
): Promise<CapturedRequest> {
	const baseSystemPrompt = "stable base system prompt";
	const beforeStart = mock.events.get("before_agent_start")?.[0];
	const contextHook = mock.events.get("context")?.[0];
	const beforeResult = (await beforeStart?.(
		{ prompt: phase, systemPrompt: baseSystemPrompt },
		ctx,
	)) as { systemPrompt?: string } | undefined;
	const contextResult = (await contextHook?.({ messages }, ctx)) as
		| { messages?: unknown[] }
		| undefined;
	const activeTools = mock.rawPi.getActiveTools();
	const allTools = [...mock.rawPi.getAllTools(), ...mock.tools];
	const toolByName = new Map(
		allTools.map((tool) => [(tool as { name: string }).name, tool as Record<string, unknown>]),
	);
	const orderedDefinitions = activeTools.map((name) => {
		const tool = toolByName.get(name);
		return { name, description: tool?.description, parameters: tool?.parameters };
	});
	const systemPrompt = beforeResult?.systemPrompt ?? baseSystemPrompt;
	const visibleMessages = contextResult?.messages ?? messages;
	return {
		phase,
		activeTools,
		systemPrompt,
		messages: visibleMessages,
		activePromptMetadata: activeTools.map((name) => {
			const tool = toolByName.get(name);
			return {
				name,
				promptSnippet: tool?.promptSnippet,
				promptGuidelines: tool?.promptGuidelines,
			};
		}),
		providerPayload: {
			instructions: systemPrompt,
			tools: orderedDefinitions,
			messages: visibleMessages,
		},
	};
}

async function completePlan(mock: ReturnType<typeof createMockPi>, ctx: unknown) {
	const complete = mock.tools.find((tool) => tool.name === "plan_mode_complete")?.execute as
		| ((...args: unknown[]) => Promise<unknown>)
		| undefined;
	assert.ok(complete);
	await complete("complete", { plan: "# Cache-stable plan" }, undefined, undefined, ctx);
}

test("always-visible cache contract keeps request fields stable across modes", async () => {
	const allTools = [
		builtinTool("read"),
		builtinTool("bash"),
		builtinTool("edit"),
		builtinTool("write"),
	];
	const mock = createMockPi({ activeTools: ["read", "bash", "edit", "write"], allTools });
	planMode(mock.pi, {
		readSettings: async () => ({
			kind: "loaded" as const,
			settings: { thinkingLevel: "inherit" as const, toolVisibility: "always" as const },
		}),
	});
	const context = createMockContext();
	await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);

	const normal = await captureRequest("normal", mock, context.ctx, [
		{ role: "user", content: "A" },
	]);
	await mock.commands.get("plan")?.handler("start", context.ctx);
	const planContract = mock.sentMessages.at(-1)?.message;
	const plan = await captureRequest("plan", mock, context.ctx, [
		{ role: "user", content: "A" },
		planContract,
		{ role: "user", content: "B" },
	]);
	await completePlan(mock, context.ctx);
	await mock.commands.get("plan")?.handler("implement", context.ctx);
	const normalContract = mock.sentMessages.at(-1)?.message;
	const implementation = await captureRequest("implementation", mock, context.ctx, [
		{ role: "user", content: "A" },
		planContract,
		{ role: "user", content: "B" },
		normalContract,
		{ role: "user", content: "Implement the plan." },
	]);

	assert.deepEqual(plan.activeTools, normal.activeTools);
	assert.deepEqual(implementation.activeTools, normal.activeTools);
	assert.equal(plan.systemPrompt, normal.systemPrompt);
	assert.equal(implementation.systemPrompt, normal.systemPrompt);
	assert.deepEqual(plan.providerPayload.tools, normal.providerPayload.tools);
	assert.deepEqual(implementation.providerPayload.tools, normal.providerPayload.tools);
	assert.deepEqual(plan.activePromptMetadata, normal.activePromptMetadata);
	assert.deepEqual(implementation.activePromptMetadata, normal.activePromptMetadata);
	assert.equal(plan.providerPayload.instructions, normal.providerPayload.instructions);
	assert.equal(implementation.providerPayload.instructions, normal.providerPayload.instructions);
	assert.match(JSON.stringify(plan.messages), /CONTRACT v1: PLAN/u);
	assert.match(JSON.stringify(implementation.messages), /CONTRACT v1: NORMAL/u);
	assert.match(JSON.stringify(implementation.messages), /CONTRACT v1: PLAN/u);
	assert.deepEqual(
		implementation.messages
			.filter((message) => (message as { role?: string }).role === "user")
			.map((message) => (message as { content?: unknown }).content),
		["A", "B", "Implement the plan."],
	);
});

test("after-first-plan changes helper definitions once and keeps the unlocked prefix stable", async () => {
	const allTools = [
		builtinTool("read"),
		builtinTool("bash"),
		builtinTool("edit"),
		builtinTool("write"),
	];
	const mock = createMockPi({ activeTools: ["read", "bash", "edit", "write"], allTools });
	planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
	const context = createMockContext();
	await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);

	const normal = await captureRequest("normal", mock, context.ctx, [
		{ role: "user", content: "A" },
	]);
	await mock.commands.get("plan")?.handler("start", context.ctx);
	const planContract = mock.sentMessages.at(-1)?.message;
	const plan = await captureRequest("plan", mock, context.ctx, [
		{ role: "user", content: "A" },
		planContract,
		{ role: "user", content: "B" },
	]);
	await completePlan(mock, context.ctx);
	await mock.commands.get("plan")?.handler("implement", context.ctx);
	const implementation = await captureRequest("implementation", mock, context.ctx, [
		{ role: "user", content: "A" },
		planContract,
		{ role: "user", content: "B" },
		mock.sentMessages.at(-1)?.message,
		{ role: "user", content: "Implement the plan." },
	]);

	assert.deepEqual(normal.activeTools, ["read", "bash", "edit", "write"]);
	assert.deepEqual(plan.activeTools, [
		"read",
		"bash",
		"edit",
		"write",
		"plan_mode_question",
		"plan_mode_complete",
	]);
	assert.deepEqual(implementation.activeTools, plan.activeTools);
	assert.notDeepEqual(plan.providerPayload.tools, normal.providerPayload.tools);
	assert.deepEqual(implementation.providerPayload.tools, plan.providerPayload.tools);
	assert.notDeepEqual(plan.activePromptMetadata, normal.activePromptMetadata);
	assert.deepEqual(implementation.activePromptMetadata, plan.activePromptMetadata);
	assert.equal(plan.systemPrompt, normal.systemPrompt);
	assert.equal(implementation.systemPrompt, plan.systemPrompt);
});

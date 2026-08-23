import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
	builtinTool,
	createMockContext,
	createMockPi,
	extensionTool,
} from "../../../test/support.js";
import planMode from "../src/plan-mode.js";

const HELPERS = ["plan_mode_question", "plan_mode_complete"];

async function start(mock: ReturnType<typeof createMockPi>, context = createMockContext()) {
	await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
	await mock.commands.get("plan")?.handler("start", context.ctx);
	return context;
}

async function callTool(
	mock: ReturnType<typeof createMockPi>,
	context: ReturnType<typeof createMockContext>,
	toolName: string,
	input: unknown = {},
) {
	return mock.events.get("tool_call")?.[0]?.({ toolName, input }, context.ctx);
}

test("session startup appends helpers once and every Plan transition keeps the exact baseline", async () => {
	const baseline = ["read", "bash", "edit", "write", "custom", ...HELPERS];
	const mock = createMockPi({
		activeTools: ["read", "bash", "edit", "write", "custom"],
		allTools: [
			builtinTool("read"),
			builtinTool("bash"),
			builtinTool("edit"),
			builtinTool("write"),
			extensionTool("custom"),
		],
	});
	const writes: string[][] = [];
	const setActiveTools = mock.rawPi.setActiveTools.bind(mock.rawPi);
	mock.rawPi.setActiveTools = (names) => {
		writes.push([...names]);
		setActiveTools(names);
	};
	planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
	const context = createMockContext();

	await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
	assert.deepEqual(mock.rawPi.getActiveTools(), baseline);
	assert.deepEqual(writes, [baseline]);
	await mock.events.get("session_start")?.[0]?.({ reason: "reload" }, context.ctx);
	assert.deepEqual(writes, [baseline]);

	await mock.commands.get("plan")?.handler("start", context.ctx);
	assert.deepEqual(mock.rawPi.getActiveTools(), baseline);
	await mock.commands.get("plan")?.handler("exit", context.ctx);
	assert.deepEqual(mock.rawPi.getActiveTools(), baseline);
	await mock.events.get("session_shutdown")?.[0]?.({ reason: "quit" }, context.ctx);
	assert.deepEqual(mock.rawPi.getActiveTools(), baseline);
	assert.deepEqual(writes, [baseline]);
});

test("configured Plan tools are an allowlist over active tools, not an activation request", async () => {
	await withAgentDir(async (agentDir) => {
		const settingsPath = join(agentDir, "pi-plan-mode.json");
		await writeFile(
			settingsPath,
			JSON.stringify({ defaultPlanTools: ["bash", "custom", "write", "missing"] }),
		);
		const baseline = ["read", "write", ...HELPERS];
		const mock = createMockPi({
			activeTools: ["read", "write"],
			allTools: [
				builtinTool("read"),
				builtinTool("bash"),
				builtinTool("write"),
				extensionTool("custom"),
			],
		});
		planMode(mock.pi);
		const context = await start(mock);

		assert.deepEqual(mock.rawPi.getActiveTools(), baseline);
		for (const name of ["read", "bash", "custom", "write", "missing"]) {
			const result = (await callTool(mock, context, name)) as { block?: boolean } | undefined;
			assert.equal(result?.block, true, name);
		}
		assert.deepEqual(
			(JSON.parse(await readFile(settingsPath, "utf8")) as { defaultPlanTools: string[] })
				.defaultPlanTools,
			["bash", "custom", "write", "missing"],
		);
	});
});

test("active selected custom tools execute while deselected and mutating tools fail closed", async () => {
	const baseline = ["read", "bash", "write", "custom", ...HELPERS];
	const mock = createMockPi({
		activeTools: ["read", "bash", "write", "custom"],
		allTools: [
			builtinTool("read"),
			builtinTool("bash"),
			builtinTool("write"),
			extensionTool("custom"),
		],
	});
	planMode(mock.pi, {
		readSettings: async () => ({
			kind: "loaded" as const,
			settings: { thinkingLevel: "inherit" as const, defaultPlanTools: ["bash", "custom"] },
		}),
	});
	const context = await start(mock);

	assert.deepEqual(mock.rawPi.getActiveTools(), baseline);
	assert.equal(await callTool(mock, context, "custom"), undefined);
	assert.equal(await callTool(mock, context, "bash", { command: "git status --short" }), undefined);
	for (const name of ["read", "write", "update_plan"]) {
		const result = (await callTool(mock, context, name)) as { block?: boolean } | undefined;
		assert.equal(result?.block, true, name);
	}
});

test("automatic and explicit-empty policy defaults remain distinct without changing schemas", async () => {
	const allTools = [builtinTool("read"), builtinTool("bash"), builtinTool("write")];
	for (const [configured, allowed] of [
		[undefined, ["read", "bash"]],
		[[], []],
	] as const) {
		const mock = createMockPi({ activeTools: ["read", "bash", "write"], allTools });
		planMode(mock.pi, {
			readSettings: async () => ({
				kind: "loaded" as const,
				settings: {
					thinkingLevel: "inherit" as const,
					...(configured === undefined ? {} : { defaultPlanTools: [...configured] }),
				},
			}),
		});
		const context = await start(mock);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash", "write", ...HELPERS]);
		for (const name of ["read", "bash"]) {
			const result = (await callTool(
				mock,
				context,
				name,
				name === "bash" ? { command: "git status --short" } : {},
			)) as { block?: boolean } | undefined;
			assert.equal(
				result?.block,
				allowed.some((candidate) => candidate === name) ? undefined : true,
				name,
			);
		}
	}
});

test("an active workflow snapshots defaults instead of following later settings changes", async () => {
	const loaded = {
		thinkingLevel: "inherit" as const,
		defaultPlanTools: ["read"],
	};
	const mock = createMockPi({
		activeTools: ["read", "bash"],
		allTools: [builtinTool("read"), builtinTool("bash")],
	});
	planMode(mock.pi, {
		readSettings: async () => ({ kind: "loaded" as const, settings: loaded }),
	});
	const context = await start(mock);
	loaded.defaultPlanTools = ["bash"];

	assert.equal(await callTool(mock, context, "read"), undefined);
	assert.equal(
		((await callTool(mock, context, "bash", { command: "pwd" })) as { block?: boolean }).block,
		true,
	);
});

test("branch-restored selections constrain policy while helpers remain model-visible", async () => {
	const stateEntry = {
		type: "custom",
		customType: "plan-mode-state",
		data: { enabled: true, awaitingAction: false, selectedToolNames: ["read"] },
	};
	const mock = createMockPi({
		activeTools: ["read", "bash", "write"],
		allTools: [builtinTool("read"), builtinTool("bash"), builtinTool("write")],
	});
	planMode(mock.pi);
	const context = createMockContext({
		sessionManager: {
			getBranch: () => [stateEntry],
			getEntries: () => [stateEntry],
		},
	});
	await mock.events.get("session_start")?.[0]?.({ reason: "resume" }, context.ctx);

	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash", "write", ...HELPERS]);
	assert.equal(await callTool(mock, context, "read"), undefined);
	assert.equal(
		((await callTool(mock, context, "bash", { command: "pwd" })) as { block?: boolean }).block,
		true,
	);
});

async function withAgentDir(run: (agentDir: string) => Promise<void>) {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-plan-mode-default-tools-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await run(agentDir);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	}
}

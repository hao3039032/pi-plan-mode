import assert from "node:assert/strict";
import { test } from "vitest";
import planMode from "../src/plan-mode.js";
import { isSafeCommand, isSafePowerShellCommand } from "../src/tool-policy.js";
import { builtinTool, createMockContext, createMockPi, extensionTool } from "./support.js";

const CUSTOM_TOOL = "research_tool";

type ToolCallResult = { block?: boolean; reason?: string } | undefined;

async function startPlan(options: {
	configured?: string[];
	activeTools: string[];
	allTools: ReturnType<typeof builtinTool>[];
}) {
	const mock = createMockPi({ activeTools: options.activeTools, allTools: options.allTools });
	planMode(mock.pi, {
		readSettings: async () => ({
			kind: "loaded" as const,
			settings: {
				thinkingLevel: "inherit" as const,
				...(options.configured === undefined ? {} : { defaultPlanTools: options.configured }),
			},
		}),
	});
	const context = createMockContext();
	await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
	await mock.commands.get("plan")?.handler("start", context.ctx);
	return { context, mock };
}

async function callTool(
	fixture: Awaited<ReturnType<typeof startPlan>>,
	toolName: string,
	input: unknown = {},
) {
	return fixture.mock.events.get("tool_call")?.[0]?.(
		{ toolName, input },
		fixture.context.ctx,
	) as ToolCallResult;
}

test("issue 1039: any active extension tool requires explicit Plan-policy opt-in", async () => {
	const automatic = await startPlan({
		activeTools: ["read", CUSTOM_TOOL],
		allTools: [builtinTool("read"), extensionTool(CUSTOM_TOOL)],
	});
	assert.deepEqual(await callTool(automatic, CUSTOM_TOOL), {
		block: true,
		reason: `Plan mode blocks tool '${CUSTOM_TOOL}' because it is not selected by the Plan policy. Exit Plan mode, then enable it with /plan tools or defaultPlanTools before starting again.`,
	});

	const explicit = await startPlan({
		configured: [CUSTOM_TOOL],
		activeTools: ["read", CUSTOM_TOOL],
		allTools: [builtinTool("read"), extensionTool(CUSTOM_TOOL)],
	});
	assert.equal(await callTool(explicit, CUSTOM_TOOL), undefined);
});

test("issue 1039: denied tools report inactive, unavailable, frozen, and blocked policy states", async () => {
	const inactive = await startPlan({
		configured: [CUSTOM_TOOL],
		activeTools: ["read"],
		allTools: [builtinTool("read"), extensionTool(CUSTOM_TOOL)],
	});
	assert.deepEqual(await callTool(inactive, CUSTOM_TOOL), {
		block: true,
		reason: `Plan mode blocks tool '${CUSTOM_TOOL}' because it is registered but inactive. Activate it before starting the next Plan workflow.`,
	});

	const late = await startPlan({
		configured: [CUSTOM_TOOL],
		activeTools: ["read"],
		allTools: [builtinTool("read"), extensionTool(CUSTOM_TOOL)],
	});
	late.mock.rawPi.setActiveTools(["read", CUSTOM_TOOL, "plan_mode_question", "plan_mode_complete"]);
	assert.deepEqual(await callTool(late, CUSTOM_TOOL), {
		block: true,
		reason: `Plan mode blocks tool '${CUSTOM_TOOL}' because it was not available when the active Plan workflow froze its tool policy. Exit Plan mode, then start again after the tool is active.`,
	});

	const unavailable = await startPlan({
		configured: [CUSTOM_TOOL],
		activeTools: ["read"],
		allTools: [builtinTool("read")],
	});
	assert.deepEqual(await callTool(unavailable, CUSTOM_TOOL), {
		block: true,
		reason: `Plan mode blocks tool '${CUSTOM_TOOL}' because it is not registered or active. Register and activate it before starting the next Plan workflow.`,
	});

	const metadataFree = await startPlan({
		configured: [CUSTOM_TOOL],
		activeTools: ["read", CUSTOM_TOOL],
		allTools: [builtinTool("read")],
	});
	assert.deepEqual(await callTool(metadataFree, CUSTOM_TOOL), {
		block: true,
		reason: `Plan mode blocks tool '${CUSTOM_TOOL}' because its safe policy metadata is unavailable.`,
	});

	const blockedBuiltin = await startPlan({
		configured: ["danger"],
		activeTools: ["read", "danger"],
		allTools: [builtinTool("read"), builtinTool("danger")],
	});
	assert.deepEqual(await callTool(blockedBuiltin, "danger"), {
		block: true,
		reason:
			"Plan mode blocks tool 'danger' because its built-in policy is blocked and settings cannot enable it.",
	});
});

test("issue 1039: reviewed git -C inspections work with fsmonitor disabled", async () => {
	for (const command of [
		"git -c core.fsmonitor=false -C /tmp/repository status --short",
		"git --no-pager -c core.fsmonitor=false -C /tmp/repository log -1 --oneline --no-ext-diff --no-textconv",
		"git -c core.fsmonitor=false -C packages -C pi-plan-mode diff --check --no-ext-diff --no-textconv",
		"git -C packages --no-pager -c core.fsmonitor=false status --short",
	]) {
		assert.equal(isSafeCommand(command), true, `Bash: ${command}`);
		assert.equal(isSafePowerShellCommand(command), true, `PowerShell: ${command}`);
	}
	const configured = "git -c core.fsmonitor=false -C /tmp/repository rev-parse --show-toplevel";
	assert.equal(isSafeCommand(configured), false);
	assert.equal(isSafePowerShellCommand(configured), false);
	assert.equal(isSafeCommand(configured, { git: ["rev-parse"] }), true);
	assert.equal(isSafePowerShellCommand(configured, { git: ["rev-parse"] }), true);

	const fixture = await startPlan({
		activeTools: ["bash", "powershell"],
		allTools: [builtinTool("bash"), builtinTool("powershell")],
	});
	assert.equal(
		await callTool(fixture, "bash", {
			command: "git -c core.fsmonitor=false -C /tmp/repository status --short",
		}),
		undefined,
	);
	assert.equal(
		await callTool(fixture, "powershell", {
			command: "git -c core.fsmonitor=false -C 'C:\\repository path' status --short",
		}),
		undefined,
	);
});

test("issue 1039: git -C remains fail-closed for malformed and unsafe commands", () => {
	for (const command of [
		"git -C",
		"git -C --no-pager status",
		"git -C /tmp/repository status --short",
		"git -c core.fsmonitor=false -C /tmp/repository diff --check",
		"git -c core.fsmonitor=false -C /tmp/repository diff --check --no-ext-diff",
		"git -c core.fsmonitor=false -C /tmp/repository log -p -1 --no-textconv",
		"git -c core.fsmonitor=true -C /tmp/repository status --short",
		"git -c alias.status=!touch -C /tmp/repository status",
		"git -c core.fsmonitor=false -C /tmp/repository checkout main",
		"git -c core.fsmonitor=false -C /tmp/repository clean -fd",
		"git -c core.fsmonitor=false -C /tmp/repository --exec-path=/tmp status",
		"git -c core.fsmonitor=false -C /tmp/repository diff --ext-diff",
		"git -c core.fsmonitor=false -C /tmp/repository log --show-signature -1",
		"git --git-dir=/tmp/repository status",
	]) {
		assert.equal(isSafeCommand(command), false, `Bash: ${command}`);
		assert.equal(isSafePowerShellCommand(command), false, `PowerShell: ${command}`);
	}
});

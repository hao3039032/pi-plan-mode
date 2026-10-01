import assert from "node:assert/strict";
import { test } from "vitest";
import planMode from "./support.js";
import { builtinTool, createMockContext, createMockPi, extensionTool } from "./support.js";

// Fork behavior: tools that are explicitly selected for Plan mode but only become active after the
// workflow froze its policy (for example pi-web-access tools enabled through web_enable) are admitted
// on first use instead of requiring a Plan restart.

const HELPERS = ["plan_mode_question", "plan_mode_complete"];
const WEB_TOOLS = ["web_search", "fetch_content"];

type ToolCallResult = { block?: boolean; reason?: string } | undefined;

async function startPlan(configured: string[] | undefined) {
  const mock = createMockPi({
    activeTools: ["read", "bash", "web_enable"],
    allTools: [
      builtinTool("read"),
      builtinTool("bash"),
      builtinTool("write"),
      extensionTool("web_enable"),
      extensionTool("unlisted_tool"),
      ...WEB_TOOLS.map(extensionTool),
    ],
  });
  planMode(mock.pi, {
    readSettings: async () => ({
      kind: "loaded" as const,
      settings: {
        thinkingLevel: "inherit" as const,
        ...(configured === undefined ? {} : { defaultPlanTools: configured }),
      },
    }),
  });
  const context = createMockContext();
  await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
  await mock.commands.get("plan")?.handler("start", context.ctx);
  // First provider-bound context freezes the workflow policy.
  await mock.events.get("context")?.[0]?.({ messages: [] }, context.ctx);
  const callTool = async (toolName: string, input: unknown = {}) =>
    (await mock.events.get("tool_call")?.[0]?.({ toolName, input }, context.ctx)) as ToolCallResult;
  const activate = (...names: string[]) =>
    mock.rawPi.setActiveTools([...new Set([...mock.rawPi.getActiveTools(), ...names, ...HELPERS])]);
  return { mock, callTool, activate };
}

function latestPolicy(entries: Array<{ customType: string; data: unknown }>) {
  const state = entries.filter((entry) => entry.customType === "plan-mode-state").at(-1)?.data as
    | { workflowToolPolicy?: { allowedNames: string[]; resolved: boolean } }
    | undefined;
  return state?.workflowToolPolicy;
}

test("explicitly selected tools activated after the freeze are admitted and persisted", async () => {
  const plan = await startPlan(["read", "bash", "web_enable", ...WEB_TOOLS]);
  assert.deepEqual(latestPolicy(plan.mock.entries)?.allowedNames?.toSorted(), ["bash", "read", "web_enable"]);

  // web_enable itself is allowed; it then activates the web tools mid-workflow.
  assert.equal(await plan.callTool("web_enable"), undefined);
  plan.activate(...WEB_TOOLS);

  assert.equal(await plan.callTool("web_search"), undefined);
  assert.equal(await plan.callTool("fetch_content"), undefined);
  const policy = latestPolicy(plan.mock.entries);
  assert.equal(policy?.resolved, true);
  assert.deepEqual(policy?.allowedNames.toSorted(), ["bash", "fetch_content", "read", "web_enable", "web_search"]);
});

test("late activation does not admit unselected, inactive, or blocked tools", async () => {
  const plan = await startPlan(["read", "web_enable", ...WEB_TOOLS, "write"]);

  assert.deepEqual(await plan.callTool("web_search"), {
    block: true,
    reason:
      "Plan mode blocks tool 'web_search' because it is registered but inactive. Activate it before starting the next Plan workflow.",
  });

  plan.activate("unlisted_tool", "write");
  assert.deepEqual(await plan.callTool("unlisted_tool"), {
    block: true,
    reason:
      "Plan mode blocks tool 'unlisted_tool' because it is not selected by the Plan policy. Exit Plan mode, then enable it with /plan tools or defaultPlanTools before starting again.",
  });
  assert.equal((await plan.callTool("write"))?.block, true);
});

test("automatic policy keeps freezing late-activated tools", async () => {
  const plan = await startPlan(undefined);
  plan.activate(...WEB_TOOLS);
  assert.equal((await plan.callTool("web_search"))?.block, true);
});

test("a late-admitted bash tool runs inside the srt sandbox wrap", async () => {
  const mock = createMockPi({ activeTools: ["read"], allTools: [builtinTool("read"), builtinTool("bash")] });
  planMode(mock.pi, {
    readSettings: async () => ({
      kind: "loaded" as const,
      settings: { thinkingLevel: "inherit" as const, defaultPlanTools: ["read", "bash"] },
    }),
  });
  const context = createMockContext();
  await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
  await mock.commands.get("plan")?.handler("start", context.ctx);
  await mock.events.get("context")?.[0]?.({ messages: [] }, context.ctx);
  mock.rawPi.setActiveTools(["read", "bash", ...HELPERS]);

  const call = (command: string) =>
    mock.events.get("tool_call")?.[0]?.(
      { toolName: "bash", input: { command } },
      context.ctx,
    ) as Promise<ToolCallResult>;
  // Sandboxed exploration: any command, including mutations, is admitted and wrapped for srt;
  // the OS sandbox — not a command-text policy — denies the actual writes.
  assert.equal(await call("git status"), undefined);
  assert.equal(await call("rm -rf build"), undefined);
  const wrappedInput = { command: "git status --short" };
  await mock.events.get("tool_call")?.[0]?.({ toolName: "bash", input: wrappedInput }, context.ctx);
  assert.match(wrappedInput.command, /^'.*srt' -s '.*' -c 'git status --short'$/u);
});

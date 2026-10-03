import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "vitest";
import {
  classifySubagentCall,
  clearReadOnlyAgentVerificationCache,
  createPlanScoutManager,
  decideDelegationAdmission,
  type PreflightResolver,
  type SubagentPreflightResult,
  parentReadOnlyToolNames,
  readOnlyToolUniverse,
  verifyReadOnlyAgent,
} from "../src/plan-scout.js";
import { buildPlanModePrompt } from "../src/prompt.js";
import { normalizePlanModeSettings, updatePlanModeSettings } from "../src/settings.js";
import { extensionTool } from "./tool-exposure-support.js";

// ---------------------------------------------------------------------------
// Registration manager
// ---------------------------------------------------------------------------

interface RegistrationRequest {
  version: number;
  name: string;
  definition: unknown;
  result?: { ok: true; registration: { dispose(): void } } | { ok: false; error: Error };
}

function mockEvents(options: { listener?: boolean } = {}) {
  const emitted: RegistrationRequest[] = [];
  const disposals: number[] = [];
  const events = {
    emit(_channel: string, data: unknown) {
      const request = data as RegistrationRequest;
      emitted.push(request);
      if (!options.listener) return;
      request.result = {
        ok: true,
        registration: {
          dispose() {
            disposals.push(emitted.indexOf(request));
          },
        },
      };
    },
  };
  return { events, emitted, disposals };
}

function preflight(result: SubagentPreflightResult | Promise<SubagentPreflightResult>): PreflightResolver {
  return async () => result;
}

const missingAgent: SubagentPreflightResult = {
  ok: false,
  code: "missing_agent",
  message: "unknown agent 'plan-scout'",
};

beforeEach(() => {
  clearReadOnlyAgentVerificationCache();
});

test("plan-scout registers through the runtime agent event and stays idempotent", async () => {
  const { events, emitted } = mockEvents({ listener: true });
  const manager = createPlanScoutManager({ events, cwd: () => "/repo", preflight: preflight(missingAgent) });
  const first = await manager.ensure();
  assert.equal(first.status, "registered");
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]?.name, "plan-scout");
  const second = await manager.ensure();
  assert.equal(second.status, "registered");
  assert.equal(emitted.length, 1, "ensure is idempotent while registered");
  manager.dispose();
  assert.equal(manager.status().status, "unregistered");
  manager.dispose();
  assert.equal(manager.status().status, "unregistered", "dispose is idempotent");
});

test("plan-scout reports unavailable when no pi-subagents listener answers", async () => {
  const { events, emitted } = mockEvents({ listener: false });
  const manager = createPlanScoutManager({ events, cwd: () => "/repo", preflight: preflight(missingAgent) });
  const status = await manager.ensure();
  assert.equal(status.status, "unavailable");
  if (status.status === "unavailable") {
    assert.match(status.reason, /pi-subagents/u);
  }
  assert.equal(emitted.length, 1);
});

test("a configured agent with the same name blocks registration without emitting", async () => {
  const { events, emitted } = mockEvents({ listener: true });
  const configured: SubagentPreflightResult = {
    ok: true,
    contract: {
      agent: { name: "plan-scout", source: "project", filePath: "/repo/.pi/agents/plan-scout.md" },
      tools: { effectiveAllowlist: ["read"], explicitAllowlist: true, toolExtensionPaths: [], configuredExtensions: [] },
    },
  };
  const manager = createPlanScoutManager({ events, cwd: () => "/repo", preflight: preflight(configured) });
  const status = await manager.ensure();
  assert.equal(status.status, "collision");
  if (status.status === "collision") {
    assert.match(status.detail, /plan-scout\.md/u);
  }
  assert.equal(emitted.length, 0, "collision must not emit a registration that would break discovery");
});

test("an ambiguous preflight result also counts as a collision", async () => {
  const { events } = mockEvents({ listener: true });
  const ambiguous: SubagentPreflightResult = {
    ok: false,
    code: "ambiguous_agent",
    message: "agent name 'plan-scout' matches several agents",
  };
  const manager = createPlanScoutManager({ events, cwd: () => "/repo", preflight: preflight(ambiguous) });
  const status = await manager.ensure();
  assert.equal(status.status, "collision");
});

test("a collision appearing after registration disposes the runtime agent", async () => {
  let result: SubagentPreflightResult = missingAgent;
  const { events, emitted, disposals } = mockEvents({ listener: true });
  const manager = createPlanScoutManager({
    events,
    cwd: () => "/repo",
    preflight: async () => result,
  });
  assert.equal((await manager.ensure()).status, "registered");
  assert.equal(disposals.length, 0);
  result = {
    ok: true,
    contract: {
      agent: { name: "plan-scout", source: "project", filePath: "/repo/.pi/agents/plan-scout.md" },
      tools: { effectiveAllowlist: ["read"], explicitAllowlist: true, toolExtensionPaths: [], configuredExtensions: [] },
    },
  };
  const rechecked = await manager.ensure();
  assert.equal(rechecked.status, "collision");
  assert.equal(disposals.length, 1, "the runtime registration was disposed");
  assert.equal(emitted.length, 1, "no second registration was emitted");
});

test("without preflight the manager still registers and reports the degraded mode", async () => {
  const { events } = mockEvents({ listener: true });
  const manager = createPlanScoutManager({ events, cwd: () => "/repo" });
  const status = await manager.ensure();
  assert.equal(status.status, "registered");
  assert.equal(status.preflightAvailable, false);
});

// ---------------------------------------------------------------------------
// Call classification and parameter whitelist
// ---------------------------------------------------------------------------

test("capabilities listings are admitted and other management actions are not", () => {
  assert.deepEqual(classifySubagentCall({ action: "capabilities" }), {
    ok: true,
    shape: { kind: "capabilities" },
  });
  assert.deepEqual(classifySubagentCall({ action: "capabilities", capabilities: true }), {
    ok: true,
    shape: { kind: "capabilities" },
  });
  const denied = classifySubagentCall({ action: "status", id: "abc" });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.rejection, "action");
});

test("workflow scripts classify separately from static delegation", () => {
  assert.deepEqual(classifySubagentCall({ workflow: true }), { ok: true, shape: { kind: "workflow" } });
  const path = classifySubagentCall({ workflow: "./flow.js" });
  assert.equal(path.ok, false);
  if (!path.ok) assert.equal(path.rejection, "host-parameter");
});

test("host-side parameters deny delegation admission", () => {
  const hostParameters: Record<string, unknown>[] = [
    { gate: "npm test" },
    { acceptance: "auto" },
    { share: true },
    { worktree: true },
    { isolation: "worktree" },
    { sessionDir: "/tmp/logs" },
    { machine: "remote-host" },
    { cwd: "/elsewhere" },
    { output: "/tmp/out.md" },
    { output: "reports/out.md" },
    { outputSchema: { type: "object" } },
    { fast: true },
    { agentScope: "user" },
    { extensionBindings: { "package.name": 1 } },
    { usageBudget: { tokens: { hard: 100 } } },
    { toolTimeoutMs: 5000 },
    { checkpointBeforeDeadlineMs: 1000 },
    { outputMode: "file-only" },
    { agentContract: { version: 1 } },
  ];
  for (const input of hostParameters) {
    const verdict = classifySubagentCall({ agent: "plan-scout", task: "explore", ...input });
    assert.equal(verdict.ok, false, JSON.stringify(input));
    if (!verdict.ok) {
      assert.equal(verdict.rejection, "host-parameter", JSON.stringify(input));
    }
  }
});

test("safe delegation parameters stay admitted", () => {
  const safe = classifySubagentCall({
    agent: "plan-scout",
    task: "explore",
    context: "fresh",
    model: "anthropic/claude-sonnet-4-5",
    thinking: "low",
    async: true,
    timeoutMs: 60000,
    maxRuntimeMs: 60000,
    toolBudget: { hard: 50 },
    includeProgress: true,
    chatProgress: "auto",
    artifacts: false,
    skill: ["browser-use"],
    output: false,
    acceptance: false,
  });
  assert.equal(safe.ok, true);
});

test("structure validation covers single child, tasks, and chain", () => {
  assert.deepEqual(classifySubagentCall({ agent: " plan-scout ", task: " look around " }), {
    ok: true,
    shape: { kind: "delegation", agents: ["plan-scout"] },
  });
  assert.deepEqual(
    classifySubagentCall({ tasks: [{ agent: "a", task: "1" }, { agent: "b", task: "2" }] }),
    { ok: true, shape: { kind: "delegation", agents: ["a", "b"] } },
  );
  assert.deepEqual(
    classifySubagentCall({
      chain: [{ agent: "a", task: "1", as: "x" }, { parallel: [{ agent: "b", task: "2" }, { agent: "a", task: "3" }] }],
    }),
    { ok: true, shape: { kind: "delegation", agents: ["a", "b", "a"] } },
  );

  const malformed: unknown[] = [
    {},
    { agent: "a" },
    { task: "no agent" },
    { agent: "a", task: "t", tasks: [{ agent: "a", task: "t" }] },
    { tasks: [{ agent: "a", task: "t", extra: 1 }] },
    { tasks: [{ agent: "a" }] },
    { tasks: [] },
    { chain: [{ agent: "a", task: "t", parallel: [{ agent: "b", task: "x" }] }] },
    { chain: [{ parallel: [{ agent: "b" }] }] },
    { chain: [] },
    { agent: "a", task: "t", context: "profile" },
    { agent: "a", task: "t", output: true },
    { agent: "a", task: "t", acceptance: "auto" },
  ];
  for (const input of malformed) {
    const verdict = classifySubagentCall(input);
    assert.equal(verdict.ok, false, JSON.stringify(input));
  }
});

// ---------------------------------------------------------------------------
// decideDelegationAdmission
// ---------------------------------------------------------------------------

const noExtraAgents = async () => false;

test("plan-scout delegation is admitted only while the scout is registered", async () => {
  const settings = { planAdmittedAgents: [], planAdmitWorkflowScripts: false };
  const admitted = await decideDelegationAdmission(
    { agent: "plan-scout", task: "map the module graph" },
    { settings, scoutRegistered: true, admitAgent: noExtraAgents },
  );
  assert.equal(admitted.admit, true);
  const blocked = await decideDelegationAdmission(
    { agent: "plan-scout", task: "map the module graph" },
    { settings, scoutRegistered: false, admitAgent: noExtraAgents },
  );
  assert.equal(blocked.admit, false);
  if (!blocked.admit) {
    assert.equal(blocked.rejection, "agent-not-admitted");
    assert.match(blocked.detail ?? "", /plan-scout/u);
  }
});

test("planAdmittedAgents and verified read-only agents pass, with the parameter whitelist still enforced", async () => {
  const settings = { planAdmittedAgents: ["researcher"], planAdmitWorkflowScripts: false };
  const listed = await decideDelegationAdmission(
    { agent: "researcher", task: "find the config parser" },
    { settings, scoutRegistered: true, admitAgent: noExtraAgents },
  );
  assert.equal(listed.admit, true);
  const verified = await decideDelegationAdmission(
    { tasks: [{ agent: "evidence-auditor", task: "check the claims" }] },
    {
      settings: { planAdmittedAgents: [], planAdmitWorkflowScripts: false },
      scoutRegistered: true,
      admitAgent: async (agent) => agent === "evidence-auditor",
    },
  );
  assert.equal(verified.admit, true);
  const hostParameter = await decideDelegationAdmission(
    { agent: "researcher", task: "t", gate: "npm test" },
    { settings, scoutRegistered: true, admitAgent: noExtraAgents },
  );
  assert.equal(hostParameter.admit, false);
  if (!hostParameter.admit) assert.equal(hostParameter.rejection, "host-parameter");
});

test("one unadmitted agent denies the whole batch", async () => {
  const verdict = await decideDelegationAdmission(
    { tasks: [{ agent: "plan-scout", task: "a" }, { agent: "writer", task: "b" }] },
    {
      settings: { planAdmittedAgents: [], planAdmitWorkflowScripts: false },
      scoutRegistered: true,
      admitAgent: async () => false,
    },
  );
  assert.equal(verdict.admit, false);
  if (!verdict.admit) assert.match(verdict.detail ?? "", /'writer'/u);
});

test("workflow scripts need the explicit setting", async () => {
  const blocked = await decideDelegationAdmission(
    { workflow: true },
    { settings: { planAdmittedAgents: [], planAdmitWorkflowScripts: false }, scoutRegistered: true, admitAgent: noExtraAgents },
  );
  assert.equal(blocked.admit, false);
  if (!blocked.admit) assert.equal(blocked.rejection, "workflow-scripts-disabled");
  const admitted = await decideDelegationAdmission(
    { workflow: true, args: { deep: { spawn: "anything" } } },
    {
      settings: { planAdmittedAgents: [], planAdmitWorkflowScripts: true },
      scoutRegistered: false,
      admitAgent: noExtraAgents,
    },
  );
  assert.equal(admitted.admit, true, "an admitted script is trusted wholesale, args included");
});

// ---------------------------------------------------------------------------
// Verified read-only admission
// ---------------------------------------------------------------------------

const readOnlyTools = readOnlyToolUniverse([
  ...["mcp__search__query"].map((name) => name),
]);

function contract(options: {
  allowlist?: string[];
  explicit?: boolean;
  extensions?: string[];
  toolExtensions?: string[];
  filePath?: string;
}): SubagentPreflightResult {
  return {
    ok: true,
    contract: {
      agent: { name: "probe", source: "project", filePath: options.filePath ?? "/agents/probe.md" },
      tools: {
        effectiveAllowlist: options.allowlist ?? ["read", "grep", "find", "ls"],
        explicitAllowlist: options.explicit ?? true,
        toolExtensionPaths: options.toolExtensions ?? [],
        configuredExtensions: options.extensions ?? [],
      },
    },
  };
}

function frontmatterAgent(frontmatter: string) {
  return `---\n${frontmatter}\n---\n\nSystem prompt body.\n`;
}

test("verified read-only admission accepts explicit read-only allowlists", async () => {
  const files = new Map<string, string>([["/agents/probe.md", frontmatterAgent("name: probe\ndescription: d\ntools: [read, grep]")]]);

  const deps = {
    resolveContract: preflight(contract({})) as PreflightResolver,
    readAgentFile: async (path: string) => files.get(path),
  };
  assert.equal(await verifyReadOnlyAgent("probe", "/repo", readOnlyTools, deps), true);
  assert.equal(
    await verifyReadOnlyAgent("probe", "/repo", readOnlyTools, {
      resolveContract: preflight(contract({ allowlist: ["read", "contact_supervisor"] })),
      readAgentFile: deps.readAgentFile,
    }),
    true,
    "coordination tools are allowed",
  );
  assert.equal(
    await verifyReadOnlyAgent("probe", "/repo", readOnlyTools, {
      resolveContract: preflight(contract({ allowlist: ["read", "mcp__search__query"] })),
      readAgentFile: deps.readAgentFile,
    }),
    true,
    "parent read-only-hinted MCP tools are allowed",
  );
});

test("verified read-only admission rejects unsafe tool surfaces", async () => {
  const files = new Map<string, string>([["/agents/probe.md", frontmatterAgent("name: probe\ndescription: d\ntools: [read]")]]);
  const readAgentFile = async (path: string) => files.get(path);
  for (const allowlist of [["read", "bash"], ["read", "write"], ["read", "subagent"], ["read", "subagent_command"], ["read", "totally_unknown"]]) {
    assert.equal(
      await verifyReadOnlyAgent("probe", "/repo", readOnlyTools, {
        resolveContract: preflight(contract({ allowlist })),
        readAgentFile,
      }),
      false,
      JSON.stringify(allowlist),
    );
  }
  assert.equal(
    await verifyReadOnlyAgent("probe", "/repo", readOnlyTools, {
      resolveContract: preflight(contract({ explicit: false, allowlist: [] })),
      readAgentFile,
    }),
    false,
    "implicit allowlists (no tools field, external runners) are rejected",
  );
  assert.equal(
    await verifyReadOnlyAgent("probe", "/repo", readOnlyTools, {
      resolveContract: preflight(contract({ extensions: ["/ext/tool.ts"] })),
      readAgentFile,
    }),
    false,
    "configured child extensions are rejected",
  );
  assert.equal(
    await verifyReadOnlyAgent("probe", "/repo", readOnlyTools, {
      resolveContract: preflight(contract({ toolExtensions: ["@scope/ext"] })),
      readAgentFile,
    }),
    false,
    "tool extension paths are rejected",
  );
  assert.equal(
    await verifyReadOnlyAgent("probe", "/repo", readOnlyTools, {
      resolveContract: preflight({ ok: false, code: "missing_agent", message: "unknown" }),
      readAgentFile,
    }),
    false,
    "missing agents are rejected",
  );
  assert.equal(
    await verifyReadOnlyAgent("probe", "/repo", readOnlyTools, {
      resolveContract: preflight(contract({ filePath: "runtime:probe" })),
      readAgentFile,
    }),
    false,
    "runtime-registered agents are rejected",
  );
});

test("definition file guards reject host execution directives and output escapes", async () => {
  const readAgentFile = async (path: string) => (path === "/agents/probe.md" ? undefined : undefined);
  for (const frontmatter of [
    "name: probe\nrunner:\n  type: external-cli\n  command: claude",
    "name: probe\nmachine: remote-host",
    "name: probe\ndefaultAcceptance: auto",
    "name: probe\nacceptance: reviewed",
    "name: probe\nextensions: [./custom.ts]",
    "name: probe\nsubagentOnlyExtensions: [./x.ts]",
    "name: probe\noutput: /tmp/out.md",
    "name: probe\noutput: ../../escape.md",
    "name: probe\noutput: reports/../escape.md",
  ]) {
    const files = new Map<string, string>([["/agents/probe.md", frontmatterAgent(frontmatter)]]);
    assert.equal(
      await verifyReadOnlyAgent("probe", "/repo", readOnlyTools, {
        resolveContract: preflight(contract({})),
        readAgentFile: async (path: string) => files.get(path),
      }),
      false,
      frontmatter,
    );
  }
  assert.equal(
    await verifyReadOnlyAgent("probe", "/repo", readOnlyTools, {
      resolveContract: preflight(contract({})),
      readAgentFile,
    }),
    false,
    "unreadable definition files are rejected",
  );
  // A quoted relative output without .. stays fine; nested mapping keys do not hide the root key.
  const ok = new Map<string, string>([
    ["/agents/probe.md", frontmatterAgent('name: probe\noutput: "reports/summary.md"')],
  ]);
  clearReadOnlyAgentVerificationCache();
  assert.equal(
    await verifyReadOnlyAgent("probe", "/repo", readOnlyTools, {
      resolveContract: preflight(contract({})),
      readAgentFile: async (path: string) => ok.get(path),
    }),
    true,
  );
});

test("verification results are cached per agent and cwd until cleared", async () => {
  clearReadOnlyAgentVerificationCache();
  let calls = 0;
  const files = new Map<string, string>([["/agents/probe.md", frontmatterAgent("name: probe\ndescription: d")]]);

  const deps = {
    resolveContract: (async () => {
      calls += 1;
      return contract({});
    }) as PreflightResolver,
    readAgentFile: async (path: string) => files.get(path),
  };
  assert.equal(await verifyReadOnlyAgent("probe", "/repo", readOnlyTools, deps), true);
  assert.equal(await verifyReadOnlyAgent("probe", "/repo", readOnlyTools, deps), true);
  assert.equal(calls, 1, "the second verdict comes from the cache");
  clearReadOnlyAgentVerificationCache();
  assert.equal(await verifyReadOnlyAgent("probe", "/repo", readOnlyTools, deps), true);
  assert.equal(calls, 2, "clearing forces a fresh preflight");
});

// ---------------------------------------------------------------------------
// Degraded mode, prompt, settings
// ---------------------------------------------------------------------------

test("degraded mode admits only the scout and forced-list agents", async () => {
  const settings = { planAdmittedAgents: ["researcher"], planAdmitWorkflowScripts: false };
  const scout = await decideDelegationAdmission(
    { agent: "plan-scout", task: "t" },
    { settings, scoutRegistered: true, admitAgent: noExtraAgents },
  );
  assert.equal(scout.admit, true);
  const listed = await decideDelegationAdmission(
    { agent: "researcher", task: "t" },
    { settings, scoutRegistered: true, admitAgent: noExtraAgents },
  );
  assert.equal(listed.admit, true);
  const verified = await decideDelegationAdmission(
    { agent: "evidence-auditor", task: "t" },
    { settings, scoutRegistered: true, admitAgent: noExtraAgents },
  );
  assert.equal(verified.admit, false, "verified admission is impossible without a preflight resolver");
});

test("the plan prompt gains the delegation line only while the scout is registered", () => {
  const withScout = buildPlanModePrompt(undefined, { scoutRegistered: true });
  assert.match(withScout, /delegate read-only recon to the `plan-scout` subagent/u);
  assert.match(withScout, /without host-side options/u);
  const withoutScout = buildPlanModePrompt(undefined, { scoutRegistered: false });
  assert.ok(!withoutScout.includes("plan-scout"));
  assert.ok(!buildPlanModePrompt(undefined).includes("plan-scout"));
});

test("settings persist and clear the delegation keys", async () => {
  assert.deepEqual(normalizePlanModeSettings({ planAdmittedAgents: ["a", "a", "b"], planAdmitWorkflowScripts: true }), {
    thinkingLevel: "inherit",
    planAdmittedAgents: ["a", "b"],
    planAdmitWorkflowScripts: true,
  });
  assert.equal(normalizePlanModeSettings({ planAdmittedAgents: "a" }), undefined);
  assert.equal(normalizePlanModeSettings({ planAdmitWorkflowScripts: "yes" }), undefined);

  const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-scout-"));
  try {
    const settingsPath = join(directory, "pi-plan-mode.json");
    const saved = await updatePlanModeSettings(
      { planAdmittedAgents: ["researcher", "reviewer"], planAdmitWorkflowScripts: true },
      { settingsPath },
    );
    assert.deepEqual(saved.planAdmittedAgents, ["researcher", "reviewer"]);
    assert.equal(saved.planAdmitWorkflowScripts, true);
    const cleared = await updatePlanModeSettings(
      { planAdmittedAgents: null, planAdmitWorkflowScripts: null },
      { settingsPath },
    );
    assert.equal(cleared.planAdmittedAgents, undefined);
    assert.equal(cleared.planAdmitWorkflowScripts, undefined);
    assert.ok(!JSON.parse(await readFileOrNull(settingsPath) ?? "{}").planAdmittedAgents);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function readFileOrNull(path: string) {
  try {
    return await (await import("node:fs/promises")).readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

test("the read-only universe includes coordination tools and parent-hinted tools", () => {
  const universe = readOnlyToolUniverse(
    parentReadOnlyToolNames([
      extensionTool("web_search", { readOnlyHint: true }),
      extensionTool("web_enable"),
      extensionTool("web_fetch", { readOnlyHint: true, destructiveHint: true }),
    ]),
  );
  assert.ok(universe.has("read"));
  assert.ok(universe.has("grep"));
  assert.ok(universe.has("find"));
  assert.ok(universe.has("ls"));
  assert.ok(universe.has("contact_supervisor"));
  assert.ok(universe.has("intercom"));
  assert.ok(universe.has("structured_output"));
  assert.ok(universe.has("web_search"));
  assert.ok(!universe.has("web_enable"));
  assert.ok(!universe.has("web_fetch"), "destructive-hinted tools are excluded");
  assert.ok(!universe.has("bash"));
});

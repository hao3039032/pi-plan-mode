import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Plan-mode read-only delegation through pi-subagents.
 *
 * The module has three layers:
 * 1. `plan-scout` runtime-agent registration (own definition, collision-checked via preflight).
 * 2. Pure per-call admission for `subagent` tool calls (shape, parameter whitelist, agent set).
 * 3. Verified read-only admission for referenced agents (preflight tool allowlist + definition
 *    file guards), because a child's tool surface alone does not cover host-side execution
 *    (gate commands, output paths, runners, extensions).
 */

export const PLAN_SCOUT_AGENT_NAME = "plan-scout";

/** Definition of the read-only scout registered as a pi-subagents runtime agent. */
export const PLAN_SCOUT_DEFINITION = {
  description:
    "Read-only code reconnaissance for planning: targeted repository exploration with file:line evidence, no file changes.",
  systemPrompt: [
    "You are plan-scout, a read-only reconnaissance agent for planning workflows.",
    "",
    "- Explore the repository to answer the specific questions in your task; prefer targeted search over broad dumps.",
    "- Ground every important finding in evidence: cite file paths with line numbers (path:line).",
    "- Read-only discipline: never modify, create, or delete files; never attempt mutation through other tools.",
    "- Compress the handoff: findings with evidence first, then unknowns and dead ends. No preamble, no restating the task.",
  ].join("\n"),
  tools: ["read", "grep", "find", "ls"],
  systemPromptMode: "replace" as const,
  inheritProjectContext: true,
  inheritSkills: false,
  thinking: "low",
  defaultProgress: true,
};

const RUNTIME_AGENT_REGISTER_EVENT = "pi-subagents:runtime-agent-register:v1";
const RUNTIME_AGENT_REGISTER_VERSION = 1;

/** pi-subagents coordination tools a read-only child may carry beyond pure readers. */
export const SUBAGENT_COORDINATION_TOOLS = new Set(["contact_supervisor", "intercom", "structured_output"]);

// ---------------------------------------------------------------------------
// Preflight loading (two-tier: bare specifier, then the agent-dir npm install)
// ---------------------------------------------------------------------------

/** Minimal structural view of `resolveSubagentLaunchContract` results we rely on. */
export interface SubagentLaunchContractTools {
  effectiveAllowlist: string[];
  explicitAllowlist: boolean;
  toolExtensionPaths: string[];
  configuredExtensions: string[];
}

export interface SubagentLaunchContract {
  agent: { name: string; source: string; filePath: string };
  tools: SubagentLaunchContractTools;
}

export type SubagentPreflightResult =
  | { ok: true; contract: SubagentLaunchContract }
  | { ok: false; code: string; message: string };

export interface SubagentPreflight {
  resolveSubagentLaunchContract(input: { agent: string; cwd: string }): Promise<unknown>;
}

export type PreflightResolver = (input: { agent: string; cwd: string }) => Promise<SubagentPreflightResult>;

let cachedPreflight: SubagentPreflight | undefined | null = null;

async function importSubagentPreflightModule(importModule: (id: string) => Promise<unknown>) {
  // Tier 1: the bare export through Pi's Jiti module chain.
  try {
    const imported = (await importModule("pi-subagents/preflight")) as SubagentPreflight | undefined;
    if (imported && typeof imported.resolveSubagentLaunchContract === "function") return imported;
  } catch {
    // Tier 2 below.
  }
  // Tier 2: the pi-subagents copy installed under the pi agent dir (file import).
  try {
    const path = join(getAgentDir(), "npm", "node_modules", "pi-subagents", "src", "api", "preflight.js");
    const imported = (await importModule(pathToFileUrl(path))) as SubagentPreflight | undefined;
    if (imported && typeof imported.resolveSubagentLaunchContract === "function") return imported;
  } catch {
    // Unavailable; callers degrade to plan-scout + planAdmittedAgents only.
  }
  return undefined;
}

function pathToFileUrl(path: string) {
  return `file://${path.replace(/\\/gu, "/")}`;
}

/** Lazily resolve the pi-subagents preflight module once per extension runtime. */
export async function loadSubagentPreflight(
  importModule: (id: string) => Promise<unknown> = (id) => import(id),
): Promise<SubagentPreflight | undefined> {
  if (cachedPreflight !== null) return cachedPreflight;
  cachedPreflight = (await importSubagentPreflightModule(importModule)) ?? null;
  return cachedPreflight ?? undefined;
}

/** Test hook: forget the cached preflight module. */
export function resetSubagentPreflightCache() {
  cachedPreflight = null;
}

export function createPreflightResolver(
  preflight: SubagentPreflight | undefined,
): PreflightResolver | undefined {
  if (!preflight) return undefined;
  return async (input) => {
    try {
      const result = (await preflight.resolveSubagentLaunchContract(input)) as SubagentPreflightResult;
      if (result && typeof result === "object" && "ok" in result) return result;
      return { ok: false, code: "invalid_preflight", message: "pi-subagents preflight returned an unusable result." };
    } catch (error) {
      return {
        ok: false,
        code: "preflight_error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

// ---------------------------------------------------------------------------
// plan-scout registration manager
// ---------------------------------------------------------------------------

export type PlanScoutStatus =
  | { status: "unregistered"; preflightAvailable: boolean }
  | { status: "registered"; preflightAvailable: boolean }
  | { status: "collision"; detail: string; preflightAvailable: boolean }
  | { status: "unavailable"; reason: string; preflightAvailable: boolean };

export interface PlanScoutEvents {
  emit(channel: string, data: unknown): void;
}

export interface PlanScoutManagerDeps {
  events: PlanScoutEvents;
  cwd: () => string;
  /** Fixed resolver (tests) — mutually exclusive with `preflightLoader`. */
  preflight?: PreflightResolver | undefined;
  /** Lazily produce a resolver; resolves to undefined when pi-subagents preflight is unavailable. */
  preflightLoader?: () => Promise<PreflightResolver | undefined>;
}

export interface PlanScoutManager {
  ensure(): Promise<PlanScoutStatus>;
  dispose(): void;
  status(): PlanScoutStatus;
}

/**
 * Register the plan-scout runtime agent against the installed pi-subagents owner.
 *
 * A preflight resolve of the name doubles as the collision check: any configured agent
 * (builtin/package/user/project) already answering to "plan-scout" means registration
 * must not happen — pi-subagents throws on every agent discovery otherwise.
 */
export function createPlanScoutManager(deps: PlanScoutManagerDeps): PlanScoutManager {
  let preflightAvailable = deps.preflight !== undefined || deps.preflightLoader !== undefined;
  let current: PlanScoutStatus = { status: "unregistered", preflightAvailable };
  let registration: { dispose(): void } | undefined;

  const resolvePreflight = async () => {
    if (deps.preflight) return deps.preflight({ agent: PLAN_SCOUT_AGENT_NAME, cwd: deps.cwd() });
    if (!deps.preflightLoader) return undefined;
    const resolver = await deps.preflightLoader();
    if (!resolver) {
      preflightAvailable = false;
      return undefined;
    }
    return resolver({ agent: PLAN_SCOUT_AGENT_NAME, cwd: deps.cwd() });
  };

  const registerViaEvents = () => {
    const request: {
      version: number;
      name: string;
      definition: unknown;
      result?: { ok: true; registration: { dispose(): void } } | { ok: false; error: Error };
    } = {
      version: RUNTIME_AGENT_REGISTER_VERSION,
      name: PLAN_SCOUT_AGENT_NAME,
      definition: PLAN_SCOUT_DEFINITION,
    };
    try {
      deps.events.emit(RUNTIME_AGENT_REGISTER_EVENT, request);
    } catch (error) {
      return { ok: false as const, reason: error instanceof Error ? error.message : String(error) };
    }
    const result = request.result;
    if (result === undefined) {
      return {
        ok: false as const,
        reason:
          "pi-subagents is not installed, not ready, or does not support runtime agent registration (pi install npm:pi-subagents)",
      };
    }
    if (result.ok) {
      return { ok: true as const, registration: result.registration };
    }
    return { ok: false as const, reason: result.error.message };
  };

  const retire = (next: PlanScoutStatus) => {
    registration?.dispose();
    registration = undefined;
    current = next;
  };

  return {
    async ensure() {
      const result = await resolvePreflight();
      // A configured agent answering to the name (ok, ambiguity, or any other non-missing
      // failure while resolving it) blocks registration; only "missing_agent" is a free name.
      const conflict =
        result !== undefined && (result.ok || result.code !== "missing_agent")
          ? result.ok
            ? `a configured '${result.contract.agent.source}' agent already uses the name (from ${result.contract.agent.filePath})`
            : result.code === "ambiguous_agent"
              ? result.message
              : `the name does not resolve cleanly (preflight: ${result.code}: ${result.message})`
          : undefined;
      if (conflict) {
        retire({
          status: "collision",
          detail: conflict,
          preflightAvailable,
        });
        return current;
      }
      if (current.status === "registered" && registration) {
        current = { status: "registered", preflightAvailable };
        return current;
      }
      const registered = registerViaEvents();
      if (!registered.ok) {
        retire({ status: "unavailable", reason: registered.reason, preflightAvailable });
        return current;
      }
      registration = registered.registration;
      current = { status: "registered", preflightAvailable };
      return current;
    },
    dispose() {
      retire({ status: "unregistered", preflightAvailable });
    },
    status() {
      return current;
    },
  };
}

// ---------------------------------------------------------------------------
// Per-call admission (pure)
// ---------------------------------------------------------------------------

/** Parameter keys a Plan-mode delegation call may carry; anything else has host-side effects. */
const DELEGATION_PARAMETER_WHITELIST = new Set([
  "agent",
  "task",
  "tasks",
  "chain",
  "context",
  "model",
  "thinking",
  "async",
  "timeoutMs",
  "maxRuntimeMs",
  "toolBudget",
  "includeProgress",
  "chatProgress",
  "artifacts",
  "skill",
  "output",
  "acceptance",
]);

export type DelegationRejection =
  | "action"
  | "workflow-scripts-disabled"
  | "host-parameter"
  | "structure"
  | "empty";

export type SubagentCallShape =
  | { kind: "capabilities" }
  | { kind: "workflow" }
  | { kind: "delegation"; agents: string[] };

export type SubagentCallClassification =
  | { ok: true; shape: SubagentCallShape }
  | { ok: false; rejection: DelegationRejection; detail?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function collectAgentsFromTaskList(value: unknown, agents: string[]): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  for (const entry of value) {
    if (!isRecord(entry)) return false;
    const keys = Object.keys(entry);
    if (keys.some((key) => key !== "agent" && key !== "task")) return false;
    if (!isNonEmptyString(entry.agent) || !isNonEmptyString(entry.task)) return false;
    agents.push(entry.agent.trim());
  }
  return true;
}

function collectAgentsFromChain(value: unknown, agents: string[]): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  for (const step of value) {
    if (!isRecord(step)) return false;
    const keys = Object.keys(step);
    if (keys.length === 1 && keys[0] === "parallel") {
      if (!collectAgentsFromTaskList(step.parallel, agents)) return false;
      continue;
    }
    if (keys.some((key) => key !== "agent" && key !== "task" && key !== "as")) return false;
    if (!isNonEmptyString(step.agent) || !isNonEmptyString(step.task)) return false;
    if (keys.includes("as") && !isNonEmptyString(step.as)) return false;
    agents.push(step.agent.trim());
  }
  return true;
}

/**
 * Classify a `subagent` tool call for Plan-mode per-call admission:
 * - `action: "capabilities"` with no execution keys is a safe read-only listing;
 * - `workflow` scripts are a full trust decision handled by the planAdmitWorkflowScripts setting;
 * - single-child and static `tasks`/`chain` batches pass a strict parameter whitelist and shape
 *   validation, and reduce to the referenced agent names for per-agent admission.
 */
export function classifySubagentCall(input: unknown): SubagentCallClassification {
  if (!isRecord(input)) return { ok: false, rejection: "structure", detail: "input is not an object" };
  const keys = Object.keys(input);

  if (input.workflow !== undefined) {
    if (input.workflow === true) return { ok: true, shape: { kind: "workflow" } };
    return { ok: false, rejection: "host-parameter", detail: "workflow accepts only true for script delegation" };
  }
  if (input.action !== undefined) {
    if (input.action === "capabilities" && keys.every((key) => key === "action" || key === "capabilities")) {
      return { ok: true, shape: { kind: "capabilities" } };
    }
    return { ok: false, rejection: "action", detail: `management action '${String(input.action)}'` };
  }

  for (const key of keys) {
    if (!DELEGATION_PARAMETER_WHITELIST.has(key)) {
      return { ok: false, rejection: "host-parameter", detail: `parameter '${key}'` };
    }
  }
  if (input.context !== undefined && input.context !== "fresh" && input.context !== "fork") {
    return { ok: false, rejection: "structure", detail: "context must be fresh or fork" };
  }
  if (input.output !== undefined && input.output !== false) {
    return { ok: false, rejection: "host-parameter", detail: "output accepts only false" };
  }
  if (input.acceptance !== undefined && input.acceptance !== false) {
    return { ok: false, rejection: "host-parameter", detail: "acceptance accepts only false" };
  }

  const hasSingle = input.agent !== undefined || input.task !== undefined;
  const hasBatch = input.tasks !== undefined || input.chain !== undefined;
  if (hasSingle && hasBatch) {
    return { ok: false, rejection: "structure", detail: "single-child and multi-child fields cannot be combined" };
  }
  const agents: string[] = [];
  if (hasSingle) {
    if (!isNonEmptyString(input.agent) || !isNonEmptyString(input.task)) {
      return { ok: false, rejection: "structure", detail: "single-child delegation needs non-empty agent and task" };
    }
    agents.push(input.agent.trim());
  } else if (hasBatch) {
    if (input.tasks !== undefined && !collectAgentsFromTaskList(input.tasks, agents)) {
      return { ok: false, rejection: "structure", detail: "tasks entries must be {agent, task} with non-empty strings" };
    }
    if (input.chain !== undefined && !collectAgentsFromChain(input.chain, agents)) {
      return { ok: false, rejection: "structure", detail: "chain steps must be {agent, task, as?} or {parallel}" };
    }
  } else {
    return { ok: false, rejection: "empty", detail: "no agent, tasks, or chain" };
  }
  return { ok: true, shape: { kind: "delegation", agents } };
}

export interface DelegationAdmissionSettings {
  planAdmittedAgents?: readonly string[];
  planAdmitWorkflowScripts?: boolean;
}

export interface DelegationAdmissionDeps {
  settings: DelegationAdmissionSettings;
  scoutRegistered: boolean;
  /** Per-agent verdict: plan-scout registration, planAdmittedAgents, or verified read-only. */
  admitAgent(agent: string): Promise<boolean>;
}

export type DelegationAdmission =
  | { admit: true; shape: SubagentCallShape }
  | { admit: false; rejection: DelegationRejection | "workflow-scripts-disabled" | "agent-not-admitted"; detail?: string };

/** Decide whether one `subagent` tool call is auto-admitted during Plan mode. */
export async function decideDelegationAdmission(
  input: unknown,
  deps: DelegationAdmissionDeps,
): Promise<DelegationAdmission> {
  const classification = classifySubagentCall(input);
  if (!classification.ok) return { admit: false, ...classification };
  const { shape } = classification;
  if (shape.kind === "capabilities") return { admit: true, shape };
  if (shape.kind === "workflow") {
    if (deps.settings.planAdmitWorkflowScripts === true) return { admit: true, shape };
    return {
      admit: false,
      rejection: "workflow-scripts-disabled",
      detail: "script workflows require the planAdmitWorkflowScripts setting",
    };
  }
  for (const agent of shape.agents) {
    if (agent === PLAN_SCOUT_AGENT_NAME) {
      if (deps.scoutRegistered) continue;
      return { admit: false, rejection: "agent-not-admitted", detail: `agent '${agent}' is not registered` };
    }
    const admitted =
      deps.settings.planAdmittedAgents?.includes(agent) || (await deps.admitAgent(agent));
    if (!admitted) {
      return { admit: false, rejection: "agent-not-admitted", detail: `agent '${agent}' is not admitted` };
    }
  }
  return { admit: true, shape };
}

// ---------------------------------------------------------------------------
// Verified read-only admission (per agent)
// ---------------------------------------------------------------------------

export interface ReadOnlyVerificationDeps {
  resolveContract: PreflightResolver;
  readAgentFile(path: string): Promise<string | undefined>;
}

/** Top-level definition keys that enable host-side or child-process code execution. */
const FORBIDDEN_DEFINITION_KEYS = [
  "runner",
  "machine",
  "defaultAcceptance",
  "acceptance",
  "extensions",
  "subagentOnlyExtensions",
] as const;

const verificationCache = new Map<string, boolean>();

/** Forget cached per-agent verdicts (called when a new Plan workflow starts). */
export function clearReadOnlyAgentVerificationCache() {
  verificationCache.clear();
}

/**
 * Verified read-only admission: an agent passes only when preflight resolves it, its tool
 * allowlist is explicit and entirely read-only, it configures no child extensions, and its
 * definition file carries no runner/machine/acceptance/extension/output-escape directives.
 */
export async function verifyReadOnlyAgent(
  agent: string,
  cwd: string,
  readOnlyTools: ReadonlySet<string>,
  deps: ReadOnlyVerificationDeps,
): Promise<boolean> {
  const cacheKey = `${agent}@${cwd}`;
  const cached = verificationCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const verdict = await verifyReadOnlyAgentUncached(agent, cwd, readOnlyTools, deps);
  verificationCache.set(cacheKey, verdict);
  return verdict;
}

async function verifyReadOnlyAgentUncached(
  agent: string,
  cwd: string,
  readOnlyTools: ReadonlySet<string>,
  deps: ReadOnlyVerificationDeps,
): Promise<boolean> {
  const result = await deps.resolveContract({ agent, cwd });
  if (!result.ok) return false;
  const { contract } = result;
  if (contract.tools?.explicitAllowlist !== true) return false;
  const allowlist = contract.tools.effectiveAllowlist ?? [];
  if (!allowlist.every((tool) => readOnlyTools.has(tool))) return false;
  if ((contract.tools.configuredExtensions ?? []).length > 0) return false;
  if ((contract.tools.toolExtensionPaths ?? []).length > 0) return false;
  const definition = contract.agent?.filePath;
  if (!definition || !isAbsolute(definition)) return false; // runtime-registered or non-file agents
  const contents = await deps.readAgentFile(definition);
  if (contents === undefined) return false;
  return planScoutDefinitionFileIsAdmitted(contents);
}

/**
 * Guard the agent definition file: reject host-execution directives and output escapes by
 * inspecting the YAML frontmatter's top-level keys (nested mapping values still appear at
 * column zero for their root key).
 */
export function planScoutDefinitionFileIsAdmitted(contents: string): boolean {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(contents);
  if (!match) return false;
  const frontmatter = match[1] ?? "";
  for (const line of frontmatter.split(/\r?\n/u)) {
    if (!line || /^\s/u.test(line) || line.startsWith("#")) continue;
    const keyMatch = /^([A-Za-z0-9_.-]+)\s*:(?:\s*(.*))?$/u.exec(line);
    if (!keyMatch) continue;
    const key = keyMatch[1] ?? "";
    if ((FORBIDDEN_DEFINITION_KEYS as readonly string[]).includes(key)) return false;
    if (key === "output") {
      const value = unquoteYamlScalar(keyMatch[2] ?? "");
      if (isAbsolute(value) || value.split(/[\\/]/u).includes("..")) return false;
    }
  }
  return true;
}

function unquoteYamlScalar(value: string) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** The read-only tool universe for verified admission (readers, coordination tools, hinted parent tools). */
export function readOnlyToolUniverse(parentReadOnlyToolNames: Iterable<string>): Set<string> {
  return new Set([
    ...["read", "grep", "find", "ls"],
    ...SUBAGENT_COORDINATION_TOOLS,
    ...parentReadOnlyToolNames,
  ]);
}

/** Parent-session tool names whose annotations mark them read-only and non-destructive. */
export function parentReadOnlyToolNames(
  tools: ReadonlyArray<{ name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }>,
): string[] {
  return tools
    .filter((tool) => tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true)
    .map((tool) => tool.name);
}

/** The default file reader used for definition-file guards. */
export function readAgentDefinitionFile(path: string): Promise<string | undefined> {
  return readFile(path, "utf8").catch(() => undefined);
}

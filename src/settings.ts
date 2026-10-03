import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { type ImplementationModelOverride, isPendingImplementationModelIdentifier } from "./implementation-models.js";

export const PLAN_MODE_SETTINGS_FILE = "pi-plan-vanguard.json";
/** Former canonical settings filenames, still read (newest first) and migrated on the next explicit save. */
export const LEGACY_PLAN_MODE_SETTINGS_FILES = ["pi-plan-mode.json", "plan-mode.json"] as const;
const MAX_SETTINGS_BYTES = 64 * 1024;
export const PLAN_MODE_THINKING_LEVELS = [
  "inherit",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export const IMPLEMENTATION_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const IMPLEMENTATION_PLAN_RETENTIONS = ["clear-on-start", "clear-after-first-run", "keep"] as const;
export const DEFAULT_PLAN_EXPORT_PATH = "PLAN.md";
const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
const BASE_KEYS = new Set([
  ..."abcdefghijklmnopqrstuvwxyz0123456789",
  "`",
  "-",
  "=",
  "[",
  "]",
  "\\",
  ";",
  "'",
  ",",
  ".",
  "/",
  "!",
  "@",
  "#",
  "$",
  "%",
  "^",
  "&",
  "*",
  "(",
  ")",
  "_",
  "+",
  "|",
  "~",
  "{",
  "}",
  ":",
  "<",
  ">",
  "?",
  "escape",
  "esc",
  "enter",
  "return",
  "tab",
  "space",
  "backspace",
  "delete",
  "insert",
  "clear",
  "home",
  "end",
  "pageup",
  "pagedown",
  "up",
  "down",
  "left",
  "right",
  ...Array.from({ length: 12 }, (_unused, index) => `f${index + 1}`),
]);
const MAX_PLAN_EXPORT_PATH_LENGTH = 4096;

export type PlanModeThinkingLevel = (typeof PLAN_MODE_THINKING_LEVELS)[number];
export type ImplementationPlanRetention = (typeof IMPLEMENTATION_PLAN_RETENTIONS)[number];
export type PlanModeFixedThinkingLevel = (typeof IMPLEMENTATION_THINKING_LEVELS)[number];
export interface PlanSandboxSettings {
  allowWrite?: string[];
  denyRead?: string[];
  allowedDomains?: string[];
}
export interface PlanModeSettings {
  thinkingLevel: PlanModeThinkingLevel;
  defaultPlanTools?: string[];
  planAdmittedAgents?: string[];
  planAdmitWorkflowScripts?: boolean;
  implementationPlanRetention?: ImplementationPlanRetention;
  defaultImplementationModel?: ImplementationModelOverride;
  defaultImplementationThinkingLevel?: PlanModeFixedThinkingLevel;
  defaultPlanExportPath?: string;
  planOutputDir?: string;
  planSandbox?: PlanSandboxSettings;
  toggleShortcut?: KeyId;
}
export interface PlanModeSettingsPatch {
  thinkingLevel?: PlanModeThinkingLevel;
  defaultPlanTools?: readonly string[] | null;
  planAdmittedAgents?: readonly string[] | null;
  planAdmitWorkflowScripts?: boolean | null;
  implementationPlanRetention?: ImplementationPlanRetention;
  defaultImplementationModel?: ImplementationModelOverride | null;
  defaultImplementationThinkingLevel?: PlanModeFixedThinkingLevel | null;
  defaultPlanExportPath?: string | null;
  planOutputDir?: string | null;
  planSandbox?: PlanSandboxSettings | null;
  toggleShortcut?: KeyId | null;
}
export interface UpdatePlanModeSettingsOptions {
  settingsPath?: string;
  legacySettingsPaths?: string[];
  signal?: AbortSignal;
  beforeRename?: (temporaryPath: string, settingsPath: string) => Promise<void>;
}
export type PlanModeSettingsLoadResult =
  | { kind: "missing"; notice?: string }
  | { kind: "invalid"; reason: string; notice?: string }
  | { kind: "loaded"; settings: PlanModeSettings; notice?: string };

type SettingsDocument = Record<string, unknown>;
type SettingsSnapshot = {
  result: PlanModeSettingsLoadResult;
  document?: SettingsDocument;
};

const mutationQueues = new Map<string, Promise<void>>();

export function planModeSettingsPath() {
  return join(getAgentDir(), PLAN_MODE_SETTINGS_FILE);
}

export function legacyPlanModeSettingsPaths() {
  return LEGACY_PLAN_MODE_SETTINGS_FILES.map((file) => join(getAgentDir(), file));
}

export function normalizePlanModeSettings(value: unknown): PlanModeSettings | undefined {
  if (!isSettingsDocument(value)) return undefined;
  const thinkingLevel = Object.hasOwn(value, "thinkingLevel") ? Reflect.get(value, "thinkingLevel") : "inherit";
  if (!PLAN_MODE_THINKING_LEVELS.includes(thinkingLevel as PlanModeThinkingLevel)) {
    return undefined;
  }
  const settings: PlanModeSettings = {
    thinkingLevel: thinkingLevel as PlanModeThinkingLevel,
  };
  if (Object.hasOwn(value, "defaultPlanTools")) {
    const defaultPlanTools = normalizeToolNames(Reflect.get(value, "defaultPlanTools"));
    if (!defaultPlanTools) return undefined;
    settings.defaultPlanTools = defaultPlanTools;
  }
  if (Object.hasOwn(value, "planAdmittedAgents")) {
    const planAdmittedAgents = normalizeToolNames(Reflect.get(value, "planAdmittedAgents"));
    if (!planAdmittedAgents) return undefined;
    settings.planAdmittedAgents = planAdmittedAgents;
  }
  if (Object.hasOwn(value, "planAdmitWorkflowScripts")) {
    const planAdmitWorkflowScripts = Reflect.get(value, "planAdmitWorkflowScripts");
    if (typeof planAdmitWorkflowScripts !== "boolean") return undefined;
    settings.planAdmitWorkflowScripts = planAdmitWorkflowScripts;
  }
  if (Object.hasOwn(value, "implementationPlanRetention")) {
    const implementationPlanRetention = Reflect.get(value, "implementationPlanRetention");
    if (!IMPLEMENTATION_PLAN_RETENTIONS.includes(implementationPlanRetention as ImplementationPlanRetention)) {
      return undefined;
    }
    settings.implementationPlanRetention = implementationPlanRetention as ImplementationPlanRetention;
  }
  if (Object.hasOwn(value, "defaultImplementationModel")) {
    const defaultImplementationModel = normalizeImplementationModel(Reflect.get(value, "defaultImplementationModel"));
    if (!defaultImplementationModel) return undefined;
    settings.defaultImplementationModel = defaultImplementationModel;
  }
  if (Object.hasOwn(value, "defaultImplementationThinkingLevel")) {
    const defaultImplementationThinkingLevel = Reflect.get(value, "defaultImplementationThinkingLevel");
    if (!IMPLEMENTATION_THINKING_LEVELS.includes(defaultImplementationThinkingLevel as PlanModeFixedThinkingLevel)) {
      return undefined;
    }
    settings.defaultImplementationThinkingLevel = defaultImplementationThinkingLevel as PlanModeFixedThinkingLevel;
  }
  if (Object.hasOwn(value, "defaultPlanExportPath")) {
    const defaultPlanExportPath = normalizePlanExportPath(Reflect.get(value, "defaultPlanExportPath"));
    if (!defaultPlanExportPath) return undefined;
    settings.defaultPlanExportPath = defaultPlanExportPath;
  }
  if (Object.hasOwn(value, "toggleShortcut")) {
    const toggleShortcut = normalizeKeyId(Reflect.get(value, "toggleShortcut"));
    if (!toggleShortcut) return undefined;
    settings.toggleShortcut = toggleShortcut;
  }
  if (Object.hasOwn(value, "planOutputDir")) {
    const planOutputDir = normalizePlanOutputDir(Reflect.get(value, "planOutputDir"));
    if (!planOutputDir) return undefined;
    settings.planOutputDir = planOutputDir;
  }
  if (Object.hasOwn(value, "planSandbox")) {
    const planSandbox = normalizePlanSandbox(Reflect.get(value, "planSandbox"));
    if (!planSandbox) return undefined;
    settings.planSandbox = planSandbox;
  }
  return settings;
}

function normalizeImplementationModel(value: unknown): ImplementationModelOverride | undefined {
  if (!isSettingsDocument(value) || Object.keys(value).some((key) => key !== "provider" && key !== "modelId")) {
    return undefined;
  }
  const provider = typeof value.provider === "string" ? value.provider.trim() : value.provider;
  const modelId = typeof value.modelId === "string" ? value.modelId.trim() : value.modelId;
  if (!isPendingImplementationModelIdentifier(provider) || !isPendingImplementationModelIdentifier(modelId)) {
    return undefined;
  }
  return { provider, modelId };
}

function normalizeToolNames(value: unknown) {
  if (
    !Array.isArray(value) ||
    !value.every((item): item is string => typeof item === "string" && item.trim().length > 0)
  ) {
    return undefined;
  }
  return Array.from(new Set(value));
}

function normalizePlanExportPath(value: unknown) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > MAX_PLAN_EXPORT_PATH_LENGTH ||
    !/[^@\s]/u.test(normalized) ||
    [...normalized].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    })
  ) {
    return undefined;
  }
  return normalized;
}

export function normalizeKeyId(value: unknown): KeyId | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  const base = [...BASE_KEYS]
    .sort((left, right) => right.length - left.length)
    .find((candidate) => normalized === candidate || normalized.endsWith(`+${candidate}`));
  if (!base) return undefined;
  const prefix = normalized.slice(0, normalized.length - base.length);
  if (!prefix) return base as KeyId;
  if (/^f(?:[1-9]|1[0-2])$/.test(base) || !prefix.endsWith("+")) return undefined;
  const modifiers = prefix.slice(0, -1).split("+");
  if (
    modifiers.length === 0 ||
    modifiers.some((modifier) => !MODIFIERS.has(modifier)) ||
    new Set(modifiers).size !== modifiers.length
  ) {
    return undefined;
  }
  return normalized as KeyId;
}

function normalizePlanOutputDir(value: unknown) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > MAX_PLAN_EXPORT_PATH_LENGTH ||
    [...normalized].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    })
  ) {
    return undefined;
  }
  return normalized;
}

function normalizePlanSandbox(value: unknown): PlanSandboxSettings | undefined {
  if (!isSettingsDocument(value)) return undefined;
  if (Object.keys(value).some((key) => key !== "allowWrite" && key !== "denyRead" && key !== "allowedDomains")) {
    return undefined;
  }
  const settings: PlanSandboxSettings = {};
  for (const key of ["allowWrite", "denyRead", "allowedDomains"] as const) {
    if (!Object.hasOwn(value, key)) continue;
    const list = normalizePlanSandboxList(Reflect.get(value, key));
    if (!list) return undefined;
    settings[key] = list;
  }
  return Object.keys(settings).length > 0 ? settings : undefined;
}

function normalizePlanSandboxList(value: unknown) {
  if (
    !Array.isArray(value) ||
    !value.every((item): item is string => typeof item === "string" && item.trim().length > 0)
  ) {
    return undefined;
  }
  return Array.from(new Set(value.map((item) => item.trim())));
}

export async function readPlanModeSettings(settingsPath?: string): Promise<PlanModeSettingsLoadResult> {
  if (settingsPath) {
    await awaitPlanModeSettingsWrites(settingsPath);
    return (await readSettingsSnapshot(settingsPath)).result;
  }
  const canonicalPath = planModeSettingsPath();
  await awaitPlanModeSettingsWrites(canonicalPath);
  const canonical = await readSettingsSnapshot(canonicalPath);
  if (canonical.result.kind !== "missing") {
    // Any surviving legacy file is ignored; say so instead of silently shadowing it.
    const shadowed: string[] = [];
    for (const legacyPath of legacyPlanModeSettingsPaths()) {
      if (await pathExists(legacyPath)) shadowed.push(basename(legacyPath));
    }
    return shadowed.length > 0
      ? {
          ...canonical.result,
          notice: `${shadowed.join(", ")} ignored because ${PLAN_MODE_SETTINGS_FILE} takes precedence.`,
        }
      : canonical.result;
  }

  for (const legacyPath of legacyPlanModeSettingsPaths()) {
    const legacy = await readSettingsSnapshot(legacyPath);
    if (legacy.result.kind === "missing") continue;
    const raced = await readSettingsSnapshot(canonicalPath);
    if (raced.result.kind !== "missing") return raced.result;
    return legacy.result.kind === "loaded"
      ? {
          ...legacy.result,
          notice: `Using legacy ${basename(legacyPath)}; rename it to ${PLAN_MODE_SETTINGS_FILE}. The legacy file was not modified.`,
        }
      : legacy.result;
  }
  return { kind: "missing" };
}

export function updatePlanModeSettings(
  patch: PlanModeSettingsPatch,
  options: UpdatePlanModeSettingsOptions = {},
): Promise<PlanModeSettings> {
  const settingsPath = options.settingsPath ?? planModeSettingsPath();
  const legacySettingsPaths =
    options.legacySettingsPaths ?? (options.settingsPath ? [] : legacyPlanModeSettingsPaths());
  return enqueueMutation(settingsPath, async () => {
    options.signal?.throwIfAborted();
    const current = await readSettingsDocumentForUpdate(settingsPath, legacySettingsPaths);
    const updated: SettingsDocument = { ...current };
    if (patch.thinkingLevel !== undefined) updated.thinkingLevel = patch.thinkingLevel;
    if (patch.defaultPlanTools === null) delete updated.defaultPlanTools;
    else if (patch.defaultPlanTools !== undefined) {
      updated.defaultPlanTools = [...patch.defaultPlanTools];
    }
    if (patch.planAdmittedAgents === null) delete updated.planAdmittedAgents;
    else if (patch.planAdmittedAgents !== undefined) {
      updated.planAdmittedAgents = [...patch.planAdmittedAgents];
    }
    if (patch.planAdmitWorkflowScripts === null) delete updated.planAdmitWorkflowScripts;
    else if (patch.planAdmitWorkflowScripts !== undefined) {
      updated.planAdmitWorkflowScripts = patch.planAdmitWorkflowScripts;
    }
    if (patch.implementationPlanRetention !== undefined) {
      updated.implementationPlanRetention = patch.implementationPlanRetention;
    }
    if (patch.defaultImplementationModel === null) delete updated.defaultImplementationModel;
    else if (patch.defaultImplementationModel !== undefined) {
      const model = normalizeImplementationModel(patch.defaultImplementationModel);
      if (!model) throw invalidSettingsError(settingsPath, "invalid implementation model");
      updated.defaultImplementationModel = model;
    }
    if (patch.defaultImplementationThinkingLevel === null) {
      delete updated.defaultImplementationThinkingLevel;
    } else if (patch.defaultImplementationThinkingLevel !== undefined) {
      updated.defaultImplementationThinkingLevel = patch.defaultImplementationThinkingLevel;
    }
    if (patch.defaultPlanExportPath === null) delete updated.defaultPlanExportPath;
    else if (patch.defaultPlanExportPath !== undefined) {
      updated.defaultPlanExportPath = patch.defaultPlanExportPath;
    }
    if (patch.toggleShortcut === null) delete updated.toggleShortcut;
    else if (patch.toggleShortcut !== undefined) {
      updated.toggleShortcut = patch.toggleShortcut;
    }
    if (patch.planOutputDir === null) delete updated.planOutputDir;
    else if (patch.planOutputDir !== undefined) {
      updated.planOutputDir = patch.planOutputDir;
    }
    if (patch.planSandbox === null) delete updated.planSandbox;
    else if (patch.planSandbox !== undefined) {
      updated.planSandbox = patch.planSandbox;
    }
    const settings = normalizePlanModeSettings(updated);
    if (!settings) throw invalidSettingsError(settingsPath, "invalid settings shape");
    await publishSettings(settingsPath, updated, options.signal, options.beforeRename);
    return settings;
  });
}

export async function awaitPlanModeSettingsWrites(settingsPath = planModeSettingsPath()): Promise<void> {
  await mutationQueues.get(settingsPath);
}

function enqueueMutation<T>(settingsPath: string, mutation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(settingsPath) ?? Promise.resolve();
  const result = previous.then(mutation, mutation);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  mutationQueues.set(settingsPath, settled);
  void settled.finally(() => {
    if (mutationQueues.get(settingsPath) === settled) mutationQueues.delete(settingsPath);
  });
  return result;
}

async function readSettingsDocumentForUpdate(
  settingsPath: string,
  legacySettingsPaths: readonly string[],
): Promise<SettingsDocument> {
  const canonical = await readSettingsSnapshot(settingsPath);
  if (canonical.result.kind === "loaded") return canonical.document ?? {};
  if (canonical.result.kind === "invalid") {
    throw invalidSettingsError(settingsPath, canonical.result.reason);
  }
  for (const legacyPath of legacySettingsPaths) {
    const legacy = await readSettingsSnapshot(legacyPath);
    const raced = await readSettingsSnapshot(settingsPath);
    if (raced.result.kind === "loaded") return raced.document ?? {};
    if (raced.result.kind === "invalid") {
      throw invalidSettingsError(settingsPath, raced.result.reason);
    }
    if (legacy.result.kind === "invalid") {
      throw invalidSettingsError(legacyPath, legacy.result.reason);
    }
    if (legacy.result.kind === "loaded") return legacy.document ?? {};
  }
  return {};
}

async function readSettingsSnapshot(settingsPath: string): Promise<SettingsSnapshot> {
  let contents: string;
  try {
    contents = await readSettingsContents(settingsPath);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return { result: { kind: "missing" } };
    return { result: { kind: "invalid", reason: safeReadError(error) } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    return { result: { kind: "invalid", reason: "invalid JSON" } };
  }
  const settings = normalizePlanModeSettings(parsed);
  if (!settings || !isSettingsDocument(parsed)) {
    return { result: { kind: "invalid", reason: "invalid settings shape" } };
  }
  return { document: parsed, result: { kind: "loaded", settings } };
}

async function readSettingsContents(settingsPath: string): Promise<string> {
  const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(settingsPath, flags);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error("settings path is not a regular file");
    if (stats.size > MAX_SETTINGS_BYTES) {
      throw new Error(`settings file exceeds ${MAX_SETTINGS_BYTES} bytes`);
    }
    const buffer = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_SETTINGS_BYTES) {
      throw new Error(`settings file exceeds ${MAX_SETTINGS_BYTES} bytes`);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, offset));
    } catch {
      throw new Error("settings file is not valid UTF-8");
    }
  } finally {
    await handle.close();
  }
}

async function publishSettings(
  settingsPath: string,
  document: SettingsDocument,
  signal?: AbortSignal,
  beforeRename?: (temporaryPath: string, settingsPath: string) => Promise<void>,
): Promise<void> {
  signal?.throwIfAborted();
  const contents = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(contents, "utf8") > MAX_SETTINGS_BYTES) {
    throw new Error(`settings document exceeds ${MAX_SETTINGS_BYTES} bytes`);
  }
  const directory = dirname(settingsPath);
  await mkdir(directory, { recursive: true });
  signal?.throwIfAborted();
  const temporaryPath = join(directory, `.${basename(settingsPath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
      signal,
    });
    await beforeRename?.(temporaryPath, settingsPath);
    signal?.throwIfAborted();
    await rename(temporaryPath, settingsPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function isSettingsDocument(value: unknown): value is SettingsDocument {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pathExists(path: string) {
  try {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    await handle.close();
    return true;
  } catch (error: unknown) {
    return !(isNodeError(error) && error.code === "ENOENT");
  }
}

function invalidSettingsError(settingsPath: string, reason: string) {
  return new Error(`pi-plan-vanguard settings at ${settingsPath} are invalid: ${reason}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function safeReadError(error: unknown) {
  if (isNodeError(error) && error.code === "ELOOP") return "settings path is not a regular file";
  return error instanceof Error ? error.message : String(error);
}

export function configuredThinkingLevel(settings: PlanModeSettings): PlanModeFixedThinkingLevel | undefined {
  return settings.thinkingLevel === "inherit" ? undefined : settings.thinkingLevel;
}

export function configuredImplementationPlanRetention(settings: PlanModeSettings): ImplementationPlanRetention {
  return settings.implementationPlanRetention ?? "clear-on-start";
}

export function configuredImplementationModel(settings: PlanModeSettings): ImplementationModelOverride | undefined {
  return settings.defaultImplementationModel;
}

export function configuredImplementationThinkingLevel(
  settings: PlanModeSettings,
): PlanModeFixedThinkingLevel | undefined {
  return settings.defaultImplementationThinkingLevel;
}

export function configuredPlanExportPath(settings: PlanModeSettings) {
  return settings.defaultPlanExportPath ?? DEFAULT_PLAN_EXPORT_PATH;
}

export function configuredPlanModeToggleShortcut(settings: PlanModeSettings): KeyId | undefined {
  return settings.toggleShortcut;
}

export function configuredPlanOutputDir(settings: PlanModeSettings) {
  return settings.planOutputDir?.trim() || undefined;
}

export function configuredPlanSandbox(settings: PlanModeSettings): PlanSandboxSettings {
  return settings.planSandbox ?? {};
}

/** Trusted agent names Plan mode auto-admits for read-only delegation calls. */
export function configuredPlanAdmittedAgents(settings: PlanModeSettings): string[] {
  return settings.planAdmittedAgents ?? [];
}

/** Whether `workflow: true` script delegation calls are admitted during Plan mode. */
export function configuredPlanAdmitWorkflowScripts(settings: PlanModeSettings): boolean {
  return settings.planAdmitWorkflowScripts === true;
}

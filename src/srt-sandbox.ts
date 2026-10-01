import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

/**
 * Plan-mode sandboxing on top of the Anthropic Sandbox Runtime (srt).
 *
 * SRT is a hard dependency of Plan mode: shell exploration runs inside an OS-level sandbox
 * (Seatbelt on macOS, bubblewrap on Linux, srt-win on Windows) with a read-mostly filesystem
 * profile and a deny-by-default network allowlist. There is deliberately no command-text
 * allowlist fallback; when the runtime is unavailable, Plan start fails with an agent-facing
 * setup guide instead.
 */

export const SRT_ENV_PATH_OVERRIDE = "PI_PLAN_MODE_SRT_PATH";
export const SRT_PROBE_TIMEOUT_MS = 15_000;

/** Prefix of the per-workflow private scratch directory created under os.tmpdir(). */
export const SRT_SCRATCH_DIR_PREFIX = "pi-plan-mode-scratch-";
const SRT_SCRATCH_DIR_PATTERN = /^pi-plan-mode-scratch-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** Basename of a profile written by srtProfileSettingsPath for a workflow or `/plan doctor`. */
export const SRT_PROFILE_FILE_PATTERN =
  /^pi-plan-mode-srt-(?:doctor-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/u;

/** Secret locations denied for reads unless the user narrows the profile. */
export const DEFAULT_SRT_DENY_READ = [
  "~/.ssh",
  "~/.aws",
  "~/.gnupg",
  "~/.config/gcloud",
  "~/.netrc",
  "**/.env",
  "**/.env.*",
] as const;

export interface SrtSandboxProfile {
  allowWrite: string[];
  /** Paths the sandbox may never write; srt gives denyWrite precedence over allowWrite. */
  denyWrite: string[];
  denyRead: string[];
  allowedDomains: string[];
}

export interface PlanSandboxProfileInput {
  /** Plan output directory: the only project path the sandbox may write. */
  outputDir: string;
  /** Per-workflow private scratch directory exported to sandboxed commands as TMPDIR. */
  scratchDir?: string;
  /** Directory holding srt profile files; always denied for writes so a command cannot rewrite its own profile. */
  profileDir: string;
  /** Extra paths that must stay unwritable regardless of user allowWrite (the pi agent dir, pi-plan-mode settings). */
  protectedPaths: readonly string[];
  /** User planSandbox settings extending the defaults. */
  allowWrite?: readonly string[];
  denyRead?: readonly string[];
  allowedDomains?: readonly string[];
}

/** Build the Plan-mode srt profile: writes only in the output dir, scratch dir, and user extras; profile and settings files always write-denied. */
export function buildPlanSandboxProfile(input: PlanSandboxProfileInput): SrtSandboxProfile {
  return {
    allowWrite: dedupe([input.outputDir, ...(input.scratchDir ? [input.scratchDir] : []), ...(input.allowWrite ?? [])]),
    denyWrite: dedupe([input.profileDir, ...input.protectedPaths]),
    denyRead: dedupe([...DEFAULT_SRT_DENY_READ, ...(input.denyRead ?? [])]),
    allowedDomains: dedupe(input.allowedDomains ?? []),
  };
}

function dedupe(values: readonly string[]) {
  return Array.from(new Set(values));
}

export type SrtPlatform = "linux" | "darwin" | "win32" | "other";

/** Linux package managers recognized by the setup guide, in PATH detection order. */
export type SrtLinuxPackageManager = "pacman" | "apt" | "dnf" | "zypper";

export const SRT_LINUX_PACKAGE_MANAGERS: readonly { manager: SrtLinuxPackageManager; binary: string }[] = [
  { manager: "pacman", binary: "pacman" },
  { manager: "apt", binary: "apt-get" },
  { manager: "dnf", binary: "dnf" },
  { manager: "zypper", binary: "zypper" },
];

const SRT_LINUX_INSTALL_COMMANDS: Record<SrtLinuxPackageManager, (packages: string) => string> = {
  pacman: (packages) => `sudo pacman -S --needed ${packages}`,
  apt: (packages) => `sudo apt-get install -y ${packages}`,
  dnf: (packages) => `sudo dnf install -y ${packages}`,
  zypper: (packages) => `sudo zypper install -y ${packages}`,
};

export interface SrtDependencyRule {
  /** Executable looked up on PATH. */
  name: string;
  /** Package providing the executable (same name across the supported package managers). */
  label: string;
}

export const SRT_LINUX_DEPENDENCIES: readonly SrtDependencyRule[] = [
  { name: "bwrap", label: "bubblewrap" },
  { name: "socat", label: "socat" },
  { name: "rg", label: "ripgrep" },
];

export const SRT_MACOS_DEPENDENCIES: readonly SrtDependencyRule[] = [{ name: "rg", label: "ripgrep" }];

export interface SrtProbeOutcome {
  code: number | null;
  stderr: string;
  error?: string;
}

export interface SrtRuntimeDiagnosis {
  ok: boolean;
  platform: SrtPlatform;
  /** Absolute or PATH-resolved srt command, present when the binary was found. */
  srtCommand?: string;
  /** Missing PATH dependencies by rule, including srt itself as `srt`. */
  missingDependencies: string[];
  /** Set when srt ran but the sandboxed probe command failed. */
  probeFailure?: { stderr: string };
  /** Linux package manager found on PATH, used to emit matching install commands. */
  linuxPackageManager?: SrtLinuxPackageManager;
}

export interface SrtRuntimeProbeOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Replacement for the default spawn-based probe, for tests. */
  runProbe?: (srtCommand: string, settingsPath: string) => Promise<SrtProbeOutcome>;
  /** Replacement for PATH executable lookups (dependencies and package managers), for tests. */
  checkDependency?: (name: string, env: NodeJS.ProcessEnv) => Promise<boolean>;
}

/** POSIX single-quote escaping for one shell word; returns undefined for strings no shell can carry. */
export function shellQuoteSingle(value: string) {
  if (value.includes("\u0000")) return undefined;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Wrap a bash tool command so pi executes it inside the SRT sandbox; undefined when unquotable.
 *
 * srt replaces the child's TMPDIR with `CLAUDE_CODE_TMPDIR` (default `/tmp/claude`), so the
 * private scratch directory is handed over through that variable. Setting TMPDIR on srt itself
 * would only move srt's own host-side sockets into the sandbox-writable scratch directory.
 */
export function wrapCommandForSrt(command: string, srtPath: string, settingsPath: string, scratchDir: string) {
  const quotedCommand = shellQuoteSingle(command);
  const quotedSettings = shellQuoteSingle(settingsPath);
  const quotedSrt = shellQuoteSingle(srtPath);
  const quotedScratch = shellQuoteSingle(scratchDir);
  if (
    quotedCommand === undefined ||
    quotedSettings === undefined ||
    quotedSrt === undefined ||
    quotedScratch === undefined
  ) {
    return undefined;
  }
  return `CLAUDE_CODE_TMPDIR=${quotedScratch} ${quotedSrt} -s ${quotedSettings} -c ${quotedCommand}`;
}

export function buildSrtSettingsContents(profile: SrtSandboxProfile) {
  return `${JSON.stringify(
    {
      network: {
        allowedDomains: profile.allowedDomains,
        deniedDomains: [],
      },
      filesystem: {
        denyRead: profile.denyRead,
        allowRead: [],
        allowWrite: profile.allowWrite,
        denyWrite: profile.denyWrite,
      },
    },
    null,
    2,
  )}\n`;
}

/**
 * Profile file path inside `profileDir`. The directory must never be sandbox-writable (srt
 * re-reads `-s` settings on every call), so callers pass a private directory outside os.tmpdir().
 */
export function srtProfileSettingsPath(profileDir: string, sessionKey: string) {
  return join(profileDir, `pi-plan-mode-srt-${sessionKey}.json`);
}

/** Write a profile as a fresh 0600 file inside a 0700 profile directory. */
export async function writeSrtProfile(settingsPath: string, profile: SrtSandboxProfile) {
  const profileDir = dirname(settingsPath);
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  await chmod(profileDir, 0o700);
  await writeFile(settingsPath, buildSrtSettingsContents(profile), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

/** Remove a profile created by srtProfileSettingsPath in `profileDir`; other paths (e.g. tampered state) are ignored. */
export async function removeSrtProfile(settingsPath: string | undefined, profileDir: string) {
  if (!settingsPath || !isSrtProfilePath(settingsPath, profileDir)) return;
  await rm(settingsPath, { force: true }).catch(() => undefined);
}

export function isSrtProfilePath(path: string, profileDir: string) {
  const absolute = resolve(path);
  return dirname(absolute) === resolve(profileDir) && SRT_PROFILE_FILE_PATTERN.test(basename(absolute));
}

/** Create a per-workflow private (0700) scratch directory under os.tmpdir(). */
export async function createSrtScratchDir() {
  const scratchDir = join(tmpdir(), `${SRT_SCRATCH_DIR_PREFIX}${randomUUID()}`);
  await mkdir(scratchDir, { mode: 0o700 });
  return scratchDir;
}

/** Remove a scratch directory created by createSrtScratchDir; other paths (e.g. tampered state) are ignored. */
export async function removeSrtScratchDir(scratchDir: string | undefined) {
  if (!scratchDir || !isSrtScratchDir(scratchDir)) return;
  await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
}

export function isSrtScratchDir(path: string) {
  const absolute = resolve(path);
  return dirname(absolute) === resolve(tmpdir()) && SRT_SCRATCH_DIR_PATTERN.test(basename(absolute));
}

async function findOnPath(name: string, env: NodeJS.ProcessEnv) {
  const searchPaths = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const directory of searchPaths) {
    const candidate = join(directory, name);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

export function srtPlatform(platform: NodeJS.Platform): SrtPlatform {
  if (platform === "linux") return "linux";
  if (platform === "darwin") return "darwin";
  if (platform === "win32") return "win32";
  return "other";
}

function platformDependencies(platform: SrtPlatform) {
  if (platform === "linux") return SRT_LINUX_DEPENDENCIES;
  if (platform === "darwin") return SRT_MACOS_DEPENDENCIES;
  return [];
}

function defaultRunProbe(srtCommand: string, settingsPath: string, timeoutMs: number): Promise<SrtProbeOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(srtCommand, ["-s", settingsPath, "-c", "exit 0"], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    const finish = (outcome: SrtProbeOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: null, stderr, error: `probe timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 8_000) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish({ code: null, stderr, error: error.message }));
    child.on("close", (code) => finish({ code, stderr }));
  });
}

/**
 * Detect and verify the SRT runtime. The probe runs the real sandbox (`srt -s <profile> -c 'exit 0'`),
 * which fails fast when bubblewrap/socat/srt-win prerequisites are missing and surfaces their stderr.
 */
export async function diagnoseSrtRuntime(
  options: SrtRuntimeProbeOptions & { settingsPath: string; timeoutMs?: number },
): Promise<SrtRuntimeDiagnosis> {
  const platform = srtPlatform(options.platform ?? process.platform);
  const env = options.env ?? process.env;
  const missingDependencies: string[] = [];

  const override = env[SRT_ENV_PATH_OVERRIDE]?.trim();
  let srtCommand: string | undefined;
  if (override) {
    srtCommand = override;
    try {
      await access(override, fsConstants.X_OK);
    } catch {
      missingDependencies.push("srt");
      srtCommand = undefined;
    }
  } else {
    const binaryName = platform === "win32" ? "srt.cmd" : "srt";
    srtCommand = (await findOnPath(binaryName, env)) ?? (await findOnPath("srt", env));
    if (!srtCommand) missingDependencies.push("srt");
  }

  const resolveDependency = options.checkDependency ?? ((name: string, dependencyEnv: NodeJS.ProcessEnv) => findOnPath(name, dependencyEnv));
  for (const rule of platformDependencies(platform)) {
    if (!(await resolveDependency(rule.name, env))) missingDependencies.push(rule.name);
  }
  const detectPackageManager = async () => {
    if (platform !== "linux") return {};
    for (const candidate of SRT_LINUX_PACKAGE_MANAGERS) {
      if (await resolveDependency(candidate.binary, env)) return { linuxPackageManager: candidate.manager };
    }
    return {};
  };

  if (missingDependencies.length > 0 || !srtCommand) {
    return {
      ok: false,
      platform,
      ...(srtCommand ? { srtCommand } : {}),
      missingDependencies,
      ...(await detectPackageManager()),
    };
  }

  const runProbe =
    options.runProbe ?? ((command: string, settings: string) => defaultRunProbe(command, settings, options.timeoutMs ?? SRT_PROBE_TIMEOUT_MS));
  const outcome = await runProbe(srtCommand, options.settingsPath);
  if (outcome.code === 0) {
    return { ok: true, platform, srtCommand, missingDependencies: [] };
  }
  const detail = outcome.error ?? (outcome.stderr.trim() || `exit code ${outcome.code ?? "unknown"}`);
  return {
    ok: false,
    platform,
    srtCommand,
    missingDependencies: [],
    probeFailure: { stderr: detail },
    ...(await detectPackageManager()),
  };
}

export interface SrtSetupGuideOptions {
  env?: NodeJS.ProcessEnv;
}

const SRT_NPM_INSTALL = "npm install -g @anthropic-ai/sandbox-runtime";

/**
 * Build the agent-facing setup guide injected when the sandbox is unavailable. The diagnosis is
 * generated from real system state (never from model output), so the commands below are the
 * sanctioned way to repair the environment.
 */
export function buildSrtSetupGuide(diagnosis: SrtRuntimeDiagnosis, options: SrtSetupGuideOptions = {}) {
  const env = options.env ?? process.env;
  const lines: string[] = [
    "## Plan mode needs the Anthropic Sandbox Runtime (srt)",
    "",
    "Plan mode runs all shell exploration inside the srt OS sandbox, so the sandbox must be installed and healthy before a Plan workflow can start. The current environment does not pass the sandbox check.",
    "",
    "**Diagnosis**",
  ];
  if (diagnosis.missingDependencies.includes("srt")) {
    lines.push(`- The \`srt\` command was not found on PATH${env[SRT_ENV_PATH_OVERRIDE] ? ` (override ${SRT_ENV_PATH_OVERRIDE}=${env[SRT_ENV_PATH_OVERRIDE]} is not executable)` : ""}.`);
  }
  const dependencyLabels = diagnosis.missingDependencies.filter((name) => name !== "srt");
  if (dependencyLabels.length > 0) {
    lines.push(`- Missing ${diagnosis.platform} dependencies: ${dependencyLabels.join(", ")}.`);
  }
  if (diagnosis.probeFailure) {
    lines.push(`- The sandbox probe ran but failed: ${summarizeProbeFailure(diagnosis.probeFailure.stderr)}`);
  }
  lines.push("", "**How to fix this platform**");
  const commands = new Set<string>();
  if (diagnosis.missingDependencies.includes("srt")) commands.add(SRT_NPM_INSTALL);
  if (diagnosis.platform === "linux") {
    const packages = missingPackages(SRT_LINUX_DEPENDENCIES, diagnosis.missingDependencies);
    const manager = diagnosis.linuxPackageManager;
    if (packages.length > 0 && manager) commands.add(SRT_LINUX_INSTALL_COMMANDS[manager](packages.join(" ")));
    for (const command of commands) lines.push(`- \`${command}\``);
    if (packages.length > 0 && !manager) {
      lines.push(
        `- No supported package manager (pacman, apt-get, dnf, zypper) was found on PATH. Install these packages with your distribution's package manager: ${packages.join(", ")}.`,
      );
    }
    if (manager === "apt" || !manager) {
      lines.push("- Ubuntu 24.04+ may also need: `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` (bubblewrap needs capability-bearing user namespaces).");
    }
  } else if (diagnosis.platform === "darwin") {
    const packages = missingPackages(SRT_MACOS_DEPENDENCIES, diagnosis.missingDependencies);
    if (packages.length > 0) commands.add(`brew install ${packages.join(" ")}`);
    for (const command of commands) lines.push(`- \`${command}\``);
  } else if (diagnosis.platform === "win32") {
    for (const command of commands) lines.push(`- \`${command}\``);
    lines.push("- Then run the one-time elevated install: `npx @anthropic-ai/sandbox-runtime windows-install` (Windows support is alpha).");
  } else {
    lines.push(`- This platform (${diagnosis.platform}) is not supported by srt; Plan mode cannot start here.`);
  }
  lines.push(
    "",
    "**What to do now**",
    "",
    "1. Show the user this diagnosis and the exact commands above.",
    "2. With the user's explicit approval (through Pi's normal permission flow), run those commands. Do not run them without approval, and do not run anything else to work around the sandbox.",
    "3. After installation succeeds, ask the user to run `/plan start` again (a stashed planning prompt, if any, is re-sent automatically).",
    "",
    "There is intentionally no non-sandbox fallback for Plan-mode shell access.",
  );
  return lines.join("\n");
}

function missingPackages(rules: readonly SrtDependencyRule[], missingDependencies: readonly string[]) {
  return rules.filter((rule) => missingDependencies.includes(rule.name)).map((rule) => rule.label);
}

export function summarizeProbeFailure(stderr: string) {
  const normalized = stderr.replace(/\s+/g, " ").trim();
  if (!normalized) return "unknown probe failure";
  return normalized.length > 500 ? `${normalized.slice(0, 499)}…` : normalized;
}

/** Human-readable one-line doctor status for `/plan doctor`. */
export function describeSrtDiagnosis(diagnosis: SrtRuntimeDiagnosis) {
  if (diagnosis.ok) return `srt sandbox: OK (${diagnosis.srtCommand})`;
  const parts: string[] = [];
  if (diagnosis.missingDependencies.length > 0) parts.push(`missing: ${diagnosis.missingDependencies.join(", ")}`);
  if (diagnosis.probeFailure) parts.push(`probe failed: ${summarizeProbeFailure(diagnosis.probeFailure.stderr)}`);
  return `srt sandbox: UNAVAILABLE${parts.length > 0 ? ` (${parts.join("; ")})` : ""}`;
}

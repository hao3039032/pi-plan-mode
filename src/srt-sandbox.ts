import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
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

/** Scratch space every sandbox profile keeps writable. */
export const SRT_SCRATCH_WRITE_PATH = "/tmp";

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
  denyRead: string[];
  allowedDomains: string[];
}

export type SrtPlatform = "linux" | "darwin" | "win32" | "other";

export interface SrtDependencyRule {
  name: string;
  label: string;
  install: Partial<Record<"apt" | "dnf" | "pacman" | "brew", string>>;
}

export const SRT_LINUX_DEPENDENCIES: readonly SrtDependencyRule[] = [
  {
    name: "bwrap",
    label: "bubblewrap",
    install: { apt: "sudo apt-get install -y bubblewrap", dnf: "sudo dnf install -y bubblewrap", pacman: "sudo pacman -S --noconfirm bubblewrap" },
  },
  {
    name: "socat",
    label: "socat",
    install: { apt: "sudo apt-get install -y socat", dnf: "sudo dnf install -y socat", pacman: "sudo pacman -S --noconfirm socat" },
  },
  {
    name: "rg",
    label: "ripgrep",
    install: { apt: "sudo apt-get install -y ripgrep", dnf: "sudo dnf install -y ripgrep", pacman: "sudo pacman -S --noconfirm ripgrep" },
  },
];

export const SRT_MACOS_DEPENDENCIES: readonly SrtDependencyRule[] = [
  {
    name: "rg",
    label: "ripgrep",
    install: { brew: "brew install ripgrep" },
  },
];

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
}

export interface SrtRuntimeProbeOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Replacement for the default spawn-based probe, for tests. */
  runProbe?: (srtCommand: string, settingsPath: string) => Promise<SrtProbeOutcome>;
  /** Replacement for PATH dependency lookups, for tests. */
  checkDependency?: (name: string, env: NodeJS.ProcessEnv) => Promise<boolean>;
}

/** POSIX single-quote escaping for one shell word; returns undefined for strings no shell can carry. */
export function shellQuoteSingle(value: string) {
  if (value.includes("\u0000")) return undefined;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Wrap a bash tool command so pi executes it inside the SRT sandbox; undefined when unquotable. */
export function wrapCommandForSrt(command: string, srtPath: string, settingsPath: string) {
  const quotedCommand = shellQuoteSingle(command);
  const quotedSettings = shellQuoteSingle(settingsPath);
  if (quotedCommand === undefined || quotedSettings === undefined) return undefined;
  const quotedSrt = shellQuoteSingle(srtPath);
  return `${quotedSrt ?? srtPath} -s ${quotedSettings} -c ${quotedCommand}`;
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
        denyWrite: [],
      },
    },
    null,
    2,
  )}\n`;
}

export function srtProfileSettingsPath(sessionKey: string) {
  return join(tmpdir(), `pi-plan-mode-srt-${sessionKey}.json`);
}

export async function writeSrtProfile(settingsPath: string, profile: SrtSandboxProfile) {
  await mkdir(join(settingsPath, ".."), { recursive: true });
  await writeFile(settingsPath, buildSrtSettingsContents(profile), {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function removeSrtProfile(settingsPath: string | undefined) {
  if (!settingsPath) return;
  await rm(settingsPath, { force: true }).catch(() => undefined);
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

  if (missingDependencies.length > 0 || !srtCommand) {
    return { ok: false, platform, ...(srtCommand ? { srtCommand } : {}), missingDependencies };
  }

  const runProbe =
    options.runProbe ?? ((command: string, settings: string) => defaultRunProbe(command, settings, options.timeoutMs ?? SRT_PROBE_TIMEOUT_MS));
  const outcome = await runProbe(srtCommand, options.settingsPath);
  if (outcome.code === 0) {
    return { ok: true, platform, srtCommand, missingDependencies: [] };
  }
  const detail = outcome.error ?? (outcome.stderr.trim() || `exit code ${outcome.code ?? "unknown"}`);
  return { ok: false, platform, srtCommand, missingDependencies: [], probeFailure: { stderr: detail } };
}

export interface SrtSetupGuideOptions {
  env?: NodeJS.ProcessEnv;
  /** Package-manager key used to pick install commands on Linux, for tests. */
  linuxPackageManager?: "apt" | "dnf" | "pacman";
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
    for (const rule of SRT_LINUX_DEPENDENCIES) {
      if (diagnosis.missingDependencies.includes(rule.name)) {
        const install = rule.install[options.linuxPackageManager ?? "apt"] ?? rule.install.apt;
        commands.add(install ?? `install ${rule.label}`);
      }
    }
    for (const command of commands) lines.push(`- \`${command}\``);
    lines.push("- Ubuntu 24.04+ may also need: `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` (bubblewrap needs capability-bearing user namespaces).");
  } else if (diagnosis.platform === "darwin") {
    for (const rule of SRT_MACOS_DEPENDENCIES) {
      if (diagnosis.missingDependencies.includes(rule.name)) commands.add(rule.install.brew ?? `install ${rule.label}`);
    }
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

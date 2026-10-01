import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { test } from "vitest";
import {
  buildPlanSandboxProfile,
  buildSrtSettingsContents,
  buildSrtSetupGuide,
  createSrtScratchDir,
  describeSrtDiagnosis,
  diagnoseSrtRuntime,
  DEFAULT_SRT_DENY_READ,
  isSrtProfilePath,
  isSrtScratchDir,
  removeSrtProfile,
  removeSrtScratchDir,
  shellQuoteSingle,
  srtProfileSettingsPath,
  wrapCommandForSrt,
  writeSrtProfile,
} from "../src/srt-sandbox.js";

const EMPTY_ENV = { PATH: "" };
const SRT_COMMAND = process.env.PI_PLAN_MODE_SRT_PATH?.trim() || "srt";

/** Whether the real srt CLI can run a sandboxed command here (skips the real-sandbox regression test otherwise). */
function srtIsRunnable() {
  if (process.platform === "win32") return false;
  let directory: string | undefined;
  try {
    directory = mkdtempSync(join(tmpdir(), "pi-plan-mode-srt-detect-"));
    const profile = join(directory, "profile.json");
    writeFileSync(
      profile,
      buildSrtSettingsContents({ allowWrite: [], denyWrite: [], denyRead: [], allowedDomains: [] }),
    );
    const probe = spawnSync(SRT_COMMAND, ["-s", profile, "-c", "exit 0"], { stdio: "ignore", timeout: 10_000 });
    return probe.status === 0;
  } catch {
    return false;
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}

function isAtOrUnder(path: string, directory: string) {
  const rel = relative(directory, path);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

test("shellQuoteSingle wraps POSIX words and round-trips embedded quotes", () => {
  assert.equal(shellQuoteSingle("ls -la"), "'ls -la'");
  assert.equal(shellQuoteSingle("a\nb"), "'a\nb'");
  assert.equal(shellQuoteSingle("NUL\u0000byte"), undefined);
  // The quoted word must parse back to the original input under sh -c.
  for (const value of ["echo 'hi'", 'grep "plan" src', "计划'文档", "a\nb c"]) {
    const quoted = shellQuoteSingle(value);
    assert.ok(quoted, value);
    const roundTrip = execFileSync("/bin/sh", ["-c", `printf %s ${quoted}`]).toString();
    assert.equal(roundTrip, value);
  }
});

test("wrapCommandForSrt preserves the original command as one shell word", () => {
  const command = "cat README.md | grep 'plan' > out.txt";
  const wrapped = wrapCommandForSrt(command, "/usr/bin/srt", "/agent/srt/settings.json", "/tmp/pi-plan-mode-scratch-x");
  assert.ok(wrapped);
  assert.equal(wrapped.split(" ")[0], `CLAUDE_CODE_TMPDIR='/tmp/pi-plan-mode-scratch-x'`);
  assert.equal(wrapped.split(" ")[1], `'/usr/bin/srt'`);
  assert.equal(wrapCommandForSrt("bad\u0000", "/usr/bin/srt", "/tmp/s.json", "/tmp/scratch"), undefined);
  assert.equal(wrapCommandForSrt("true", "/usr/bin/srt", "/tmp/s.json", "/tmp/bad\u0000scratch"), undefined);
  // The wrapped line must parse back to the same arguments under sh -c.
  const parsed = execFileSync("/bin/sh", ["-c", `set -- ${wrapped.replace(/^CLAUDE_CODE_TMPDIR=/u, "")}; printf '%s|%s|%s' "$1" "$3" "$6"`]).toString();
  assert.equal(parsed, "/tmp/pi-plan-mode-scratch-x|-s|cat README.md | grep 'plan' > out.txt");
});

test("wrapCommandForSrt tolerates quoteable srt paths with spaces", () => {
  const wrapped = wrapCommandForSrt("true", "/opt/tools/srt bin/srt", "/tmp/s.json", "/tmp/scratch dir");
  assert.ok(wrapped?.startsWith(`CLAUDE_CODE_TMPDIR='/tmp/scratch dir' '/opt/tools/srt bin/srt' -s`));
  assert.ok(wrapped?.endsWith(` -c 'true'`));
});

test("buildSrtSettingsContents emits the deny-by-default profile", () => {
  const contents = buildSrtSettingsContents({
    allowWrite: ["/tmp/pi-plan-mode-scratch-x", "/repo/plans"],
    denyWrite: ["/agent/srt"],
    denyRead: [...DEFAULT_SRT_DENY_READ],
    allowedDomains: [],
  });
  const parsed = JSON.parse(contents) as {
    network: { allowedDomains: string[]; deniedDomains: string[] };
    filesystem: { denyRead: string[]; allowRead: string[]; allowWrite: string[]; denyWrite: string[] };
  };
  assert.deepEqual(parsed.network, { allowedDomains: [], deniedDomains: [] });
  assert.deepEqual(parsed.filesystem.allowWrite, ["/tmp/pi-plan-mode-scratch-x", "/repo/plans"]);
  assert.deepEqual(parsed.filesystem.allowRead, []);
  assert.deepEqual(parsed.filesystem.denyWrite, ["/agent/srt"]);
  assert.ok(parsed.filesystem.denyRead.includes("~/.ssh"));
  assert.ok(parsed.filesystem.denyRead.includes("**/.env"));
});

test("buildPlanSandboxProfile keeps the profile directory and settings unwritable", () => {
  const profileDir = "/home/user/.pi/agent/srt";
  const settingsFile = "/home/user/.pi/agent/pi-plan-mode.json";
  const profile = buildPlanSandboxProfile({
    outputDir: "/repo/plans",
    scratchDir: "/tmp/pi-plan-mode-scratch-1",
    profileDir,
    protectedPaths: [settingsFile],
  });
  assert.deepEqual(profile.allowWrite, ["/repo/plans", "/tmp/pi-plan-mode-scratch-1"]);
  assert.ok(!profile.allowWrite.includes("/tmp"), "no blanket /tmp write grant");
  const profilePath = srtProfileSettingsPath(profileDir, "session");
  for (const entry of profile.allowWrite) {
    assert.equal(isAtOrUnder(profilePath, entry), false, `profile path is under allowWrite entry ${entry}`);
  }
  assert.ok(profile.denyWrite.some((entry) => isAtOrUnder(profilePath, entry)));
  assert.ok(profile.denyWrite.includes(settingsFile));

  // A user-widened allowWrite still cannot reach the profile directory: srt gives denyWrite precedence.
  const widened = buildPlanSandboxProfile({
    outputDir: "/repo/plans",
    profileDir,
    protectedPaths: [settingsFile],
    allowWrite: ["/home/user"],
    denyRead: ["~/.kube"],
    allowedDomains: ["api.github.com"],
  });
  assert.deepEqual(widened.allowWrite, ["/repo/plans", "/home/user"]);
  assert.deepEqual(widened.denyWrite, [profileDir, settingsFile]);
  assert.ok(widened.denyRead.includes("~/.kube") && widened.denyRead.includes("~/.ssh"));
  assert.deepEqual(widened.allowedDomains, ["api.github.com"]);
});

test("scratch directories are private and removal only touches pi-plan-mode scratch paths", async () => {
  const scratchDir = await createSrtScratchDir();
  try {
    assert.equal(dirname(scratchDir), tmpdir());
    assert.equal(isSrtScratchDir(scratchDir), true);
    assert.equal((await stat(scratchDir)).mode & 0o777, 0o700);
  } finally {
    await removeSrtScratchDir(scratchDir);
  }
  assert.equal(existsSync(scratchDir), false);

  const other = await mkdtemp(join(tmpdir(), "pi-plan-mode-not-scratch-"));
  try {
    assert.equal(isSrtScratchDir(other), false);
    await removeSrtScratchDir(other);
    assert.equal(existsSync(other), true);
  } finally {
    await rm(other, { recursive: true, force: true });
  }
});

test("srt profile files round-trip through write and removal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-srt-"));
  try {
    const profileDir = join(directory, "agent", "srt");
    const settingsPath = srtProfileSettingsPath(profileDir, randomUUID());
    assert.equal(dirname(settingsPath), profileDir);
    await writeSrtProfile(settingsPath, {
      allowWrite: [join(directory, "plans")],
      denyWrite: [profileDir],
      denyRead: [...DEFAULT_SRT_DENY_READ],
      allowedDomains: [],
    });
    assert.equal((await stat(profileDir)).mode & 0o777, 0o700);
    assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
    const diagnosis = await diagnoseSrtRuntime({
      settingsPath,
      env: EMPTY_ENV,
      platform: "linux",
      runProbe: async () => ({ code: 0, stderr: "" }),
    });
    // srt is not on PATH in EMPTY_ENV, so the diagnosis fails before probing.
    assert.equal(diagnosis.ok, false);
    assert.deepEqual(diagnosis.missingDependencies, ["srt", "bwrap", "socat", "rg"]);
    assert.equal(diagnosis.linuxPackageManager, undefined);
    await removeSrtProfile(settingsPath, profileDir);
    assert.equal(existsSync(settingsPath), false);
    await removeSrtProfile(undefined, profileDir);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("removeSrtProfile deletes only profile files this extension names inside the profile dir", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-srt-"));
  try {
    const profileDir = join(directory, "srt");
    await mkdir(profileDir);
    const uuid = randomUUID();
    const workflowProfile = srtProfileSettingsPath(profileDir, uuid);
    const doctorProfile = srtProfileSettingsPath(profileDir, `doctor-${uuid}`);
    // Tampered state: a victim outside the profile dir, a non-profile file inside it, a lookalike via "..".
    const outsideVictim = join(directory, `pi-plan-mode-srt-${uuid}.json`);
    const insideOther = join(profileDir, "notes.json");
    for (const path of [workflowProfile, doctorProfile, outsideVictim, insideOther]) await writeFile(path, "{}");
    assert.equal(isSrtProfilePath(workflowProfile, profileDir), true);
    assert.equal(isSrtProfilePath(doctorProfile, profileDir), true);
    assert.equal(isSrtProfilePath(outsideVictim, profileDir), false);
    assert.equal(isSrtProfilePath(join(profileDir, "..", basename(outsideVictim)), profileDir), false);
    for (const path of [outsideVictim, insideOther, join(profileDir, "..", basename(outsideVictim))]) {
      await removeSrtProfile(path, profileDir);
    }
    assert.equal(existsSync(outsideVictim), true);
    assert.equal(existsSync(insideOther), true);
    await removeSrtProfile(workflowProfile, profileDir);
    await removeSrtProfile(doctorProfile, profileDir);
    assert.equal(existsSync(workflowProfile), false);
    assert.equal(existsSync(doctorProfile), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("diagnoseSrtRuntime detects the Linux package manager from PATH in a fixed order", async () => {
  const diagnoseWith = (available: readonly string[]) =>
    diagnoseSrtRuntime({
      settingsPath: "/tmp/unused.json",
      env: { PATH: "/usr/bin" },
      platform: "linux",
      checkDependency: async (name) => available.includes(name),
      runProbe: async () => ({ code: 0, stderr: "" }),
    });
  assert.equal((await diagnoseWith(["pacman", "apt-get", "dnf", "zypper"])).linuxPackageManager, "pacman");
  assert.equal((await diagnoseWith(["apt-get", "dnf"])).linuxPackageManager, "apt");
  assert.equal((await diagnoseWith(["dnf", "zypper"])).linuxPackageManager, "dnf");
  assert.equal((await diagnoseWith(["zypper"])).linuxPackageManager, "zypper");
  assert.equal((await diagnoseWith([])).linuxPackageManager, undefined);

  const darwin = await diagnoseSrtRuntime({
    settingsPath: "/tmp/unused.json",
    env: { PATH: "/usr/bin" },
    platform: "darwin",
    checkDependency: async (name) => name === "pacman",
  });
  assert.equal(darwin.linuxPackageManager, undefined);
});

test("diagnoseSrtRuntime reports a failing probe with stderr detail", async () => {
  const diagnosis = await diagnoseSrtRuntime({
    settingsPath: "/tmp/unused.json",
    env: { PATH: "/usr/bin", PI_PLAN_MODE_SRT_PATH: "/bin/true" },
    platform: "linux",
    checkDependency: async () => true,
    runProbe: async () => ({ code: 1, stderr: "bwrap is not installed" }),
  });
  assert.equal(diagnosis.ok, false);
  assert.equal(diagnosis.probeFailure?.stderr, "bwrap is not installed");
  assert.deepEqual(diagnosis.missingDependencies, []);
});

test("diagnoseSrtRuntime passes when the probe exits zero", async () => {
  const diagnosis = await diagnoseSrtRuntime({
    settingsPath: "/tmp/unused.json",
    env: { PATH: "/usr/bin", PI_PLAN_MODE_SRT_PATH: "/bin/true" },
    platform: "linux",
    checkDependency: async () => true,
    runProbe: async () => ({ code: 0, stderr: "" }),
  });
  assert.equal(diagnosis.ok, true);
  assert.equal(diagnosis.srtCommand, "/bin/true");
});

test("diagnoseSrtRuntime flags an unexecutable override as missing srt", async () => {
  const diagnosis = await diagnoseSrtRuntime({
    settingsPath: "/tmp/unused.json",
    env: { PATH: "/usr/bin", PI_PLAN_MODE_SRT_PATH: "/nonexistent/srt" },
    platform: "linux",
    checkDependency: async () => true,
    runProbe: async () => ({ code: 0, stderr: "" }),
  });
  assert.equal(diagnosis.ok, false);
  assert.ok(diagnosis.missingDependencies.includes("srt"));
});

test("buildSrtSetupGuide lists platform install commands and approval rules", () => {
  const missingAll = ["srt", "bwrap", "socat", "rg"];
  const guide = buildSrtSetupGuide({ ok: false, platform: "linux", missingDependencies: missingAll, linuxPackageManager: "apt" });
  assert.match(guide, /npm install -g @anthropic-ai\/sandbox-runtime/);
  assert.match(guide, /`sudo apt-get install -y bubblewrap socat ripgrep`/);
  assert.match(guide, /apparmor_restrict_unprivileged_userns/);
  assert.match(guide, /approval/);
  assert.match(guide, /\/plan start/);

  const archGuide = buildSrtSetupGuide({
    ok: false,
    platform: "linux",
    missingDependencies: missingAll,
    linuxPackageManager: "pacman",
  });
  assert.match(archGuide, /`sudo pacman -S --needed bubblewrap socat ripgrep`/);
  assert.doesNotMatch(archGuide, /apt-get|apparmor/);

  const socatOnly = buildSrtSetupGuide({
    ok: false,
    platform: "linux",
    missingDependencies: ["socat"],
    linuxPackageManager: "pacman",
  });
  assert.match(socatOnly, /`sudo pacman -S --needed socat`/);
  assert.doesNotMatch(socatOnly, /npm install|bubblewrap/);

  assert.match(
    buildSrtSetupGuide({ ok: false, platform: "linux", missingDependencies: ["bwrap"], linuxPackageManager: "dnf" }),
    /`sudo dnf install -y bubblewrap`/,
  );
  assert.match(
    buildSrtSetupGuide({ ok: false, platform: "linux", missingDependencies: ["rg"], linuxPackageManager: "zypper" }),
    /`sudo zypper install -y ripgrep`/,
  );

  const unknownManager = buildSrtSetupGuide({ ok: false, platform: "linux", missingDependencies: ["bwrap", "rg"] });
  assert.match(unknownManager, /No supported package manager/);
  assert.match(unknownManager, /bubblewrap, ripgrep/);
  assert.doesNotMatch(unknownManager, /sudo (apt-get|pacman|dnf|zypper)/);

  const macGuide = buildSrtSetupGuide({ ok: false, platform: "darwin", missingDependencies: ["rg"] });
  assert.match(macGuide, /`brew install ripgrep`/);

  const probeGuide = buildSrtSetupGuide({
    ok: false,
    platform: "linux",
    srtCommand: "/usr/bin/srt",
    missingDependencies: [],
    probeFailure: { stderr: "sandbox init failed" },
    linuxPackageManager: "pacman",
  });
  assert.match(probeGuide, /sandbox init failed/);
  assert.doesNotMatch(probeGuide, /sudo pacman/);
});

test("describeSrtDiagnosis summarizes health and failures", () => {
  assert.match(
    describeSrtDiagnosis({ ok: true, platform: "linux", srtCommand: "/usr/bin/srt", missingDependencies: [] }),
    /OK/,
  );
  assert.match(describeSrtDiagnosis({ ok: false, platform: "linux", missingDependencies: ["srt"] }), /missing: srt/);
});

test.skipIf(!srtIsRunnable())(
  "real srt: a sandboxed command cannot rewrite its profile or widen the next call",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-plan-mode-srt-e2e-"));
    const homeMarker = join(homedir(), `pi-plan-mode-escape-${randomUUID()}`);
    const tmpMarker = join(tmpdir(), `pi-plan-mode-escape-${randomUUID()}`);
    let scratchDir: string | undefined;
    try {
      const agentDir = join(root, "agent");
      const profileDir = join(agentDir, "srt");
      const settingsFile = join(agentDir, "pi-plan-mode.json");
      const repo = join(root, "repo");
      const outputDir = join(repo, "plans");
      await mkdir(outputDir, { recursive: true });
      scratchDir = await createSrtScratchDir();
      // The user widened allowWrite to the whole agent dir; denyWrite must still protect the profile.
      const profile = buildPlanSandboxProfile({
        outputDir,
        scratchDir,
        profileDir,
        protectedPaths: [settingsFile],
        allowWrite: [agentDir],
      });
      const settingsPath = srtProfileSettingsPath(profileDir, randomUUID());
      await writeSrtProfile(settingsPath, profile);
      const original = await readFile(settingsPath, "utf8");
      const run = (command: string) => {
        const wrapped = wrapCommandForSrt(command, SRT_COMMAND, settingsPath, scratchDir as string);
        assert.ok(wrapped);
        return spawnSync("/bin/sh", ["-c", wrapped], { cwd: repo, encoding: "utf8", timeout: 2_000 });
      };
      const q = (value: string) => shellQuoteSingle(value) as string;

      const attack = run(
        [
          `sed -i 's|"allowWrite": \\[|"allowWrite": [ "'"$HOME"'",|' ${q(settingsPath)} && echo SED_OK`,
          `printf '{}' > ${q(settingsPath)} && echo OVERWRITE_OK`,
          `mv ${q(settingsPath)} ${q(`${settingsPath}.moved`)} && echo MOVE_OK`,
          `touch ${q(join(profileDir, "planted.json"))} && echo PLANT_OK`,
          `printf '{}' > ${q(settingsFile)} && echo SETTINGS_OK`,
          `touch ${q(join(agentDir, "extra-ok"))} && echo EXTRA_OK`,
          `printf draft > plans/draft.md && echo PLANS_OK`,
          `printf "$TMPDIR" > "$TMPDIR/where" && echo SCRATCH_OK`,
          `touch ${q(tmpMarker)} && echo TMP_OK`,
          "true",
        ].join("; "),
      );
      assert.equal(attack.status, 0, attack.stderr);
      const markers = attack.stdout.split(/\s+/u).filter(Boolean);
      assert.deepEqual(markers, ["EXTRA_OK", "PLANS_OK", "SCRATCH_OK"], attack.stderr);
      assert.equal(await readFile(settingsPath, "utf8"), original);
      assert.equal(existsSync(join(profileDir, "planted.json")), false);
      assert.equal(existsSync(tmpMarker), false);
      assert.equal(await readFile(join(scratchDir, "where"), "utf8"), scratchDir);
      assert.equal(await readFile(join(outputDir, "draft.md"), "utf8"), "draft");

      const second = run(`touch ${q(homeMarker)} && echo HOME_OK; true`);
      assert.equal(second.status, 0, second.stderr);
      assert.doesNotMatch(second.stdout, /HOME_OK/u);
      assert.equal(existsSync(homeMarker), false);
      assert.equal(statSync(settingsPath).mode & 0o777, 0o600);
    } finally {
      rmSync(homeMarker, { force: true });
      rmSync(tmpMarker, { force: true });
      await removeSrtScratchDir(scratchDir);
      await rm(root, { recursive: true, force: true });
    }
  },
  // Two real sandbox launches (2 s cap each) stay within the repository's 5 s test-timeout cap.
  5_000,
);

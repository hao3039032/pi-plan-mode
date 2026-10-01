import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  buildSrtSettingsContents,
  buildSrtSetupGuide,
  describeSrtDiagnosis,
  diagnoseSrtRuntime,
  DEFAULT_SRT_DENY_READ,
  removeSrtProfile,
  shellQuoteSingle,
  srtProfileSettingsPath,
  wrapCommandForSrt,
  writeSrtProfile,
} from "../src/srt-sandbox.js";

const EMPTY_ENV = { PATH: "" };

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
  const wrapped = wrapCommandForSrt(command, "/usr/bin/srt", "/tmp/settings.json");
  assert.ok(wrapped);
  assert.equal(wrapped.split(" ")[0], `'/usr/bin/srt'`);
  assert.equal(wrapCommandForSrt("bad\u0000", "/usr/bin/srt", "/tmp/s.json"), undefined);
  // The wrapped line must parse back to the same arguments under sh -c.
  const parsed = execFileSync("/bin/sh", ["-c", `set -- ${wrapped}; printf '%s|%s' "$2" "$5"`]).toString();
  assert.equal(parsed, "-s|cat README.md | grep 'plan' > out.txt");
});

test("wrapCommandForSrt tolerates quoteable srt paths with spaces", () => {
  const wrapped = wrapCommandForSrt("true", "/opt/tools/srt bin/srt", "/tmp/s.json");
  assert.ok(wrapped?.startsWith(`'/opt/tools/srt bin/srt' -s`));
  assert.ok(wrapped?.endsWith(` -c 'true'`));
});

test("buildSrtSettingsContents emits the deny-by-default profile", () => {
  const contents = buildSrtSettingsContents({
    allowWrite: ["/tmp", "/repo/plans"],
    denyRead: [...DEFAULT_SRT_DENY_READ],
    allowedDomains: [],
  });
  const parsed = JSON.parse(contents) as {
    network: { allowedDomains: string[]; deniedDomains: string[] };
    filesystem: { denyRead: string[]; allowRead: string[]; allowWrite: string[]; denyWrite: string[] };
  };
  assert.deepEqual(parsed.network, { allowedDomains: [], deniedDomains: [] });
  assert.deepEqual(parsed.filesystem.allowWrite, ["/tmp", "/repo/plans"]);
  assert.deepEqual(parsed.filesystem.allowRead, []);
  assert.deepEqual(parsed.filesystem.denyWrite, []);
  assert.ok(parsed.filesystem.denyRead.includes("~/.ssh"));
  assert.ok(parsed.filesystem.denyRead.includes("**/.env"));
});

test("srt profile files round-trip through write and removal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-srt-"));
  try {
    const settingsPath = srtProfileSettingsPath(join(directory, "session"));
    await writeSrtProfile(settingsPath, {
      allowWrite: ["/tmp"],
      denyRead: [...DEFAULT_SRT_DENY_READ],
      allowedDomains: [],
    });
    const diagnosis = await diagnoseSrtRuntime({
      settingsPath,
      env: EMPTY_ENV,
      platform: "linux",
      runProbe: async () => ({ code: 0, stderr: "" }),
    });
    // srt is not on PATH in EMPTY_ENV, so the diagnosis fails before probing.
    assert.equal(diagnosis.ok, false);
    assert.deepEqual(diagnosis.missingDependencies, ["srt", "bwrap", "socat", "rg"]);
    await removeSrtProfile(settingsPath);
    await removeSrtProfile(undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
  const guide = buildSrtSetupGuide(
    { ok: false, platform: "linux", missingDependencies: ["srt", "bwrap", "socat", "rg"] },
    { linuxPackageManager: "apt" },
  );
  assert.match(guide, /npm install -g @anthropic-ai\/sandbox-runtime/);
  assert.match(guide, /sudo apt-get install -y bubblewrap/);
  assert.match(guide, /sudo apt-get install -y socat/);
  assert.match(guide, /apparmor_restrict_unprivileged_userns/);
  assert.match(guide, /approval/);
  assert.match(guide, /\/plan start/);

  const macGuide = buildSrtSetupGuide({ ok: false, platform: "darwin", missingDependencies: ["rg"] });
  assert.match(macGuide, /brew install ripgrep/);

  const probeGuide = buildSrtSetupGuide({
    ok: false,
    platform: "linux",
    srtCommand: "/usr/bin/srt",
    missingDependencies: [],
    probeFailure: { stderr: "sandbox init failed" },
  });
  assert.match(probeGuide, /sandbox init failed/);
});

test("describeSrtDiagnosis summarizes health and failures", () => {
  assert.match(
    describeSrtDiagnosis({ ok: true, platform: "linux", srtCommand: "/usr/bin/srt", missingDependencies: [] }),
    /OK/,
  );
  assert.match(describeSrtDiagnosis({ ok: false, platform: "linux", missingDependencies: ["srt"] }), /missing: srt/);
});

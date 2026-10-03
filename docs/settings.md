# Pi Plan Mode settings reference

[Back to README](../README.md)

- [Default Plan policy tools](#default-plan-policy-tools)
- [Enable inactive built-in search tools in Pi](#enable-inactive-built-in-search-tools)
- [Delegation admission](#delegation-admission)
- [Plan reinjection](#plan-reinjection)
- [Fresh implementation runtime](#fresh-implementation-runtime)
- [Export destination](#export-destination)
- [Plan output directory](#plan-output-directory)
- [Sandbox profile](#sandbox-profile)
- [Toggle shortcut](#toggle-shortcut)
- [Thinking level and persistence](#thinking-level)

## ⚙️ Settings

Run `/plan settings` or open **Settings** from an inactive `/plan` menu to edit **Plan thinking**, **Plan policy tools**, **Delegation agents**, **Delegation scripts**, **Plan reinjection**, **Fresh model**, **Fresh thinking**, **Export destination**, **Plan output dir**, **Sandbox write paths**, **Sandbox deny-read**, **Sandbox network**, and **Plan mode shortcut**.
You can also edit `$PI_CODING_AGENT_DIR/pi-plan-mode.json` (normally `~/.pi/agent/pi-plan-mode.json`) manually.
The optional file is read at session start, watched for changes, and created only by an explicit Settings save or manual edit.
The shortcut is disabled when `toggleShortcut` is omitted.
```json
{
  "thinkingLevel": "inherit",
  "defaultPlanTools": ["read", "bash", "grep", "find", "ls"],
  "implementationPlanRetention": "clear-on-start",
  "defaultImplementationModel": {
    "provider": "anthropic",
    "modelId": "claude-sonnet-4-5"
  },
  "defaultImplementationThinkingLevel": "high",
  "defaultPlanExportPath": "PLAN.md",
  "planOutputDir": "plans",
  "planAdmittedAgents": ["researcher"],
  "planAdmitWorkflowScripts": false,
  "planSandbox": {
    "allowWrite": ["/absolute/extra-cache"],
    "denyRead": ["~/.secrets"],
    "allowedDomains": []
  },
  "toggleShortcut": "<your_key>"
}
```

### Plan helper tools

Plan helper schemas are stable from extension registration onward, and Plan mode does not call `setActiveTools()`.
Tool visibility alone is not Plan activation.
Only the latest effective active Plan contract authorizes `plan_mode_question` or `plan_mode_complete`; ordinary planning and the `writing-plans` skill use their own workflow instead.
The retired `toolVisibility` key is ignored and preserved as unknown data when another setting is saved or a legacy settings file is migrated.

### Default Plan policy tools

`defaultPlanTools` defines the initial runtime allowlist when a session has no stored pre-start selection.
Omit it—or choose **Use automatic safe built-ins**—to allow already-active safe built-ins by default.
An explicit empty array appears as **No optional tools** and denies every ordinary tool while the required helpers remain callable in Plan mode.
Neither setting changes model-visible tool schemas.

Tool names must be non-empty strings; duplicates are removed in first-seen order.
Explicit configured or session-selected names remain policy intent when their tool is unknown or inactive, but Plan mode never registers or activates them.
The inactive menu takes a fresh registered and active tool snapshot each time it opens, while an already open picker does not update in place.
At the workflow's first provider-bound context, after every `before_agent_start` handler has settled, Plan mode resolves retained names against Pi's live registered and active tools and freezes the executable allowlist.
Automatic defaults recheck the effective source metadata at that boundary, so a custom override of a safe built-in name still requires explicit opt-in.
The resolved allowlist persists with the active workflow and restores without reopening the resolution boundary after reload, resume, or tree navigation.
Unknown, inactive, and Plan-mode-blocked names remain unavailable after that resolution, and a later registration or activation waits for the next Plan workflow rather than a new session.
Settings shows unresolved names as pending registration; resetting to automatic removes the entire override.
Non-built-in names in this global setting are an explicit user-risk opt-in, just like selecting them in the pre-start workflow selector.
Plan mode does not interpret a selected custom tool's arguments or actions: allowing one trusts the whole effective tool.
Native MCP tools and tools from Pi's built-in extensions follow the same rule as ordinary extension tools: they are auto-admitted when their `readOnlyHint` annotation marks them non-mutating, and every other one requires an explicit selection like this.
Pi resolves tools by name, so if an extension overrides a built-in name, the effective extension tool is selected instead.
An effective active tool named `bash` runs inside the srt OS sandbox regardless of its source metadata; `powershell` is blocked during Plan mode in v1.

A selection accepted through **Choose tools, then start…** or `/plan tools` is stored in that Pi session and takes precedence over `defaultPlanTools` when the session resumes.
The global setting remains the policy baseline for fresh sessions and sessions without an explicit selection.
Settings saves immediately, but saved policy names and thinking apply only when a later Plan workflow starts; they never mutate active schemas or a workflow already in progress.

### Enable inactive built-in search tools

On Pi with `defaultTools` support, `grep`, `find`, and `ls` are not active until Pi's settings include them.
Use a full list that preserves Pi's existing/default tools, then restart Pi:

```json
{
  "defaultTools": ["read", "bash", "edit", "write", "grep", "find", "ls"]
}
```

On Pi 0.99 or newer only, the modifier form appends to the defaults instead of replacing them:

```json
{
  "defaultTools": ["+grep", "+find", "+ls"]
}
```

Do not use the modifier form on older releases.
Registered codemode or deferred tools do not need activation to be selectable: Plan mode can select them up front, and they run through other tools' nested calls.

### Delegation admission

`planAdmittedAgents` (optional string list) names subagents that Plan-mode `subagent` calls may run without per-agent verification — the parameter whitelist still applies to the call itself.
Omit it or submit an empty value in Settings to rely on the built-in `plan-scout` plus verified read-only admission only.
The built-in `plan-scout` never needs an entry: the extension registers it at session start (read-only tools `read`/`grep`/`find`/`ls`) unless a configured agent already uses the name, in which case `/plan doctor` reports the collision and the name stays reserved.

`planAdmitWorkflowScripts` (default `false`) admits `workflow: true` script delegation during Plan mode.
Scripts can spawn arbitrary agents and carry host-side `gate`/`output` effects that no static check can bound, so enabling this setting is a full trust decision.

Verified read-only admission runs automatically for agents outside the list: the pi-subagents preflight contract must show an explicit, entirely read-only tool allowlist (the read-only universe is `read`/`grep`/`find`/`ls`, the coordination tools `contact_supervisor`/`intercom`/`structured_output`, and parent tools annotated `readOnlyHint` without `destructiveHint`), no child extensions, and a definition file without `runner`, `machine`, `defaultAcceptance`/`acceptance`, `extensions`/`subagentOnlyExtensions`, or an absolute/`..` `output`.
When pi-subagents or its preflight export is missing, verification degrades to `plan-scout` + `planAdmittedAgents` only (`/plan doctor` shows the mode).

### Plan reinjection

The stable JSON field `implementationPlanRetention` controls whether and how long the `context` hook restores the exact approved plan when ordinary model context no longer contains it.
Omit it or use `clear-on-start` for **Off — conversation history only**, the default Codex-like behavior with no active-plan state or hidden context injection.
In the planning session, this policy sends `Implement the plan.` and relies on the accepted plan already present in ordinary conversation history.
A fresh session or saved-plan implementation instead places the complete plan in one ordinary kickoff prompt because its planning history is unavailable or intentionally excluded.
Use `clear-after-first-run` for **Through first implementation run** to guarantee the exact plan until that implementation's first fully settled run ends.
Use `keep` for **Until manually cleared** to guarantee and reinject the exact plan until `/plan exit` or supersession.
A resumed guaranteed-plan cleanup policy re-arms against the first context in the replacement session.
Failed handoff delivery restores the ready or saved plan and does not run automatic cleanup.

Changing this setting applies to the next Implement action only.
Each guaranteed-plan implementation stores its effective policy, so a later Settings save cannot shorten or extend an implementation already in progress.
Conversation-history-only implementation has no active Plan-mode state to show, export, or clear after kickoff.

### Fresh implementation runtime

Omit `defaultImplementationModel` and `defaultImplementationThinkingLevel` to use **same as plan**, the default.
A configured model is an object with non-empty `provider` and `modelId` strings of at most 512 characters each.
`defaultImplementationThinkingLevel` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; use omission rather than `inherit` for **same as plan**.
Choosing **Same as plan** in Settings removes the corresponding field.

The model picker snapshots the current session's scoped models when a non-empty scope exists, otherwise Pi's currently available models.
A configured model outside that catalogue remains stored but is ineffective for that handoff: Settings and the ready-plan fresh screen report that it is unavailable and fall back to the planning session model.
The preference becomes effective again if the model returns to the applicable catalogue.
This fallback also protects a persistent default that disappears while the ready-plan fresh screen is open.
Authentication and one-shot model races still use the normal fresh-handoff preflight and recovery behavior.

These persistent values seed each ready-plan **Start fresh and implement** screen, where either choice can be overridden once without changing Settings.
The saved-plan direct fresh action applies the persistent values without an extra picker and warns when its configured model falls back.
Changes save immediately and apply to later fresh implementation actions; an already open fresh-action screen keeps its own menu-local draft.
They never switch the planning session's current model or thinking level.

### Export destination

`defaultPlanExportPath` controls only exports that omit a path.
Omit it—or submit an empty value in Settings—to use `PLAN.md`.
The value must be a non-empty string of at most 4,096 characters without terminal control characters or NUL.
Relative values are resolved against the current working directory at export time; the Settings detail and every export input preview the concrete resolved destination.
An explicit `/plan export <path>` is a one-off override and does not edit Settings.
Saving a new destination affects the next export immediately, including export of a currently active implementation.

The existing no-overwrite, cancellation, and atomic Plan-state behavior is unchanged.
A failed save rolls the row back to its previous value; a failed or cancelled export preserves the plan and target.
Long previews wrap or truncate to the available terminal width without changing the raw path used by the action.

### Toggle shortcut

`toggleShortcut` configures the Plan-mode toggle in TUI mode; it is disabled by default.
Set it to a Pi key identifier, or omit it to disable the shortcut on the next load.
Enabling, changing, or removing the shortcut requires `/reload` or restarting Pi, whether saved through Settings or edited in JSON.
The current binding stays unchanged until then; Settings shows the configured value separately from the value loaded at startup.
Pi snapshots shortcut registrations when binding the editor, so Plan mode registers once per extension runtime rather than attempting live rebinding.
Other settings retain their existing watched reload behavior, and `/plan` commands are unchanged.

Avoid conflicts with Pi or other extension shortcuts; the startup value is a registration preference, not a guarantee that Pi accepts it or the terminal sends that key combination.
Tree navigation and compaction do not apply pending shortcut changes.

### Plan output directory

`planOutputDir` controls where accepted plans are persisted as Markdown and which directory stays writable inside the sandbox.
Omit it—or submit an empty value in Settings—to use `plans` under Pi's current working directory.
The value must be a non-empty string of at most 4,096 characters without terminal control characters or NUL; relative values resolve against the working directory when a Plan workflow starts.
Accepted `plan_mode_complete` plans are written as `plans/YYYY-MM-DD-<slug>.md` (slug from the first Markdown heading), revisions overwrite the same file, and collisions append `-2`, `-3`, …
Plan start (and a restored workflow's sandbox re-probe) creates the directory if it is missing, so sandboxed commands can write into it from the first call; `/plan doctor` only reports whether it exists.
A relative (or default) value must stay inside the working directory: Plan start fails closed (without a setup guide) when the directory or any path component below the working directory is a symlink, when it resolves outside the real working directory, or when it cannot be created. An absolute value is trusted as configured. No value may be, contain, or sit inside the pi agent directory (sessions, settings, srt profiles) or contain a pi-plan-mode settings file.
Plan start freezes the resolved real directory (and the `planSandbox` extras) for the whole workflow: settings changes apply to the next workflow only. A resumed workflow reuses its frozen directory only while it is still a real directory inside the working directory or equal to the configured absolute directory, and reuses its frozen extras only when they are no wider than the current settings; otherwise it falls back to the current settings or leaves Plan mode with the reason.
Plan documents are written through a temp file and renamed into place, so a symlink or hard link planted at a document path is replaced, never followed; such a path is abandoned for a freshly allocated filename.
The agent may draft or iterate Markdown there while planning, from the shell or with the built-in `write`/`edit` tools (which Plan mode admits only for targets resolving inside this directory). A successful `write`/`edit` of a Markdown file there annotates its result with `📄 Plan draft updated → <path>`; after a Plan-mode `bash` call, the newest Markdown file modified since the call started at the top level of the directory (subdirectories are not scanned) is reported the same way, and `/plan show` renders the newest top-level draft.
The `plan_mode_complete` result echoes the plan with a `📄 <path>` footer, and the ready-plan menu lists the same document path.

### Sandbox profile

`planSandbox` tunes the srt OS sandbox that every Plan-mode `bash` call runs in.
All three keys are optional string arrays; entries must be non-empty and are deduplicated in first-seen order.

- `allowWrite` adds extra writable absolute paths. The resolved plan output directory and a private per-workflow scratch directory (`<os tmpdir>/pi-plan-mode-scratch-<uuid>`, mode 0700, exported to commands as `TMPDIR` and removed when the workflow ends) are always writable and cannot be removed; `/tmp` itself is read-only. The pi agent directory (including the srt profile directory `<agent dir>/srt` and session files) and the pi-plan-mode settings files are always in the profile's `denyWrite`, which srt applies with precedence over `allowWrite`, so no `allowWrite` entry can let a sandboxed command rewrite its own profile or settings.
- `denyRead` adds extra read-denied paths on top of the built-in secret defaults (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gcloud`, `~/.netrc`, `**/.env`, `**/.env.*`).
- `allowedDomains` allows network access from the sandbox (wildcards like `*.npmjs.org`); the default empty list denies every domain.

Paths follow srt syntax (`~` expands to the home directory, gitignore-style globs on macOS).
Treat `allowWrite` and `allowedDomains` as real security decisions: they widen what arbitrary sandboxed commands may write and which hosts they may reach.
Set `PI_PLAN_MODE_SRT_PATH` to use an srt binary outside `PATH`; run `/plan doctor` to check the effective profile and runtime health.
A non-object `planSandbox`, unknown keys, or non-string-array values invalidate the entire settings file and trigger the normal warning/default fallback on session start.

### Thinking level

Plan mode inherits Pi's current thinking level by default.
Set `thinkingLevel` to request a fixed level only while Plan mode is active.
Supported values are `inherit`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
The extension snapshots the prior level and restores it on exit only if the level still matches the value it applied; a manual change made during Plan mode is preserved.
A Settings save does not change Pi's current or default thinking level and takes effect only when the next Plan workflow starts.

Settings saves are serialized in invocation order inside one Pi process.
Each save re-reads the latest valid document, preserves unknown top-level fields and unedited `planSandbox` lists, then publishes through a same-directory temporary file and rename.
A missing file stays absent until an explicit save.
Invalid JSON, invalid values, oversized content, non-regular files, and read failures make Settings read-only; the existing bytes and previous effective settings remain.
This in-process queue is not a cross-process lock, so concurrent separate Pi processes can still race.

Invalid settings produce a warning and fall back to inherited Plan thinking, available safe-built-in tool defaults, `clear-on-start`, same-as-plan fresh runtime choices, and `PLAN.md`.
Compatibility: a valid legacy `plan-mode.json` remains readable with a warning and is never modified automatically.
If Settings is explicitly saved while only that legacy file exists, the extension creates canonical `pi-plan-mode.json` from the complete legacy document, applies the selected change, preserves unknown fields, and leaves the legacy file untouched.
If both files exist, the canonical filename takes precedence.

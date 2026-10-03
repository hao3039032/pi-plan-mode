# @hao3039032/pi-plan-vanguard

## 0.62.0 (fork)

### Minor Changes

- Renamed the package to `@hao3039032/pi-plan-vanguard`: this extension now evolves independently of upstream `@narumitw/pi-plan-mode`, which remains credited for the original design (see the README provenance note). The `/plan` commands, helper tool names, and the `plan-scout` agent name are unchanged.
- Settings migrate to `<agent dir>/pi-plan-vanguard.json`. The former filenames `pi-plan-mode.json` and `plan-mode.json` remain readable legacy files (newest wins), are never modified, and the first explicit Settings save writes the new canonical file from the complete legacy document — including unknown fields. All settings filenames, current and legacy, stay write-denied inside the srt sandbox and protected from Plan-mode writes. Internal srt profile/scratch file patterns keep their previous names so cleanup of files from older versions still works.

## 0.61.0 (fork)

### Minor Changes

- Ship `plan-scout`, a read-only reconnaissance subagent registered through pi-subagents at session start (tools `read`/`grep`/`find`/`ls`, replace-mode system prompt with a file:line evidence discipline, thinking `low`, no default output path). A preflight resolve of the name blocks registration when a configured agent already uses it — pi-subagents throws on every agent discovery otherwise — and `/plan doctor` reports the collision instead.
- Auto-admit read-only `subagent` calls per call during Plan mode (never persisted into the workflow allowlist): `action: "capabilities"` listings, single-child `{agent, task}` calls, static `tasks` batches, and `chain` steps (`{agent, task, as?}` or `{parallel}`), under a strict parameter whitelist. Host-side parameters — `gate`, `acceptance` (other than `false`), `share`, `worktree`, `isolation`, `sessionDir`, `machine`, `cwd`, `fast`, `outputSchema`, `outputMode`, `agentContract`, `extensionBindings`, and any output path — deny the exemption because they execute in the Pi host process, not in the read-only child.
- Every referenced agent must pass one of three admission paths: the registered `plan-scout`, the new `planAdmittedAgents` setting (trusted names; the parameter whitelist still applies), or verified read-only admission through the pi-subagents preflight contract — an explicit, entirely read-only tool allowlist (readers, `contact_supervisor`/`intercom`/`structured_output`, and parent tools annotated `readOnlyHint` without `destructiveHint`), no configured child extensions or tool extension paths, and a definition file free of `runner`/`machine`/`defaultAcceptance`/`acceptance`/`extensions`/`subagentOnlyExtensions` directives and absolute/`..` `output` paths.
- `workflow: true` script delegation is admitted only with the new `planAdmitWorkflowScripts` setting (default off): a script can spawn arbitrary agents and carry host-side `runs.run` options, so admission is a full trust decision.
- The Plan mode contract adds a Phase 1 delegation line while plan-scout is registered; `/plan doctor` reports the scout status, the verification mode (verified via preflight vs degraded to plan-scout + planAdmittedAgents), and the script admission state.
- Declare the optional `pi-subagents` peer dependency; without it, delegation admission degrades gracefully and everything else keeps working.

## 0.60.0 (fork)

### Minor Changes

- Understand Pi 1.0 tool exposure: native MCP and built-in extension tools (source `builtin:mcp` and friends) now take the annotation path instead of being blocked as unknown built-ins, so a declared `readOnlyHint` auto-admits them and everything else becomes explicit opt-in; tools without policy metadata (`sourceInfo.source`) fail closed as blocked.
- Route tool-call checks by call origin: nested calls (with `parentToolCallId`) follow nested semantics, so registered codemode/deferred tools run through other tools without activation while model-only tools can never be called by other tools; direct and model-only tools still require activation. Codemode/deferred tools can also be selected up front (`filterAvailableSelectedToolNames`) and stay in the frozen policy, so nested calls admit them mid-workflow.
- Unify tool presentation across the launch menu and Settings with `planModeToolSelection` (labels like `X — inactive in Pi` / `X — blocked by Plan policy`, exposure notes "callable via other tools" / "model calls only"), sanitize untrusted MCP/extension names and descriptions in both menus with the kit's `sanitizeTerminalText` (bidi/OSC-aware), and give inactive `grep`/`find`/`ls` actionable guidance (`defaultTools` full-list instructions without paths or modifier examples).
- Update the Plan mode-contract wording for exposure semantics ("extension/MCP tools", nested-call checking); existing sessions keep resolving through the `details.mode`/marker fallback.
- Docs: new "Enable inactive built-in search tools" section with `defaultTools` JSON examples (full list and Pi 0.99+ `+grep`-style modifiers), MCP opt-in notes, and exposure notes in the tools workflows.

## 0.59.2 (fork)

### Patch Changes

- Remove the `update_plan` session-tracker carve-out: pi has no such built-in tool, so it is classified as an unknown built-in and stays blocked like any other unrecognized built-in name. The plan contract no longer mentions it.

## 0.59.1 (fork)

### Minor Changes

- Admit every harmless tool automatically during Plan mode: sandboxed `bash`, built-in readers, and extension/MCP tools whose `readOnlyHint` annotation marks them non-mutating (`update_plan` does not exist in pi and stays classified as an unknown blocked built-in). Explicit selection is now only required for tools that can mutate or reach unknown systems. Harmless tools are also admitted on first use when activated mid-workflow, with or without an explicit selection list. The bash/wrap, write/edit (plans-dir-only) and PowerShell blocks are unchanged.

## 0.59.0 (fork)

### Patch Changes

- Fix a sandbox escape: srt profiles were stored in the OS temp dir while `/tmp` was sandbox-writable, so a sandboxed command could rewrite its own profile (srt re-reads it on every call) and widen later calls. Profiles now live in `<agent dir>/srt` (0700 directory, 0600 files), the profile directory and pi-plan-mode settings files are always in the profile's `denyWrite` (which wins over any `allowWrite`), and the blanket `/tmp` write grant is replaced by a private per-workflow scratch directory handed to commands as `TMPDIR` (via srt's `CLAUDE_CODE_TMPDIR`) and removed when the workflow ends. Writes are allowed only in the plan output directory plus that scratch `TMPDIR`.
- The sandbox setup guide detects the Linux package manager on `PATH` (pacman, apt-get, dnf, zypper) and emits matching install commands (e.g. `sudo pacman -S --needed bubblewrap socat ripgrep` on Arch); without a detected manager it lists the package names generically.
- Allow the built-in `write`/`edit` tools during Plan mode for active tools whose target resolves (after `..` normalization and symlink resolution) inside the plan output directory; every other target, extension overrides of those names, and `update_plan` stay blocked.
- Plan start (and a restored workflow's re-probe) creates a missing plan output directory so sandboxed commands can write drafts from the first call.
- The `plan_mode_complete` result ends with a `📄 <path>` footer for the persisted document (the stored plan is unchanged), and the ready-plan menu lists the document path.
- Fix plan-document and output-directory escapes: plan documents are written through a temp file renamed into the verified output directory (planted symlinks and hard links are replaced, never followed, and abandoned for a fresh filename); a relative `planOutputDir` that is or passes through a symlink, or resolves outside the working directory, makes Plan start fail closed; the resolved real directory and `planSandbox` extras are frozen per workflow (settings changes apply to the next workflow, and restored session data never widens the sandbox); the whole pi agent directory is write-denied in the profile and refused for `write`/`edit`.
- Harden sandbox lifecycle: restored-workflow re-probes never reject unhandled and, when the sandbox is lost during a run, leave Plan mode after the run settles; concurrent Plan starts are refused while one is probing; stale probes and dropped sandboxes remove their files; only profile/scratch paths this extension creates are ever deleted.
- Plan draft annotations no longer depend on the command text: a successful admitted `write`/`edit` of a Markdown file reports its target, and after every Plan-mode `bash` call the newest top-level Markdown file modified in the plan output directory since the call started is reported, as `📄 Plan draft updated → <path>`. The legacy `<proposed_plan>` echo also ends with the `📄 <path>` footer.

### Minor Changes

- Replace the reviewed bash/PowerShell command allowlists with the **Anthropic Sandbox Runtime (srt)**: every Plan-mode `bash` call is wrapped as `srt -s <profile> -c '<command>'` and runs inside an OS-level sandbox (Seatbelt/bubblewrap/srt-win) with writes limited to the plan output directory and a private scratch `TMPDIR`, secret-path read denials, and a deny-by-default network allowlist. There is no allowlist fallback: when the sandbox is unavailable, `/plan start` fails closed and injects an agent setup guide with exact install commands; `/plan <prompt>` stashes the prompt for the recovered start. Resumed workflows re-probe and leave Plan mode when the sandbox is gone.
- Persist completed plans as Markdown under a plan output directory (default `plans/`, `planOutputDir` setting): accepted plans are written as `plans/YYYY-MM-DD-<slug>.md`, revisions overwrite the same file, and the TUI renders the finished plan with a path footer. The agent may draft in the sandbox-writable directory; draft updates echo on the bash tool result, and `/plan show` renders the newest draft when no finished plan exists.
- Add `/plan doctor` for a human-readable sandbox and profile diagnosis, `planSandbox` settings (`allowWrite`, `denyRead`, `allowedDomains`), and the `PI_PLAN_MODE_SRT_PATH` override. Block `powershell` during Plan mode (v1 sandboxes `bash` only). Statusline shows `plan active (srt)`.

### Breaking Changes

- Remove the reviewed bash/PowerShell allowlists and the `safeSubcommands` setting; srt becomes a hard Plan-mode dependency (`npm i -g @anthropic-ai/sandbox-runtime` plus bubblewrap/socat/ripgrep on Linux, ripgrep on macOS).

## 0.58.3

### Patch Changes

- 26e8801: Make Plan-mode shortcut changes explicitly take effect after `/reload` or restarting Pi. Keep startup shortcut registrations stable, remove ineffective live rebinding, and show the configured and startup-loaded values with reload guidance in Settings. Other settings retain their existing reload behavior.
- Updated dependencies [e6db042]
  - @narumitw/pi-tui-kit@0.65.1

## 0.58.2

### Patch Changes

- 8abd5b7: Keep generated extension runtime graphs inside Pi's Jiti-loaded TypeScript path to avoid duplicate peer-runtime evaluation during startup. Add measured generated runtimes for Context Management, Herdr, and TypeSafe Search.

## 0.58.1

### Patch Changes

- 67a3049: Adapt provider, transcript, usage, deferred-tool, and telemetry behavior to Pi's current runtime contracts, including accurate cache-warming accounting and exclusion from ordinary generation traces.

## 0.58.0

### Minor Changes

- b745330: Add persistent fresh implementation model and thinking defaults with a same-as-plan fallback.
- 0ef037d: Add one-shot model and thinking selection before fresh ready-plan implementation.

### Patch Changes

- 7c9a062: Defer automatic ready-plan fresh session handoffs until lifecycle dispatch and prompt cleanup finish.
- Updated dependencies [4485b49]
- Updated dependencies [6b1e009]
  - @narumitw/pi-tui-kit@0.62.0

## 0.57.1

### Patch Changes

- 31b3dde: Remove the implementation model and thinking selectors, restoring Plan implementation handoffs to the current model and normal thinking behavior.

## 0.57.0

### Minor Changes

- e2af16b: Add optional implementation model and thinking defaults plus per-menu implementation options for same-session and fresh-session handoffs. Apply choices only at implementation start without changing Pi defaults or automatically restoring the planner's model after a run ends.

### Patch Changes

- Updated dependencies [317f7bd]
  - @narumitw/pi-tui-kit@0.61.0

## 0.56.0

### Minor Changes

- e230348: Allow narrowly validated local `hostname`, `tasklist`, `Get-Process`, and `Get-Service` inspections in Plan mode by default.
- 708cc2e: Let users add arbitrary `safeSubcommands` entries and treat every configured command-subcommand prefix as fully trusted for Plan-mode Bash and PowerShell calls.

## 0.55.3

### Patch Changes

- 14068d2: Allow reviewed Git inspections to use current-working-directory `git -C <path>` forms, and report actionable reasons when Plan mode denies an unavailable, inactive, frozen, blocked, or unselected tool.

## 0.55.2

### Patch Changes

- Updated dependencies [40182e5]
  - @narumitw/pi-tui-kit@0.59.0

## 0.55.1

### Patch Changes

- b99b3db: Resolve explicitly selected tools registered before the first Plan request without mutating Pi's active tool schemas.

## 0.55.0

### Minor Changes

- b59cdbc: Remove the `toolVisibility` setting and keep Plan helper schemas stable from startup.
  Retired settings keys are ignored and preserved, while globally visible helper metadata now distinguishes `/plan` from ordinary planning workflows.

## 0.54.0

### Minor Changes

- ab467e0: Allow Pi's active native PowerShell tool to run reviewed read-only file, directory, Git, and GitHub inspections in Plan mode while blocking mutation and unsupported dynamic syntax.

## 0.53.1

### Patch Changes

- 02878f5: Add an editor-style divider above the Plan mode widget.
- 3346683: Publish generated lazy chunks at the JavaScript paths referenced by each extension runtime so deferred menus and implementations load correctly through Pi's Jiti loader.
- Updated dependencies [b9eba3a]
  - @narumitw/pi-tui-kit@0.58.0

## 0.53.0

### Minor Changes

- c194597: Make conversation-history-only implementation the default, use Codex-style kickoff prompts without active-plan injection, and clarify Plan reinjection controls.
- e74ee84: Add configurable Plan helper visibility and default to revealing the helper tools on the first successful Plan activation.
- 67eb77b: Remove the `--plan` startup flag. Start Plan mode after launch with `/plan start` or begin with a prompt through `/plan <prompt>`.
- da265a0: Keep Plan and Normal requests on one append-only conversation with stable tool schemas, versioned mode contracts, and a runtime Plan tool allowlist that no longer activates inactive tools.

### Patch Changes

- df584db: Keep unused resumed sessions free of mode contracts and reject `/tree` navigation to internal transition markers.
- 5be9aa2: Prevent active agent runs from mixing Plan and Normal tool contracts, and retry explicit structured finalization once after settlement when the model responds with prose only.

## 0.52.0

### Minor Changes

- 85d13c8: Coordinate Plan-mode activation through Workflow Mutex Protocol v1 so cooperating agent workflows cannot start in the same Pi session.

## 0.51.1

### Patch Changes

- 8540d0f: Simplify single-question TUI questionnaires with a plain header and immediate answer submission while retaining tabbed Review for multiple questions.
- 5785cb4: Reuse Pi TUI Kit's questionnaire runner while preserving Plan mode answer and lifecycle behavior.
- Updated dependencies [8540d0f]
  - @narumitw/pi-tui-kit@0.57.1

## 0.51.0

### Minor Changes

- 416da47: Add tabbed TUI Plan questions with answer notes and final review.

## 0.50.1

### Patch Changes

- 30bc076: Load each extension from a generated TypeScript runtime to reduce Jiti package startup work while preserving existing first-use boundaries.

## 0.50.0

### Minor Changes

- 160f2fc: Add an optional `toggleShortcut` setting and a **Plan mode shortcut** Settings row so the global Plan-mode keybinding can be chosen, and keep it disabled while the setting is omitted. Reload the settings file automatically when it changes and rebind the configured shortcut immediately after a Settings save.

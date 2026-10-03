# Plan command workflows

[Back to README](../README.md#-commands)

## Read-only delegation (plan-scout)

During an active Plan workflow, `subagent` tool calls are auto-admitted per call — without entering the Plan tool allowlist — when they are provably read-only:

- **Shapes**: a single child (`{agent, task}`), a static `tasks` batch, or a `chain` whose steps are `{agent, task, as?}` or `{parallel: [...]}`; `action: "capabilities"` listings are always fine.
- **Parameter whitelist**: only `agent`, `task`, `tasks`, `chain`, `context` (`fresh`/`fork`), `model`, `thinking`, `async`, `timeoutMs`/`maxRuntimeMs`, `toolBudget`, `includeProgress`, `chatProgress`, `artifacts`, `skill`, `output: false`, and `acceptance: false`. Any host-side parameter — `gate`, `acceptance` (other than `false`), `share`, `worktree`, `isolation`, `sessionDir`, `machine`, `cwd`, `fast`, `outputSchema`, `outputMode`, `agentContract`, `extensionBindings`, and friends — denies the exemption because those execute in the Pi host process (spawn, file writes, Gist upload, git worktrees, remote machines), not in the read-only child.
- **Agents**: every referenced agent must pass one of three paths — the built-in `plan-scout` (registered at session start with the read-only tools `read`/`grep`/`find`/`ls`; a same-named configured agent disables the registration, reported by `/plan doctor`), your `planAdmittedAgents` list, or verified read-only admission: the pi-subagents preflight contract must resolve the agent with an explicit tool allowlist contained in the read-only universe (`read`/`grep`/`find`/`ls`, `contact_supervisor`/`intercom`/`structured_output`, and parent tools annotated `readOnlyHint` without `destructiveHint`), no configured child extensions or tool extension paths, and a definition file free of `runner`/`machine`/`defaultAcceptance`/`acceptance`/`extensions`/`subagentOnlyExtensions` directives and absolute/`..` `output` paths.
- **Workflow scripts**: `workflow: true` spawns arbitrary agents with host-side `runs.run` options, so static analysis cannot bound it; scripts are admitted only when you set `planAdmitWorkflowScripts` (full trust).

Admitted calls run without touching the frozen workflow allowlist; every other `subagent` call keeps the ordinary Plan policy block and appends guidance about the admitted shapes.
Child sessions run outside the srt sandbox by design: their tool allowlists are the boundary (plan-scout has no shell or file-writing tools), and a child's `read` is not bound by the parent's `planSandbox.denyRead` — consistent with the parent's in-process `read` tool.
When pi-subagents (or its preflight export) is unavailable, `/plan doctor` reports the degraded mode: only `plan-scout` and `planAdmittedAgents` calls are admitted.

## Start and choose tools

`/plan start` probes the srt sandbox first: a healthy probe activates Plan mode without sending a model message, while a failing probe refuses to start and injects an agent setup guide (install commands included) instead.
`/plan <prompt>` starts with an initial planning message — stashed automatically when the sandbox probe fails and re-sent on the next successful start — or sends an ordinary follow-up when already active.
Only the exact argument `start` selects direct activation; `/plan start a migration` is a planning prompt.
There is no startup flag; run `/plan start` after Pi launches, and `/plan doctor` for a human-readable sandbox diagnosis.

Before starting, `/plan tools` or **Choose tools, then start…** stages a session-specific tool policy.
**Done — start with this policy** stores the selection and starts Plan mode.
Back, Escape, Ctrl+C, disposal, session replacement, or shutdown discards the unconfirmed draft without changing Plan state, active tools, thinking, or stored selection.
Persistent defaults belong in [Settings](./settings.md).

The TUI selector supports fuzzy search and paging; RPC shows the unfiltered list.
Blocked, inactive, or not-yet-registered tools remain distinguishable, and selected names awaiting metadata stay selected for first-request resolution.
Reopen the selector to refresh newly registered tools.
On Pi 1.0's tool exposures, registered codemode or deferred tools can be selected without activation and run through other tools' nested calls, while direct and model-only tools must be active; every nested call is checked on its own, and selecting a tool never authorizes the tools it calls.
Active and ready workflows lock tools and settings; exit and start a new workflow to change the allowlist.
See [Planning and implementation](../README.md#-planning-and-implementation) for the first-request policy boundary, completion, and same-session versus fresh-session handoff.

## Busy transitions and recovery

Wait for Pi's run to settle before starting, exiting, saving, exporting a ready plan, implementing, or using another state-changing menu action or configured shortcut.
Busy transitions leave state unchanged and report a warning in TUI/RPC or an error in print/JSON mode.
An ordinary follow-up or `/plan finalize` can still run while Plan mode is active because neither changes its mode contract.

`show`, `save`, `export`, and `implement` require an applicable stored plan; `finalize` requires active Plan mode.
Cancellation and failed implementation preflight leave the stored plan intact.
For finalization retries, fresh-session recovery, and non-interactive limitations, see [Planning and implementation](../README.md#-planning-and-implementation).

## Export Markdown

`/plan export [path]` writes a ready, saved, or active implementation plan.
Without a path, it uses the configured **Export destination**, defaulting to `PLAN.md`; an explicit path always overrides the setting for that export.
Relative paths resolve from Pi's current working directory at export time, absolute paths stay absolute, a leading `@` is accepted, and missing parent directories are created.
Existing files, directories, and symbolic links are never overwritten: choose another path or remove the target first.
The output preserves accepted Markdown exactly apart from one trailing newline.

In TUI or RPC, **Export plan…** asks for a destination and shows the configured value and its resolved path.
Submit an empty value to use the configured destination.
A failed export retains the TUI draft for correction or reopens the RPC input; Escape returns without writing.

A successful ready-plan export ends Plan mode, restores thinking, and clears the ready state without starting a model turn or changing active tools.
Saved and active implementation exports preserve their existing state.
Failed or cancelled exports leave Plan state unchanged.
Export is an explicit user-requested file mutation, and the resulting file can be read with normal tools; model-initiated Plan-mode writes remain blocked.

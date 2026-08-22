# @narumitw/pi-plan-mode

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

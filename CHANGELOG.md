# Changelog

Notable changes, newest first. Versions follow semver; the plugin manifest
(`plugin/package.json`) and this package version independently, because the
installer and the Client plugin ship separately.

## 1.1.1

Fixes an install failure on packaged Windows desktops. Anyone installing from
this repository on Windows before this release got the window patch but **not**
the plugin.

### Fixed

- **Plugin install failed on Windows with `SyntaxError: Invalid or unexpected token`.**
  `resolveDshCli()` looked only for a `dsh.js` entry and fell back to `where dsh`,
  which on Windows returns `dsh.cmd` — a batch shim. The installer then ran it
  through `process.execPath`, so node tried to parse `@echo off` as JavaScript.
  The command now goes through `cmd /d /s /c` for a `.cmd`/`.bat` shim and
  through node for a `.js` entry. `resolveDshCli()` probes both shapes.
- **Uninstall had the same bug**, so a failed install could not be undone cleanly
  by the CLI either. Both paths now share one `runDshCli()` helper.

### Notes

- `shell: true` was deliberately avoided: Node deprecates arguments-plus-shell
  (DEP0190) because it concatenates without escaping. Going through `cmd`
  directly keeps every argument a separate, quoted element.
- Verified against a real `dsh.cmd`: the old strategy exits 1 with the
  SyntaxError, the new one exits 0 and prints the CLI version, with no
  deprecation warning.

## 1.1.0

### Added

- `tools/repair.mjs` and `dsh-glass-skin repair`: re-apply the window patch after
  a DSH update. An update replaces `app.asar` outright, so the patch disappears
  while the Client plugin survives — translucent surfaces, no desktop
  show-through, and nothing in the UI explaining why. The repair command detects
  that state with a streaming scan, refuses to write while the app holds the
  archive, and archives a stale backup as `.stale-<sha>` instead of restoring
  bytes from a different release.

## 1.0.0

- First release: native acrylic window material plus glass token overlay that
  stacks on the active theme.

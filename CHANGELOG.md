# Changelog

Notable changes, newest first. Versions follow semver.

## 1.4.0

Replaces the self-repair machinery with a launcher. The previous release tried to
re-apply the window patch automatically after a DSH update; that cannot work, and
the reason is now documented instead of worked around.

### Why the automatic repair was withdrawn

Two independent findings, both measured rather than assumed:

1. **The Host half cannot set the window material.** `BrowserWindow.setBackgroundMaterial()`
   is unreachable: the Host runs under `ELECTRON_RUN_AS_NODE`, so although
   `process.versions.electron` reports 44.7.0 there is no `BrowserWindow` in that
   process (`runtime material: no-browserwindow`). DSH exposes no window service
   either — the live catalogue has `shell` (bash) and `webServer`, nothing that
   reaches the window.
2. **A helper spawned by the app dies with the app.** Waiting for the archive to be
   released never completed: the log recorded `start` and never `archive released`,
   because quitting the app takes its children down. That is also why "quit and
   wait a few seconds" had no correct answer.

### Added

- **`tools/launch.mjs`** and the `launch` subcommand: patch if needed, then start
  the app. It runs while the app is closed by definition, so the patch lands
  before the window is created and nothing has to be timed.
- **`launch --install`** writes a *DeepSeek Harness (Glass)* Desktop shortcut that
  does exactly that. `--uninstall` removes it.
- The Host half now records the patch state to
  `%LOCALAPPDATA%\dsh-glass-skin\host.log` and names the launcher as the fix,
  instead of pretending it can repair anything itself.

### Removed

- `tools/auto-repair.mjs` and `tools/autostart.mjs`, with the `autostart`
  subcommand and the Startup-folder entry. They existed to serve the waiting
  approach that the findings above rule out; keeping them would only mislead.

### Notes

- `doctor` now reports whether the Desktop shortcut exists, and its advice points
  at the launcher.

## 1.3.0

Survives DSH updates. Before this release every update silently removed the
window patch, and the only cure was remembering to re-run the installer — the
plugin kept working, so the symptom looked like "the skin broke again" with
nothing pointing at the cause.

### Added

- **`tools/doctor.mjs`** — reports both halves separately: the window patch
  inside `app.asar` (present / missing, plus the DSH version it belongs to) and
  the Client plugin in the profile (installed / declared / listed / dsh metadata).
  They fail differently and the fix differs, so telling them apart is the whole
  point. `--json` for scripting, `--fix` to patch when the app is closed.
- **`tools/auto-repair.mjs`** — waits for `app.asar` to be released, re-applies
  the patch, verifies it, and optionally relaunches the app.
- **`tools/autostart.mjs`** — writes a hidden `.vbs` into the per-user Startup
  folder so the patch is restored at logon. `schtasks /create` with an ONLOGON
  trigger was the obvious choice and was rejected with "access denied" in a
  normal user session; the Startup folder needs no elevation.
- **The Host half now checks the archive on mount** and arms the repair when the
  patch is gone. This is what makes "reload the plugin" enough: no command to
  remember.

### Notes

- The lock probe is a rename of the archive onto itself. Windows requires DELETE
  access on the source for that, so a holder that did not grant
  `FILE_SHARE_DELETE` makes it fail with `EBUSY` — and nothing is written.
  Measured with DSH running: `open r+` succeeds (useless as a probe),
  `rename to itself` fails `EBUSY` (reliable). Without a cheap probe the helper
  would rewrite a 180 MB archive on every retry.
- The repair must run **outside the app's process tree**: a helper spawned by the
  app is a child of it, so quitting the app takes the helper with it. The Startup
  entry is launched by Windows at logon and is therefore the reliable executor;
  the in-app attempt is a best-effort shortcut.
- `DSH_GLASS_NO_AUTO=1` disables the in-app check; `DSH_GLASS_DEBUG=1` logs it.

## 1.2.0

Makes the repository root a real DSH bundle, so `github:InkStain258/dsh-glass-skin`
installs a mountable plugin instead of an installer-only wrapper.

### Added

- `main` and `exports` on the root package, pointing at `plugin/index.js`. The
  Loader resolves the patch row named `dsh-glass-skin` to the package entry, so a
  package without `main` mounts nothing.
- `dsh.bundle.patch` and `dsh.client` on the root package. Previously only
  `plugin/package.json` declared them, which meant a plain `github:` spec —
  resolving to the repository root — produced "listed in the bundle layer but
  declares no dsh metadata" and failed to load at startup.

### Changed

- `plugin/package.json` is no longer shipped in the npm package. The root
  manifest is now the only one, matching how every other DSH bundle is laid out
  (none of them ships a nested manifest). The file stays in the repository for
  anyone installing the subpackage directly.

### Notes

- The root package is now two things at once: the `npx` installer (`bin`) and the
  bundle itself. That is the cost of supporting a bare `github:` spec. The
  alternative was requiring consumers to target `/tree/main/plugin`, which pnpm
  does not support consistently across versions.

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

- First release: native acrylic window material plus a glass token overlay that
  stacks on the active theme.

# Changelog

Notable changes, newest first. Versions follow semver.

## 1.4.2

Fixes the window staying opaque on DSH 0.2.2 even though the patch was applied.

### Fixed

- **The injected options were overwritten by the win32 primary branch.** Since
  DSH 0.2.2, `createWindow` spreads `backgroundColor: chromeFallbackFill()` (an
  opaque `#1b1b1c` / `#f9fafb`) for the main window on Windows. The options used
  to be inserted right after `show,`, which sits *before* that spread — so
  `backgroundMaterial:"acrylic"` was set and then had its transparent background
  painted over. The source looked correct and `doctor` reported the patch as
  applied, but the window rendered opaque.

  The insertion point now follows the whole win32 branch, so our
  `backgroundColor` is the last one in the object literal.

- **The anchor had to become the whole win32 branch.** The trailing `} : {},`
  appears four times in `lib/main.js`; matching it alone put the insertion
  150 KB early, inside an unrelated object literal. The anchor is now the
  complete win32 branch (275 bytes, one occurrence).

### Notes

- `markerOffset` in the self-check is now derived from the anchor plus the
  inserted options rather than from a hand-counted constant; the previous
  arithmetic was off by the terminator length and made the fifth self-check fail
  on a correct patch.

### Verified

On a byte-exact copy of the real 209 MB archive: all five self-checks pass,
exactly one entry differs (`lib/main.js`), `node --check` exits 0, size is
unchanged, and the injected `backgroundColor:"#00000000"` now sits *after* the
`chromeFallbackFill()` assignment (offset 790088 vs 789835).

## 1.4.1

Fixes the launcher silently failing on DSH 0.2.2 and later.

### Fixed

- **`dataStart` was computed as `16 + jsonLength`.** DSH 0.2.2-rc.3 ships a 209 MB archive whose header string is padded to a 4-byte boundary (7 padding bytes), so that formula landed 3 bytes early. Every entry read — and every write — was misaligned, which made the patcher's own `node --check` gate fail, so the patch was refused and the launcher exited without starting the app. The correct formula is `8 + pickleSize`; it equals the old one when there is no padding, so both layouts work. Fixed in `tools/dsh-glass-desktop.mjs`, `tools/launch.mjs` and `plugin/index.js` — the latter two only *read* the archive, and were mis-reporting the patch as missing.
- **Launcher failures were invisible.** The Desktop shortcut runs it with a hidden window, so any non-zero exit looked like "nothing happened". It now writes `%LOCALAPPDATA%\dsh-glass-skin\launch.log` and, when there is no console, shows a native message box with the last lines of the transcript.
- The process probe in `findAsar()` now carries an 8 s timeout; an unbounded PowerShell call could stall the launcher.

### Verified

Against a byte-exact copy of the real 209 MB archive: the patcher's five self-checks all pass, an independent re-read shows exactly one entry differs (`lib/main.js`), the acrylic marker appears exactly once, `node --check` on the patched entry exits 0, and the archive size is unchanged. Runtime confirmation (the window actually blurring) still requires relaunching the app.

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

# Changelog

Notable changes, newest first. Versions follow semver.

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

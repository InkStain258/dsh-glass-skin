#!/usr/bin/env node
/**
 * dsh-glass-skin installer.
 *
 * One entry point for the two halves of the effect:
 *   1. the Client plugin  — translucent surfaces + the blur layer
 *   2. the window patch   — native Windows acrylic behind the window
 *
 * It is deliberately dependency-free (Node built-ins only) so `npx` and a plain
 * `node ./scripts/install.mjs` behave identically.
 *
 * @module dsh-glass-skin/install
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const PLUGIN_DIR = path.join(REPO, 'plugin')
const PATCHER = path.join(REPO, 'tools', 'dsh-glass-desktop.mjs')

/* ------------------------------------------------------------------ */
/* tiny console                                                       */
/* ------------------------------------------------------------------ */

const color = process.stdout.isTTY && process.env.NO_COLOR === undefined
const c = {
  dim: (s) => (color ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s) => (color ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s) => (color ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s) => (color ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s) => (color ? `\x1b[31m${s}\x1b[0m` : s),
  cyan: (s) => (color ? `\x1b[36m${s}\x1b[0m` : s),
}
const say = (s = '') => process.stdout.write(`${s}\n`)
const ok = (s) => say(`${c.green('  +')} ${s}`)
const info = (s) => say(`${c.dim('    ')}${c.dim(s)}`)
const warn = (s) => say(`${c.yellow('  !')} ${s}`)
const fail = (s) => say(`${c.red('  x')} ${s}`)
const head = (s) => say(`\n${c.bold(c.cyan(`== ${s}`))}`)

/* ------------------------------------------------------------------ */
/* arguments                                                          */
/* ------------------------------------------------------------------ */

const USAGE = `
${c.bold('dsh-glass-skin')} — acrylic / glass appearance for DeepSeek Harness

${c.bold('Usage')}
  node scripts/install.mjs [options]

${c.bold('Options')}
  --no-patch        install the plugin only (surface translucency, no desktop show-through)
  --no-plugin       apply the window patch only
  --asar <path>     patch this app.asar instead of auto-detecting it
  --dry-run         print what would happen, change nothing
  --uninstall       remove the plugin and restore app.asar from the backup
  --yes             do not ask for confirmation
  -h, --help        this text

${c.bold('What it does')}
  1. installs the Client plugin into the current dsh profile
  2. patches the DeepSeek Harness app.asar so the main window uses the native
     Windows acrylic material (needs the app to be closed while patching)

${c.bold('Notes')}
  The plugin half is reversible with \`--uninstall\` or by disabling it in
  Settings → General → Glass skin. The patch half keeps a byte-exact backup
  next to app.asar; an app update replaces app.asar and drops the patch.
`

function parseArgs(argv) {
  const out = { patch: true, plugin: true, asar: undefined, dryRun: false, uninstall: false, yes: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--no-patch') out.patch = false
    else if (arg === '--no-plugin') out.plugin = false
    else if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--uninstall') out.uninstall = true
    else if (arg === '--yes' || arg === '-y') out.yes = true
    else if (arg === '-h' || arg === '--help') out.help = true
    else if (arg === '--asar') {
      out.asar = argv[i + 1]
      if (out.asar === undefined) throw new Error('--asar needs a path')
      i += 1
    } else throw new Error(`unknown argument: ${arg}`)
  }
  if (out.uninstall) {
    out.patch = true
    out.plugin = true
  }
  return out
}

/* ------------------------------------------------------------------ */
/* discovery                                                          */
/* ------------------------------------------------------------------ */

/** Harness home: `$DSH_HOME`, else `~/.dsh`. */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv.trim())
  return path.join(os.homedir(), '.dsh')
}

/**
 * Read the profile name from the environment.
 *
 * The Desktop app always launches with `DSH_PROFILE=desktop`; a CLI user may
 * have `web` or another name. Falling back to `desktop` matches the app the
 * window patch targets, and the plugin half is harmless in either profile.
 */
function profileName() {
  const p = process.env.DSH_PROFILE
  return typeof p === 'string' && p.trim() !== '' ? p.trim() : 'desktop'
}

function profileDir() {
  return path.join(dshHome(), 'profiles', profileName())
}

/**
 * Locate the packaged Electron app that owns app.asar.
 *
 * Order matters: an explicit `--asar` wins, then a **running** DeepSeek Harness
 * process (the authoritative answer — its command line names the exact
 * resources directory), then the usual install locations.
 *
 * The process probe exists because DSH also ships as a portable/unpacked
 * directory anywhere on disk, not only under Program Files; scanning fixed
 * paths alone would report "not found" for those users even though the app is
 * right there and running.
 *
 * @returns the app.asar path, or undefined when nothing looks like DSH.
 */
function findAsar(explicit) {
  if (explicit !== undefined) {
    const p = path.resolve(explicit)
    return fs.existsSync(p) ? p : undefined
  }

  // 1. Ask the running app. Works while DSH is open, which is exactly when a
  //    user reads the README, so this is the common case, not the rare one.
  const running = asarFromRunningApp()
  if (running !== undefined) return running

  // 2. Conventional install locations.
  const candidates = []
  for (const base of [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']]) {
    if (typeof base !== 'string' || base === '') continue
    candidates.push(path.join(base, 'DeepSeek Harness', 'resources', 'app.asar'))
    candidates.push(path.join(base, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'))
  }
  candidates.push('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar')
  candidates.push('/opt/DeepSeek Harness/resources/app.asar')
  candidates.push('/usr/lib/deepseek-harness/resources/app.asar')
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate
  return undefined
}

/**
 * Derive app.asar from a live DeepSeek Harness process command line.
 *
 * The host process is spawned with the runtime archive and the project
 * directory as positional arguments, e.g.
 *   "...DeepSeek Harness.exe" --expose-internals <...>/app.asar/dsh/node_modules/...
 * so any argument containing `<sep>app.asar<sep>` names the archive directly.
 *
 * @returns the archive path, or undefined when DSH is not running.
 */
function asarFromRunningApp() {
  const isWin = process.platform === 'win32'
  const lister = isWin
    ? spawnSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'DeepSeek Harness*' } | ForEach-Object { $_.CommandLine }"], { encoding: 'utf8' })
    : spawnSync('ps', ['-Ao', 'command'], { encoding: 'utf8' })
  if (lister.status !== 0 || typeof lister.stdout !== 'string') return undefined

  const re = /([A-Za-z]:\\[^\s"']*?\\app\.asar|\/[^\s"']*?\/app\.asar)/u
  for (const line of lister.stdout.split(/\r?\n/u)) {
    if (!line.includes('app.asar')) continue
    const match = line.match(re)
    if (match === null) continue
    const archive = match[1]
    if (fs.existsSync(archive)) return archive
  }
  return undefined
}

/* ------------------------------------------------------------------ */
/* plugin half                                                        */
/* ------------------------------------------------------------------ */

const PLUGIN_NAME = 'dsh-glass-skin'

/**
 * Check whether the current process can reach the plugin manager.
 *
 * `install_bundle` is a Host service, not a shell command: the supported way to
 * install from a directory is DSH's own CLI (`dsh plugin --profile X add`). This
 * script therefore shells out to that CLI and reports the exact command when it
 * cannot find it, instead of silently doing nothing.
 */
function resolveDshCli() {
  const fromEnv = process.env.DSH_CLI
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '' && fs.existsSync(fromEnv)) return fromEnv
  // A packaged Desktop runtime ships the CLI beside the runtime root.
  const guesses = [
    path.join(process.env.LOCALAPPDATA ?? '', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.js'),
  ]
  for (const guess of guesses) if (guess !== '' && fs.existsSync(guess)) return guess
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['dsh'], { encoding: 'utf8' })
  if (probe.status === 0) {
    const first = probe.stdout.split(/\r?\n/u).find((line) => line.trim() !== '')
    if (first !== undefined) return first.trim()
  }
  return undefined
}

function runPluginInstall() {
  const cli = resolveDshCli()
  if (cli === undefined) return { installed: false, reason: 'dsh-cli-missing' }
  const result = spawnSync(process.execPath, [cli, 'plugin', '--profile', profileName(), 'add', PLUGIN_DIR], {
    encoding: 'utf8',
    env: process.env,
  })
  return {
    installed: result.status === 0,
    reason: result.status === 0 ? undefined : (result.stderr || result.stdout || 'unknown failure').trim(),
    cli,
  }
}

/* ------------------------------------------------------------------ */
/* patch half                                                         */
/* ------------------------------------------------------------------ */

function runPatcher(action, asar, extra = []) {
  const result = spawnSync(process.execPath, [PATCHER, action, '--asar', asar, ...extra], {
    encoding: 'utf8',
    env: process.env,
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/* ------------------------------------------------------------------ */
/* main                                                               */
/* ------------------------------------------------------------------ */

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    fail(error.message)
    say(USAGE)
    process.exitCode = 2
    return
  }
  if (args.help) {
    say(USAGE)
    return
  }

  say(`\n${c.bold('dsh-glass-skin')} ${c.dim(`(${process.platform}/${process.arch})`)}`)
  if (args.dryRun) info(c.yellow('dry run — nothing will be changed'))

  const asar = args.patch ? findAsar(args.asar) : undefined
  const cli = resolveDshCli()

  head('plan')
  info(`dsh home   ${dshHome()}`)
  info(`profile    ${profileName()}`)
  info(`plugin     ${args.plugin ? PLUGIN_DIR : c.dim('skipped')}`)
  info(`app.asar   ${args.patch ? asar ?? c.red('not found') : c.dim('skipped')}`)
  if (args.plugin) info(`dsh cli    ${cli ?? c.yellow('not found')}`)

  if (args.patch && asar === undefined) {
    warn('could not locate app.asar automatically.')
    info('Pass it explicitly:  --asar "/path/to/DeepSeek Harness/resources/app.asar"')
    info('The plugin half can still be installed on its own (it gives translucency')
    info('without the desktop showing through).')
    if (!args.plugin) {
      process.exitCode = 1
      return
    }
  }

  if (args.dryRun) {
    head('dry run')
    ok('no changes were made')
    return
  }

  /* ---- uninstall ---- */
  if (args.uninstall) {
    let restored = false
    head('restore app.asar')
    if (asar !== undefined) {
      const out = runPatcher('disable', asar)
      // A subprocess can exit non-zero while its stdout looks fine (the patcher
      // prints progress before failing), so the EXIT CODE is the only signal
      // that decides success. Reporting "uninstalled" without checking it once
      // told the user their archive was restored while it was still patched.
      if (out.status === 0) {
        ok('app.asar restored from the byte-exact backup')
        restored = true
      } else {
        fail('could not restore app.asar')
        say(out.stderr.trim() || out.stdout.trim())
        info('Close DeepSeek Harness completely, then re-run --uninstall.')
      }
    } else {
      warn('no app.asar located; nothing to restore')
    }

    let removed = false
    head('remove plugin')
    if (cli !== undefined) {
      const rm = spawnSync(process.execPath, [cli, 'plugin', '--profile', profileName(), 'remove', PLUGIN_NAME], {
        encoding: 'utf8',
        env: process.env,
      })
      if (rm.status === 0) {
        ok('plugin removed from the profile')
        removed = true
      } else {
        warn('the CLI could not remove the plugin; remove it from Settings → Plugins')
        info((rm.stderr || rm.stdout || '').trim())
      }
    } else {
      warn('dsh CLI not found; remove the plugin from Settings → Plugins')
    }

    head('done')
    if (restored && removed) ok('glass skin uninstalled')
    else if (restored || removed) {
      warn('partially uninstalled — see the messages above')
      process.exitCode = 1
    } else {
      fail('nothing was uninstalled')
      process.exitCode = 1
    }
    return
  }

  /* ---- 1. window patch ---- */
  let patched = false
  if (args.patch && asar !== undefined) {
    head('window patch (native acrylic)')
    const status = runPatcher('status', asar)
    const alreadyEnabled = /state\s*\n\s*\S*\s*enabled/u.test(status.stdout) || /\benabled\b/u.test(status.stdout.split('-> sha256')[0] ?? '')
    if (alreadyEnabled) {
      ok('app.asar is already patched')
      patched = true
    } else {
      const out = runPatcher('enable', asar)
      if (out.status === 0) {
        ok('app.asar patched (length-preserving, self-verified)')
        patched = true
      } else {
        fail('patching app.asar failed')
        say(out.stderr || out.stdout)
        info('Most likely DeepSeek Harness is still running and holds a lock on the file.')
        info('Quit it completely (including the tray icon) and run this installer again.')
        const leftovers = runPatcher('status', asar)
        info(leftovers.stdout.split('\n').filter((l) => /state|backup/u.test(l)).join('\n'))
      }
    }
  }

  /* ---- 2. plugin ---- */
  let pluginInstalled = false
  if (args.plugin) {
    head('client plugin')
    if (cli === undefined) {
      fail('the dsh CLI was not found, so the plugin could not be installed automatically.')
      say('')
      say(`  ${c.bold('Install it manually with one command:')}`)
      say(`  ${c.cyan(`dsh plugin --profile ${profileName()} add "${PLUGIN_DIR}"`)}`)
      say('')
      info('Or: Settings → Plugins → Add, and point it at the folder above.')
    } else {
      const out = runPluginInstall()
      if (out.installed) {
        ok(`plugin linked into profile "${profileName()}"`)
        pluginInstalled = true
      } else {
        fail('plugin installation failed')
        say(out.reason ?? '')
        info(`Retry manually:  dsh plugin --profile ${profileName()} add "${PLUGIN_DIR}"`)
      }
    }
  }

  /* ---- summary ---- */
  head('done')
  if (patched) ok('window material: native acrylic')
  if (pluginInstalled) ok('glass surfaces: enabled (Settings → General → Glass skin)')
  if (patched || pluginInstalled) {
    say('')
    say(`  ${c.bold('Restart DeepSeek Harness to see the effect.')}`)
    say('')
    if (patched && !pluginInstalled) warn('plugin half is missing: surfaces stay opaque')
    if (!patched && pluginInstalled) warn('window patch is missing: no desktop show-through')
    say(`  ${c.dim('Undo:  node scripts/install.mjs --uninstall')}`)
  }
}

main()

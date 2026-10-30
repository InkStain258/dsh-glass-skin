#!/usr/bin/env node
/**
 * Patch if needed, then start DeepSeek Harness.
 *
 * ## Why a launcher
 *
 * The window material can only be set by patching `app.asar` — the Host plugin
 * runs under `ELECTRON_RUN_AS_NODE`, so it has no `BrowserWindow` and DSH exposes
 * no window service (verified against the live service catalogue). Patching needs
 * the archive unlocked, which means the app must be closed.
 *
 * Every attempt to automate that "wait for the app to close" step failed for the
 * same reason: a helper started by the app is a child of the app, and quitting
 * takes the child with it. The user was left guessing how long to stay closed —
 * a question with no correct answer, because the helper might already be gone.
 *
 * A launcher removes the question instead of answering it. It runs while the app
 * is closed by definition, so the patch is applied before the window is created,
 * and the app is then started normally:
 *
 *   node tools/launch.mjs                 patch if needed, then start
 *   node tools/launch.mjs --no-start      patch only (diagnostics, tests)
 *   node tools/launch.mjs --install       put a Desktop shortcut that does this
 *   node tools/launch.mjs --uninstall     remove that shortcut
 *
 * @module dsh-glass-skin/launch
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PATCHER = path.join(HERE, 'dsh-glass-desktop.mjs')
const MARKER = 'backgroundMaterial:"acrylic"'
const SHORTCUT_NAME = 'DeepSeek Harness (Glass).lnk'

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const argOf = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined
}

const c = {
  bold: (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s),
  green: (s) => (process.stdout.isTTY ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s) => (process.stdout.isTTY ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s) => (process.stdout.isTTY ? `\x1b[31m${s}\x1b[0m` : s),
}
const say = (s = '') => console.log(s)

/* ------------------------------------------------------------------ */
/* archive                                                            */
/* ------------------------------------------------------------------ */

function readEntry(asar, segments) {
  const fd = fs.openSync(asar, 'r')
  try {
    const head = Buffer.alloc(16)
    if (fs.readSync(fd, head, 0, 16, 0) < 16) return undefined
    const jsonLength = head.readUInt32LE(12)
    if (jsonLength === 0 || jsonLength > 64 * 1024 * 1024) return undefined
    const jsonBuf = Buffer.alloc(jsonLength)
    if (fs.readSync(fd, jsonBuf, 0, jsonLength, 16) < jsonLength) return undefined
    let node
    try {
      node = JSON.parse(jsonBuf.toString('utf8'))
    } catch {
      return undefined
    }
    for (const segment of segments) {
      node = node?.files?.[segment]
      if (!node) return undefined
    }
    const start = 16 + jsonLength + Number(node.offset)
    const out = Buffer.alloc(node.size)
    if (fs.readSync(fd, out, 0, node.size, start) < node.size) return undefined
    return out
  } finally {
    fs.closeSync(fd)
  }
}

function isPatched(asar) {
  try {
    const main = readEntry(asar, ['lib', 'main.js'])
    return main ? main.includes(Buffer.from(MARKER)) : undefined
  } catch {
    return undefined
  }
}

function findAsar() {
  const explicit = argOf('asar')
  if (explicit) return fs.existsSync(explicit) ? explicit : undefined

  const candidates = []
  const local = process.env.LOCALAPPDATA
  if (local) {
    candidates.push(path.join(local, 'DeepSeek Harness', 'resources', 'app.asar'))
    candidates.push(path.join(local, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'))
  }
  if (process.env.PROGRAMFILES) {
    candidates.push(path.join(process.env.PROGRAMFILES, 'DeepSeek Harness', 'resources', 'app.asar'))
  }

  const lister = spawnSync('powershell', [
    '-NoProfile',
    '-Command',
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'DeepSeek Harness*' } | ForEach-Object { $_.CommandLine }",
  ], { encoding: 'utf8' })
  if (lister.status === 0 && typeof lister.stdout === 'string') {
    for (const line of lister.stdout.split(/\r?\n/u)) {
      const m = line.match(/([A-Za-z]:\\[^\s"']*?\\app\.asar)/u)
      if (m && fs.existsSync(m[1])) return m[1]
    }
  }
  return candidates.find((p) => fs.existsSync(p))
}

function appExeFor(asar) {
  const appDir = path.dirname(path.dirname(asar))
  const name = process.platform === 'win32' ? 'DeepSeek Harness.exe' : 'DeepSeek Harness'
  const exe = path.join(appDir, name)
  return fs.existsSync(exe) ? exe : undefined
}

/** Cheap write-free lock probe: renaming a file onto itself needs DELETE access. */
function locked(asar) {
  try {
    fs.renameSync(asar, asar)
    return false
  } catch (error) {
    if (error.code === 'EBUSY' || error.code === 'EPERM' || error.code === 'EACCES') return true
    return undefined
  }
}

/* ------------------------------------------------------------------ */
/* shortcut                                                           */
/* ------------------------------------------------------------------ */

function desktopDir() {
  const profile = process.env.USERPROFILE ?? os.homedir()
  const oneDrive = process.env.OneDrive
  const candidates = [
    oneDrive ? path.join(oneDrive, 'Desktop') : undefined,
    path.join(profile, 'Desktop'),
  ].filter(Boolean)
  return candidates.find((p) => fs.existsSync(p))
}

function shortcutPath() {
  const dir = desktopDir()
  return dir ? path.join(dir, SHORTCUT_NAME) : undefined
}

/**
 * Create the shortcut through WScript.Shell.
 *
 * Node cannot write a .lnk itself, and pulling in a dependency for one shortcut
 * is not worth it. The target is `node <launch.mjs>`, window hidden, so the user
 * sees only the app starting.
 */
function installShortcut(asar) {
  if (process.platform !== 'win32') {
    say(`${c.yellow('!')} shortcuts are Windows-only; run this script directly instead`)
    return 1
  }
  const target = shortcutPath()
  if (!target) {
    say(`${c.red('x')} cannot find the Desktop folder`)
    return 1
  }
  const exe = appExeFor(asar)
  if (!exe) {
    say(`${c.red('x')} cannot find the app executable next to ${asar}`)
    return 1
  }

  const node = process.execPath
  const script = path.join(HERE, 'launch.mjs')
  const ps = [
    '$ErrorActionPreference = "Stop"',
    '$shell = New-Object -ComObject WScript.Shell',
    `$sc = $shell.CreateShortcut("${target}")`,
    `$sc.TargetPath = "${node}"`,
    `$sc.Arguments = '"' + '${script}' + '" --asar "' + '${asar}' + '"'`,
    `$sc.WorkingDirectory = "${path.dirname(script)}"`,
    `$sc.IconLocation = "${exe},0"`,
    '$sc.WindowStyle = 7',
    '$sc.Description = "Start DeepSeek Harness with the glass window material"',
    '$sc.Save()',
  ].join('; ')

  const result = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' })
  if (result.status !== 0) {
    say(`${c.red('x')} could not create the shortcut`)
    say(`${result.stdout ?? ''}${result.stderr ?? ''}`.trim())
    return 1
  }
  say(`${c.green('+')} shortcut created: ${target}`)
  say(`  ${c.dim('It patches if needed, then starts the app — no waiting involved.')}`)
  return 0
}

function removeShortcut() {
  const target = shortcutPath()
  if (!target || !fs.existsSync(target)) {
    say(`${c.yellow('-')} no shortcut to remove`)
    return 1
  }
  fs.unlinkSync(target)
  say(`${c.green('+')} removed ${target}`)
  return 0
}

/* ------------------------------------------------------------------ */
/* main                                                               */
/* ------------------------------------------------------------------ */

function main() {
  const asar = findAsar()
  if (!asar) {
    say(`${c.red('x')} cannot find app.asar; pass --asar "<path>"`)
    return 2
  }

  if (flag('install')) return installShortcut(asar)
  if (flag('uninstall')) return removeShortcut()

  say(`\n${c.bold('dsh-glass-skin launch')}`)
  say(`  ${c.dim('archive')}  ${asar}`)
  say('')

  const state = isPatched(asar)
  if (state === undefined) {
    say(`${c.red('x')} cannot read lib/main.js inside the archive`)
    return 1
  }

  if (state) {
    say(`${c.green('+')} window patch already applied`)
  } else {
    const isLocked = locked(asar)
    if (isLocked) {
      say(`${c.yellow('!')} the patch is missing and the app is running, so it cannot be applied now.`)
      say(`  ${c.dim('Quit DeepSeek Harness, then run this again (or use the shortcut).')}`)
      return 2
    }
    say(`${c.dim('applying the window patch...')}`)
    const result = spawnSync(process.execPath, [PATCHER, 'enable', '--asar', asar], {
      encoding: 'utf8',
      env: process.env,
    })
    if (result.status !== 0) {
      say(`${c.red('x')} patch failed`)
      say(`${result.stdout ?? ''}${result.stderr ?? ''}`.trim())
      return 1
    }
    if (isPatched(asar) !== true) {
      say(`${c.red('x')} post-check failed: the archive still lacks the patch`)
      return 1
    }
    say(`${c.green('+')} patch applied`)
  }

  if (flag('no-start')) {
    say(`${c.dim('--no-start given; not launching')}`)
    return 0
  }

  const exe = appExeFor(asar)
  if (!exe) {
    say(`${c.red('x')} cannot find the app executable next to the archive`)
    return 1
  }
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(exe, [], { detached: true, stdio: 'ignore', env })
  child.unref()
  say(`${c.green('+')} started ${path.basename(exe)}`)
  return 0
}

process.exitCode = main()

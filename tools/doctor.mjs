#!/usr/bin/env node
/**
 * Diagnose both halves of the glass skin and say what to do next.
 *
 * A glass skin has two independent halves that fail differently:
 *
 *   window patch   lives inside `resources/app.asar`, so a DSH update erases it
 *   client plugin  lives in the profile, so it survives updates but breaks on
 *                  manifest mistakes
 *
 * When the window half is gone the surfaces stay translucent while the desktop
 * stops showing through — a state that looks like "the plugin is broken" and
 * sends people to the wrong place. This command exists so the two can be told
 * apart in one shot.
 *
 *   node tools/doctor.mjs            human-readable report
 *   node tools/doctor.mjs --json     machine-readable
 *   node tools/doctor.mjs --fix      re-apply the patch if the app is closed
 *
 * @module dsh-glass-skin/doctor
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PATCHER = path.join(HERE, 'dsh-glass-desktop.mjs')
const MARKER = 'backgroundMaterial:"acrylic"'

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const shouldFix = args.includes('--fix')
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

/* ------------------------------------------------------------------ */
/* archive side                                                       */
/* ------------------------------------------------------------------ */

/** Read an entry from an asar archive via its header, without a full scan. */
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

function findAsar() {
  const explicit = argOf('asar')
  if (explicit && fs.existsSync(explicit)) return explicit

  const candidates = []
  const local = process.env.LOCALAPPDATA
  if (local) {
    candidates.push(path.join(local, 'DeepSeek Harness', 'resources', 'app.asar'))
    candidates.push(path.join(local, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'))
  }
  if (process.env.PROGRAMFILES) {
    candidates.push(path.join(process.env.PROGRAMFILES, 'DeepSeek Harness', 'resources', 'app.asar'))
  }
  candidates.push('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar')

  // A running app names its own archive on the command line; portable installs
  // live anywhere, so this is the reliable path when the app is open.
  const lister =
    process.platform === 'win32'
      ? spawnSync('powershell', [
          '-NoProfile',
          '-Command',
          "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'DeepSeek Harness*' } | ForEach-Object { $_.CommandLine }",
        ], { encoding: 'utf8' })
      : spawnSync('ps', ['-Ao', 'command'], { encoding: 'utf8' })
  if (lister.status === 0 && typeof lister.stdout === 'string') {
    for (const line of lister.stdout.split(/\r?\n/u)) {
      const m = line.match(/([A-Za-z]:\\[^\s"']*?\\app\.asar|\/[^\s"']*?\/app\.asar)/u)
      if (m && fs.existsSync(m[1])) return m[1]
    }
  }
  return candidates.find((p) => fs.existsSync(p))
}

function archiveReport(asar) {
  const report = { path: asar, exists: false, version: undefined, patched: undefined, size: undefined }
  if (!asar) return report
  report.exists = true
  report.size = fs.statSync(asar).size
  try {
    const pkg = readEntry(asar, ['package.json'])
    if (pkg) report.version = JSON.parse(pkg.toString('utf8')).version
  } catch {
    /* version is informational */
  }
  try {
    const main = readEntry(asar, ['lib', 'main.js'])
    report.patched = main ? main.includes(Buffer.from(MARKER)) : undefined
  } catch {
    report.patched = undefined
  }
  return report
}

/** Cheap, write-free lock probe: renaming a file onto itself needs DELETE access. */
function archiveLocked(asar) {
  try {
    fs.renameSync(asar, asar)
    return false
  } catch (error) {
    if (error.code === 'EBUSY' || error.code === 'EPERM' || error.code === 'EACCES') return true
    return undefined
  }
}

/* ------------------------------------------------------------------ */
/* profile side                                                       */
/* ------------------------------------------------------------------ */

function dshHome() {
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
}

function profileDir() {
  const explicit = argOf('profile')
  if (explicit) return path.join(dshHome(), 'profiles', explicit)
  const root = path.join(dshHome(), 'profiles')
  const preferred = path.join(root, 'desktop')
  if (fs.existsSync(preferred)) return preferred
  try {
    const first = fs.readdirSync(root, { withFileTypes: true }).find((e) => e.isDirectory())
    return first ? path.join(root, first.name) : undefined
  } catch {
    return undefined
  }
}

function profileReport(dir) {
  const report = { dir, declared: false, listed: false, installed: false, hasDshMetadata: undefined, version: undefined }
  if (!dir) return report
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    report.declared = Boolean(manifest.dependencies?.['dsh-glass-skin'])
    report.listed = (manifest.dsh?.profile?.bundles ?? []).includes('dsh-glass-skin')
  } catch {
    /* missing profile manifest */
  }
  const installed = path.join(dir, 'node_modules', 'dsh-glass-skin')
  if (fs.existsSync(installed)) {
    report.installed = true
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'))
      report.version = pkg.version
      report.hasDshMetadata = Boolean(pkg.dsh?.bundle?.patch)
    } catch {
      report.hasDshMetadata = false
    }
  }
  return report
}

/**
 * The Desktop shortcut that patches and then starts the app.
 *
 * A launcher is the supported path: it runs while the app is closed, so the
 * patch lands before the window is created and there is no waiting involved.
 */
function launcherShortcut() {
  const profile = process.env.USERPROFILE
  if (!profile) return { installed: false }
  const name = 'DeepSeek Harness (Glass).lnk'
  const candidates = [
    process.env.OneDrive ? path.join(process.env.OneDrive, 'Desktop', name) : undefined,
    path.join(profile, 'Desktop', name),
  ].filter(Boolean)
  const found = candidates.find((p) => fs.existsSync(p))
  return { entry: found, installed: Boolean(found) }
}

/* ------------------------------------------------------------------ */
/* main                                                               */
/* ------------------------------------------------------------------ */

function main() {
  const asarPath = findAsar()
  const archive = archiveReport(asarPath)
  const profile = profileReport(profileDir())
  const launcher = launcherShortcut()

  const problems = []
  const actions = []

  if (!archive.exists) {
    problems.push('app.asar not found')
    actions.push('pass --asar "<path to resources/app.asar>"')
  } else if (archive.patched === false) {
    const locked = archiveLocked(archive.path)
    problems.push(
      locked
        ? 'window patch is missing (expected after a DSH update) and the app is running, so it cannot be re-applied yet'
        : 'window patch is missing (expected after a DSH update)',
    )
    actions.push(
      locked
        ? 'quit DeepSeek Harness, then start it with the "DeepSeek Harness (Glass)" shortcut — it patches while the app is closed and launches it, so nothing has to be timed'
        : 'run: node tools/launch.mjs --no-start   (or tools/repair.mjs)',
    )
  } else if (archive.patched === undefined) {
    problems.push('cannot read lib/main.js inside app.asar')
  }

  if (!profile.installed) {
    problems.push('the Client plugin is not installed in the profile')
    actions.push('run: npx github:InkStain258/dsh-glass-skin')
  } else if (profile.hasDshMetadata === false) {
    problems.push('the installed package declares no dsh.bundle — it was resolved to the repository root of an older release')
    actions.push('reinstall with the current release so the root manifest carries dsh metadata')
  }
  if (profile.installed && !profile.listed) {
    problems.push('the plugin is installed but not listed in the profile bundle layer')
    actions.push('add "dsh-glass-skin" to dsh.profile.bundles in the profile package.json')
  }

  const healthy = problems.length === 0

  if (asJson) {
    console.log(JSON.stringify({ archive, profile, launcher, healthy, problems, actions }, null, 2))
    process.exitCode = healthy ? 0 : 1
    return
  }

  const say = (s = '') => console.log(s)
  say(`\n${c.bold('dsh-glass-skin doctor')}`)
  say('')

  say(`${c.bold('window patch')}`)
  if (!archive.exists) {
    say(`  ${c.red('x')} app.asar not found`)
  } else {
    say(`  ${c.dim('archive')}  ${archive.path}`)
    say(`  ${c.dim('dsh')}      ${archive.version ?? '(unknown)'}`)
    say(`  ${c.dim('size')}     ${archive.size.toLocaleString()} bytes`)
    const state =
      archive.patched === true
        ? c.green('applied')
        : archive.patched === false
          ? c.yellow('missing')
          : c.yellow('unknown')
    say(`  ${c.dim('patch')}    ${state}`)
  }

  say('')
  say(`${c.bold('client plugin')}`)
  if (!profile.dir) {
    say(`  ${c.red('x')} no profile found under ${dshHome()}`)
  } else {
    say(`  ${c.dim('profile')}  ${profile.dir}`)
    say(`  ${c.dim('installed')} ${profile.installed ? c.green(`yes (v${profile.version})`) : c.red('no')}`)
    say(`  ${c.dim('declared')}  ${profile.declared ? 'yes' : c.red('no')}`)
    say(`  ${c.dim('bundled')}   ${profile.listed ? 'yes' : c.red('no')}`)
    if (profile.installed) {
      say(`  ${c.dim('dsh meta')}  ${profile.hasDshMetadata ? c.green('present') : c.red('missing')}`)
    }
  }

  say('')
  say(c.bold('launcher'))
  say(
    '  ' +
      c.dim('desktop shortcut') +
      ' ' +
      (launcher.installed ? c.green('installed') : c.yellow('not installed')),
  )
  if (!launcher.installed) {
    say('  ' + c.dim('add it with: npx github:InkStain258/dsh-glass-skin launch --install'))
  }
  say('  ' + c.dim('The shortcut patches while the app is closed, then starts it — no waiting.'))

  say('')
  if (healthy) {
    say(`${c.green('+ everything is in place')}`)
    say(`  ${c.dim('If the desktop still does not show through, quit DSH fully and relaunch.')}`)
  } else {
    say(`${c.bold('what to do')}`)
    for (const a of actions) say(`  ${c.yellow('>')} ${a}`)
  }
  say('')

  if (!healthy && shouldFix) {
    if (!archive.exists) return
    if (archive.patched !== false) return
    if (archiveLocked(archive.path)) {
      say(`${c.yellow('!')} app is running; quit it first, then re-run with --fix`)
      process.exitCode = 1
      return
    }
    say(`${c.bold('applying the patch')}`)
    const result = spawnSync(process.execPath, [PATCHER, 'enable', '--asar', archive.path], {
      encoding: 'utf8',
      env: process.env,
    })
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
    if (result.status === 0) {
      say(`${c.green('+')} patched; relaunch DeepSeek Harness to see it`)
    } else {
      say(`${c.red('x')} patch failed`)
      say(output)
      process.exitCode = 1
    }
    return
  }

  process.exitCode = healthy ? 0 : 1
}

main()

#!/usr/bin/env node
/**
 * Re-apply the window patch after a DSH update.
 *
 * ## Why this exists
 *
 * A DSH update replaces `resources/app.asar` wholesale. That discards the
 * window-material patch *and* the sidecar backup that pointed at the old
 * build — but it leaves the Client plugin installed, so the UI still looks
 * glassy while the desktop stops showing through. That combination is
 * confusing, so it deserves its own command rather than "re-run the installer
 * and hope".
 *
 * ## How it decides what to do
 *
 * - patched already            -> report and exit 0
 * - no backup for this build   -> create one, then patch (fresh install case)
 * - backup for a *different* build -> the app was updated: the old backup is
 *   useless, so archive it as `.stale-<sha>` and take a fresh one. Keeping it
 *   under the same name would make `disable` restore bytes from the previous
 *   release over the new one, which is far worse than losing the old backup.
 *
 * @module dsh-glass-skin/repair
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PATCHER = path.join(HERE, 'dsh-glass-desktop.mjs')

const c = {
  dim: (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s) => (process.stdout.isTTY ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s) => (process.stdout.isTTY ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s) => (process.stdout.isTTY ? `\x1b[31m${s}\x1b[0m` : s),
  cyan: (s) => (process.stdout.isTTY ? `\x1b[36m${s}\x1b[0m` : s),
}
const say = (s = '') => process.stdout.write(`${s}\n`)
const ok = (s) => say(`${c.green('  +')} ${s}`)
const info = (s) => say(`${c.dim('    ')}${c.dim(s)}`)
const warn = (s) => say(`${c.yellow('  !')} ${s}`)
const fail = (s) => say(`${c.red('  x')} ${s}`)
const head = (s) => say(`\n${c.bold(c.cyan(`== ${s}`))}`)

/** SHA-256 of a file, streamed so a 180 MB archive does not sit in memory twice. */
function sha256File(file) {
  const hash = crypto.createHash('sha256')
  const buf = Buffer.allocUnsafe(1 << 20)
  const fd = fs.openSync(file, 'r')
  try {
    for (;;) {
      const read = fs.readSync(fd, buf, 0, buf.length, null)
      if (read === 0) break
      hash.update(buf.subarray(0, read))
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

/** True when the archive already carries the acrylic patch. */
function hasPatch(asar) {
  const needle = Buffer.from('backgroundMaterial:"acrylic"')
  const fd = fs.openSync(asar, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const chunk = Buffer.allocUnsafe(1 << 20)
    let carry = Buffer.alloc(0)
    let pos = 0
    while (pos < size) {
      const want = Math.min(chunk.length, size - pos)
      fs.readSync(fd, chunk, 0, want, pos)
      const slice = chunk.subarray(0, want)
      const joined = carry.length === 0 ? slice : Buffer.concat([carry, slice])
      if (joined.includes(needle)) return true
      // Keep the tail so a marker split across chunks is still found.
      carry = joined.subarray(Math.max(0, joined.length - (needle.length - 1)))
      pos += want
    }
    return false
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Locate the packaged app.
 *
 * Prefers a running process (its command line names the exact archive), then
 * conventional install locations. Portable installs live anywhere, so the
 * process probe is the reliable path when the app is open.
 */
function findAsar(explicit) {
  if (explicit) {
    const p = path.resolve(explicit)
    return fs.existsSync(p) ? p : undefined
  }
  const isWin = process.platform === 'win32'
  const lister = isWin
    ? spawnSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'DeepSeek Harness*' } | ForEach-Object { $_.CommandLine }"], { encoding: 'utf8' })
    : spawnSync('ps', ['-Ao', 'command'], { encoding: 'utf8' })
  if (lister.status === 0 && typeof lister.stdout === 'string') {
    const re = /([A-Za-z]:\\[^\s"']*?\\app\.asar|\/[^\s"']*?\/app\.asar)/u
    for (const line of lister.stdout.split(/\r?\n/u)) {
      if (!line.includes('app.asar')) continue
      const m = line.match(re)
      if (m && fs.existsSync(m[1])) return m[1]
    }
  }
  const candidates = []
  for (const base of [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']]) {
    if (!base) continue
    candidates.push(path.join(base, 'DeepSeek Harness', 'resources', 'app.asar'))
    candidates.push(path.join(base, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'))
  }
  candidates.push('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar')
  candidates.push('/opt/DeepSeek Harness/resources/app.asar')
  return candidates.find((p) => fs.existsSync(p))
}

/** True while any DSH process is alive, which means the archive is locked. */
function appRunning() {
  if (process.platform === 'win32') {
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe'], { encoding: 'utf8' })
    return typeof r.stdout === 'string' && /DeepSeek Harness\.exe/iu.test(r.stdout)
  }
  const r = spawnSync('pgrep', ['-f', 'DeepSeek Harness'], { encoding: 'utf8' })
  return r.status === 0
}

function runPatcher(action, asar, extra = []) {
  const r = spawnSync(process.execPath, [PATCHER, action, '--asar', asar, ...extra], { encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const build = args.includes('--build')
  const asarArg = (() => {
    const i = args.indexOf('--asar')
    return i >= 0 ? args[i + 1] : undefined
  })()

  const asar = findAsar(asarArg)
  say(`\n${c.bold('dsh-glass-skin repair')}${process.platform === 'win32' ? '' : ` ${c.dim(`(${process.platform})`)}`}`)

  if (!asar) {
    fail('could not locate app.asar')
    info('Pass it with --asar "<path to resources/app.asar>"')
    process.exitCode = 1
    return
  }
  info(`archive  ${asar}`)

  const backup = `${asar}.dsh-glass-backup`
  const sidecar = `${asar}.dsh-glass.json`
  const liveSha = sha256File(asar)
  info(`sha256   ${liveSha.slice(0, 32)}`)

  /* ---- already patched? --------------------------------------------- */
  if (hasPatch(asar)) {
    head('already patched')
    ok('the window material is in place; nothing to do')
    info('If the desktop still does not show through, quit DSH fully and relaunch.')
    if (build) say(`\n${c.bold('exit')} 0`)
    return
  }

  head('patch is missing')
  ok('this is expected after a DSH update replaced app.asar')

  /* ---- is the existing backup for a different build? ---------------- */
  let backupState = 'none'
  if (fs.existsSync(backup) && fs.existsSync(sidecar)) {
    let recorded
    try {
      recorded = JSON.parse(fs.readFileSync(sidecar, 'utf8'))
    } catch {
      recorded = undefined
    }
    if (recorded && typeof recorded.originalSha256 === 'string') {
      // The backup records what the archive looked like *before* patching.
      // After an update the live file is a different build, so the backup no
      // longer matches and must not be used by `disable`.
      const backupSha = sha256File(backup)
      if (backupSha !== liveSha) backupState = 'stale'
      else backupState = 'current'
    }
  }

  if (backupState === 'stale') {
    warn('the existing backup belongs to a different DSH build')
    info('That happens after an update. It will be kept aside, not reused:')
    info('restoring it later would put the previous release over this one.')
    const staleTarget = `${backup}.stale-${liveSha.slice(0, 8)}`
    if (!dryRun) {
      fs.renameSync(backup, staleTarget)
      try {
        fs.renameSync(sidecar, `${staleTarget}.json`)
      } catch {
        /* sidecar is optional; the backup itself is what matters */
      }
      ok(`old backup renamed to ${path.basename(staleTarget)}`)
    } else {
      info(`would rename to ${path.basename(staleTarget)}`)
    }
  } else if (backupState === 'current') {
    ok('an up-to-date backup already exists')
  }

  if (dryRun) {
    head('dry run')
    info('would take a fresh backup (if needed) and re-apply the patch')
    return
  }

  if (appRunning()) {
    head('app is running')
    warn('DeepSeek Harness holds a lock on app.asar, so it cannot be replaced')
    say('')
    say(`  ${c.bold('Quit it completely (tray icon included), then run:')}`)
    say(`  ${c.cyan(`node ${path.relative(process.cwd(), fileURLToPath(import.meta.url))}`)}`)
    process.exitCode = 1
    return
  }

  head('re-applying the patch')
  const out = runPatcher('enable', asar)
  if (out.status !== 0) {
    fail('patching failed')
    say(out.stderr.trim() || out.stdout.trim())
    process.exitCode = 1
    return
  }

  if (!hasPatch(asar)) {
    fail('post-check failed: the archive still does not carry the patch')
    process.exitCode = 1
    return
  }
  ok('patch re-applied and verified')

  head('done')
  say(`  ${c.bold('Relaunch DeepSeek Harness to see the effect.')}`)
  if (build) say(`\n${c.bold('exit')} 0`)
}

main()

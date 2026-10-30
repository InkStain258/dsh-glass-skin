/**
 * Host half of the dsh-glass-skin bundle.
 *
 * The appearance lives in the Client half (`client.js`): a theme-token overlay
 * plus scoped CSS. This half does one narrow job — reporting whether the window
 * patch is still in place, in a log the user can actually read.
 *
 * ## What this half cannot do
 *
 * It cannot set the window material itself. Two routes were tried and both are
 * closed:
 *
 *   - `BrowserWindow.setBackgroundMaterial()` — unavailable. The Host runs under
 *     `ELECTRON_RUN_AS_NODE`, so although `process.versions.electron` is set,
 *     there is no BrowserWindow in this process.
 *   - A Host service for the window — none exists. The live service catalogue
 *     has `shell` (bash execution) and `webServer`, but nothing that reaches the
 *     window.
 *
 * So the material is applied by patching `app.asar`, which needs the archive
 * unlocked, which means the app must be closed. A helper spawned from here cannot
 * do that: it is a child of the app, and quitting the app takes it down (observed
 * — the waiter logged `start` and never reached `archive released`).
 *
 * That is why the supported entry point is `tools/launch.mjs` (or its Desktop
 * shortcut): it runs while the app is closed, so the patch lands before the
 * window exists and there is no "how long do I wait" question at all.
 *
 * This half therefore only records state. Diagnostics go to
 * `%LOCALAPPDATA%\dsh-glass-skin\host.log`, because console output from a Host
 * plugin in a packaged app goes nowhere useful.
 *
 * @module dsh-glass-skin
 */

import fs from 'node:fs'
import path from 'node:path'
import { rawFileSystem } from './fs-raw.js'

/** The option the installer injects into `lib/main.js`. */
const MARKER = 'backgroundMaterial:"acrylic"'

function logPath() {
  const base =
    process.env.LOCALAPPDATA ?? process.env.XDG_STATE_HOME ?? process.env.HOME ?? process.cwd()
  return path.join(base, 'dsh-glass-skin', 'host.log')
}

function log(message) {
  try {
    const file = logPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    try {
      if (fs.statSync(file).size > 256 * 1024) fs.writeFileSync(file, '', 'utf8')
    } catch {
      /* first write */
    }
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`, 'utf8')
  } catch {
    /* logging must never break the plugin */
  }
}

/** Read one entry out of the asar header, without scanning the archive. */
function readEntry(asar, segments) {
  // Electron's fs treats *.asar as a directory; the archive file itself must be
  // read through original-fs or openSync fails with ENOENT.
  const fsi = rawFileSystem()
  const fd = fsi.openSync(asar, 'r')
  try {
    const head = Buffer.alloc(16)
    if (fsi.readSync(fd, head, 0, 16, 0) < 16) return undefined
    const jsonLength = head.readUInt32LE(12)
    if (jsonLength === 0 || jsonLength > 64 * 1024 * 1024) return undefined
    const jsonBuf = Buffer.alloc(jsonLength)
    if (fsi.readSync(fd, jsonBuf, 0, jsonLength, 16) < jsonLength) return undefined
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
    if (fsi.readSync(fd, out, 0, node.size, start) < node.size) return undefined
    return out
  } finally {
    fsi.closeSync(fd)
  }
}

function findAsar() {
  const fromEnv = process.env.DSH_GLASS_ASAR
  if (fromEnv && rawFileSystem().existsSync(fromEnv)) return fromEnv
  const candidates = []
  if (typeof process.resourcesPath === 'string' && process.resourcesPath !== '') {
    candidates.push(path.join(process.resourcesPath, 'app.asar'))
  }
  if (typeof process.execPath === 'string' && process.execPath !== '') {
    candidates.push(path.join(path.dirname(process.execPath), 'resources', 'app.asar'))
  }
  return candidates.find((p) => rawFileSystem().existsSync(p))
}

/**
 * Report the window-patch state once per mount.
 *
 * Deferred so an appearance plugin never delays startup, and wrapped so a
 * filesystem oddity cannot take the app down.
 *
 * @param {unknown} ctx cordis context supplied by the Loader
 */
export function apply(ctx) {
  void ctx
  try {
    const timer = setTimeout(() => {
      try {
        const asar = findAsar()
        if (!asar) {
          log('cannot locate app.asar; window patch state unknown')
          return
        }
        const main = readEntry(asar, ['lib', 'main.js'])
        if (!main) {
          log(`cannot read lib/main.js in ${asar}`)
          return
        }
        const patched = main.includes(Buffer.from(MARKER))
        if (patched) {
          log('window patch present')
        } else {
          log(
            'window patch MISSING (a DSH update replaces app.asar). ' +
              'The surfaces stay translucent but the desktop will not show through. ' +
              'Fix: quit DSH, then run `dsh-glass-skin launch` or use the "DeepSeek Harness (Glass)" shortcut.',
          )
        }
      } catch (error) {
        log(`patch check failed: ${error?.message ?? error}`)
      }
    }, 3000)
    timer.unref?.()
  } catch (error) {
    log(`apply failed: ${error?.message ?? error}`)
  }
}

// Inside Electron, `fs` is asar-aware: `app.asar` is treated as a directory, so
// opening the archive file itself fails with ENOENT. `original-fs` bypasses that
// layer. Use it when present and fall back to plain fs elsewhere (tests, plain
// node), so the same code works in both places.
import fs from 'node:fs'
import { createRequire } from 'node:module'

let cached

export function rawFileSystem() {
  if (cached) return cached
  try {
    const require = createRequire(import.meta.url)
    cached = require('original-fs')
  } catch {
    cached = fs
  }
  return cached
}

/** True when the running process exposes Electron's unpatched filesystem. */
export function usingOriginalFs() {
  return rawFileSystem() !== fs
}

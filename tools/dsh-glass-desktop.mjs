#!/usr/bin/env node
/**
 * dsh-glass-desktop.mjs — patch the DeepSeek Harness Electron `app.asar` so its
 * MAIN window gets a native Windows glass backdrop (acrylic / mica).
 *
 *   node tools/dsh-glass-desktop.mjs status  [--asar <path>]
 *   node tools/dsh-glass-desktop.mjs enable  [--asar <path>] [--options '<js>']
 *   node tools/dsh-glass-desktop.mjs disable [--asar <path>] [--purge-backup]
 *
 * How the edit stays physically harmless
 * --------------------------------------
 * The archive is patched with an EXACT byte-length-preserving edit: N bytes of
 * inert ES object-literal options are inserted inside `lib/main.js` (in the
 * `createWindow()` BrowserWindow options) and exactly N bytes are removed from
 * a JSDoc comment in the same file. Therefore:
 *   - total file size is unchanged,
 *   - no entry offset shifts,
 *   - the asar header (JSON tree, offsets, sizes, integrity strings) stays
 *     byte-identical, so nothing but `lib/main.js` content changes,
 *   - the only differing bytes in the whole archive are two ranges, both
 *     inside `lib/main.js`.
 *
 * Safety model
 * ------------
 *   - The first `enable` writes `app.asar.dsh-glass-backup` plus a sidecar
 *     `app.asar.dsh-glass.json` (original sha256, size, inserted options,
 *     timestamp), but only when no backup exists yet, so the backup always
 *     holds the pristine archive.
 *   - The patch is written to a temp file in the same directory, fsynced and
 *     then atomically renamed over the target.
 *   - Before the rename, the finished temp file is re-read from disk and every
 *     assertion below is verified. Any failure aborts with a non-zero exit and
 *     leaves the target untouched.
 *   - `disable` restores the backup after checking its sha256 against the
 *     sidecar and keeps the backup unless `--purge-backup` is given.
 *
 * NOTE: the live `E:\Github\DSH\resources\app.asar` is read lazily by the
 * running app — test on a copy first. This tool only writes when you run
 * `enable`/`disable` against the path passed via `--asar`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const TOOL_VERSION = "1.0.0";

/** Absolute default target: the live DSH desktop archive. */
const DEFAULT_ASAR = "E:\\Github\\DSH\\resources\\app.asar";

/**
 * Default option list injected into `new BrowserWindow({ ... })` immediately
 * after the existing `show,` property. ASCII only, ends with a comma, contains
 * no `*`+`/` sequence, no backtick, and no `;` or `}` (so it cannot terminate
 * the object literal early).
 *
 * Deliberately does NOT set `transparent: true`. Measured on Electron 44.7.0 /
 * Windows 11 26300 over a high-frequency checkerboard backdrop:
 *
 *   acrylic only            -> backdrop genuinely blurred, native shadow intact
 *                              (30/28/18/74 px measured around the window)
 *   transparent:true        -> backdrop genuinely blurred, but the native drop
 *                              shadow collapses to ~2 px, so the window loses
 *                              its edge against the desktop
 *   transparent:true, no material -> backdrop crisp, not blurred (plain lucency)
 *   mica                    -> backdrop not visible at all
 *
 * A zero-alpha `backgroundColor` is enough to let the material through, which is
 * also exactly how this app's own welcome window is configured. Only the MAIN
 * window is changed; secondary and modal windows keep their opaque chrome.
 */
const DEFAULT_OPTIONS = 'backgroundColor:"#00000000",backgroundMaterial:"acrylic",';

/** Unique anchor inside `lib/main.js` (exactly one occurrence, LF line endings). */
const ANCHOR = '\t\tshow,\n\t\t...process.platform === "win32" && primary ? {';
/** The `show,` property that ends ANCHOR's first line; options go right after it. */
const ANCHOR_INSERT_AFTER = "show,";

/** Compensation target: the JSDoc directly above `function chromeFallbackFill()`. */
const COMPENSATION_FN = "function chromeFallbackFill(";

const MAIN_JS = "lib/main.js";
const BACKUP_SUFFIX = ".dsh-glass-backup";
const SIDECAR_SUFFIX = ".dsh-glass.json";

/* ------------------------------------------------------------------ */
/* console helpers                                                     */
/* ------------------------------------------------------------------ */

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const log = {
  head(msg) {
    console.log(`\n${C.bold(C.cyan("== " + msg))}`);
  },
  step(msg) {
    console.log(`  -> ${msg}`);
  },
  info(msg) {
    console.log(`     ${C.dim(msg)}`);
  },
  ok(msg) {
    console.log(`  ${C.green("+")} ${msg}`);
  },
  warn(msg) {
    console.log(`  ${C.yellow("!")} ${msg}`);
  },
  fail(msg) {
    console.error(`  ${C.red("x")} ${msg}`);
  },
  plain(msg = "") {
    console.log(msg);
  },
};

class AssertionError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "AssertionError";
  }
}

function assert(cond, msg) {
  if (!cond) throw new AssertionError(msg);
}

function eq(actual, expected, what) {
  assert(
    actual === expected,
    `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

function die(msg, code = 1) {
  log.fail(msg);
  process.exit(code);
}

function bytes(n) {
  return `${n.toLocaleString("en-US")} bytes`;
}

/* ------------------------------------------------------------------ */
/* CLI parsing                                                         */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = {
    command: null,
    asar: DEFAULT_ASAR,
    options: DEFAULT_OPTIONS,
    optionsGiven: false,
    purgeBackup: false,
    help: false,
  };
  const takesValue = new Set(["--asar", "--options"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (arg === "--purge-backup") {
      out.purgeBackup = true;
      continue;
    }
    const eqIdx = arg.startsWith("--") ? arg.indexOf("=") : -1;
    if (eqIdx !== -1) {
      const key = arg.slice(0, eqIdx);
      if (!takesValue.has(key)) die(`unknown flag: ${key}`);
      if (key === "--asar") out.asar = arg.slice(eqIdx + 1);
      if (key === "--options") {
        out.options = arg.slice(eqIdx + 1);
        out.optionsGiven = true;
      }
      continue;
    }
    if (takesValue.has(arg)) {
      const val = argv[++i];
      if (val === undefined) die(`flag ${arg} requires a value`);
      if (arg === "--asar") out.asar = val;
      if (arg === "--options") {
        out.options = val;
        out.optionsGiven = true;
      }
      continue;
    }
    if (arg.startsWith("--")) die(`unknown flag: ${arg}`);
    if (out.command === null) out.command = arg;
    else die(`unexpected argument: ${arg}`);
  }
  out.asar = path.resolve(out.asar);
  return out;
}

function usage() {
  console.log(`
${C.bold("dsh-glass-desktop")} — native glass backdrop for the DSH main window (asar patcher)

Usage:
  node tools/dsh-glass-desktop.mjs status  [--asar <path>]
  node tools/dsh-glass-desktop.mjs enable  [--asar <path>] [--options '<js options>']
  node tools/dsh-glass-desktop.mjs disable [--asar <path>] [--purge-backup]

Options:
  --asar <path>       Archive to operate on
                      (default: ${DEFAULT_ASAR})
  --options '<js>'    BrowserWindow option list injected right after \`show,\`
                      (default: ${DEFAULT_OPTIONS})
  --purge-backup      With \`disable\`: also delete the backup + sidecar.
  --help, -h          This text.

Files created next to the archive:
  app.asar.dsh-glass-backup   pristine copy of the original archive
  app.asar.dsh-glass.json     sidecar: sha256, size, injected options, timestamp

The edit preserves total file size byte-for-byte: N bytes are inserted inside
\`lib/main.js\` and exactly N bytes of a JSDoc comment in the same file are
trimmed away, so no entry offset changes and the asar header stays identical.
`);
}

/* ------------------------------------------------------------------ */
/* asar primitives                                                     */
/* ------------------------------------------------------------------ */

/**
 * Read + parse the asar header.
 * Layout: u32@0 = 4, u32@4 = header pickle size, u32@8 = headerStringSize,
 * u32@12 = jsonLength; JSON starts at 16; data begins at 16 + jsonLength.
 */
function readHeader(fd) {
  const pre = Buffer.alloc(16);
  const n = fs.readSync(fd, pre, 0, 16, 0);
  assert(n === 16, `could not read the 16-byte asar preamble (got ${n})`);
  const version = pre.readUInt32LE(0);
  const pickleSize = pre.readUInt32LE(4);
  const headerStringSize = pre.readUInt32LE(8);
  const jsonLength = pre.readUInt32LE(12);
  assert(version === 4, `unexpected asar version ${version} (expected 4)`);
  assert(
    jsonLength > 0 && jsonLength < 64 * 1024 * 1024,
    `implausible header jsonLength ${jsonLength}`,
  );
  const jsonRaw = Buffer.alloc(jsonLength);
  const got = fs.readSync(fd, jsonRaw, 0, jsonLength, 16);
  assert(got === jsonLength, `short header read: ${got}/${jsonLength}`);
  let json;
  try {
    json = JSON.parse(jsonRaw.toString("utf8"));
  } catch (err) {
    throw new AssertionError(`header JSON does not parse: ${err.message}`);
  }
  return {
    preamble: pre,
    version,
    pickleSize,
    headerStringSize,
    jsonLength,
    jsonRaw,
    json,
    dataStart: 16 + jsonLength,
  };
}

/** Recursively collect every node (files and directories) in header order. */
function walkNodes(node, prefix = "", acc = []) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const full = prefix ? `${prefix}/${name}` : name;
    acc.push({ path: full, entry });
    if (entry.files) walkNodes(entry, full, acc);
  }
  return acc;
}

/** Payload-bearing file entries (have `offset` + numeric `size`, packed). */
function payloadFiles(json) {
  return walkNodes(json).filter(
    ({ entry }) =>
      entry &&
      !entry.files &&
      typeof entry.size === "number" &&
      entry.offset !== undefined &&
      entry.unpacked !== true,
  );
}

function entryForPath(json, filePath) {
  let node = json;
  for (const part of filePath.split("/")) {
    node = node?.files?.[part];
    if (!node) return null;
  }
  return node;
}

function readEntry(fd, dataStart, entry) {
  const buf = Buffer.alloc(entry.size);
  if (entry.size === 0) return buf;
  const got = fs.readSync(fd, buf, 0, entry.size, dataStart + Number(entry.offset));
  assert(got === entry.size, `short read for entry (${got}/${entry.size})`);
  return buf;
}

function sha256File(file) {
  const fd = fs.openSync(file, "r");
  try {
    const h = crypto.createHash("sha256");
    const chunk = Buffer.alloc(8 << 20);
    let n;
    while ((n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      h.update(chunk.subarray(0, n));
    }
    return h.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

/** Every index where `needle` occurs in `hay` (string or Buffer). */
function findAll(hay, needle) {
  const found = [];
  let i = hay.indexOf(needle);
  while (i !== -1) {
    found.push(i);
    i = hay.indexOf(needle, i + 1);
  }
  return found;
}

function countOccurrences(hay, needle) {
  return findAll(hay, needle).length;
}

function commonPrefix(a, b) {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

function commonSuffix(a, b) {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

/* ------------------------------------------------------------------ */
/* option-list validation                                              */
/* ------------------------------------------------------------------ */

function validateOptions(options) {
  assert(typeof options === "string" && options.length > 0, "--options must be a non-empty string");
  for (const ch of options) {
    const code = ch.codePointAt(0);
    assert(code < 128, `--options must be pure ASCII, found ${JSON.stringify(ch)} (U+${code.toString(16)})`);
    assert(
      code >= 0x20 && code !== 0x7f,
      `--options must not contain control characters (found U+${code.toString(16)})`,
    );
  }
  assert(options.endsWith(","), '--options must end with a comma (it is spliced into an object literal)');
  assert(!options.includes("*/"), '--options must not contain "*/" (would close a block comment)');
  assert(!options.includes("`"), "--options must not contain a backtick");
  assert(!/[;}]/.test(options), '--options must not contain ";" or "}" (would end the object literal)');
  return Buffer.byteLength(options, "latin1");
}

/* ------------------------------------------------------------------ */
/* the two textual edits inside lib/main.js                            */
/* ------------------------------------------------------------------ */

/**
 * Insert `options` immediately after `show,` in the createWindow()
 * BrowserWindow options, and trim exactly N bytes from the JSDoc prose above
 * `function chromeFallbackFill()`. Works in latin1 space so bytes round-trip 1:1.
 */
function buildPatchedMain(oldBuf, options) {
  const s = oldBuf.toString("latin1");
  const n = Buffer.byteLength(options, "latin1");

  // --- edit 1: insertion point (right after `show,`) --------------------
  const anchorHits = findAll(s, ANCHOR);
  eq(anchorHits.length, 1, "occurrences of the createWindow anchor");
  const showOffset = anchorHits[0] + 2;
  assert(s.startsWith(ANCHOR_INSERT_AFTER, showOffset), "anchor does not start with `show,`");
  const insertPos = showOffset + ANCHOR_INSERT_AFTER.length;

  // --- edit 2: compensation (JSDoc above chromeFallbackFill) ------------
  const fnHits = findAll(s, COMPENSATION_FN);
  eq(fnHits.length, 1, `occurrences of "${COMPENSATION_FN}"`);
  const fnIdx = fnHits[0];
  const docStart = s.lastIndexOf("/**", fnIdx);
  assert(docStart !== -1, "could not find the JSDoc block above chromeFallbackFill()");
  const closeRel = s.indexOf("*/", docStart);
  assert(closeRel !== -1 && closeRel < fnIdx, "the JSDoc above chromeFallbackFill() is malformed");
  const docEnd = closeRel + 2;
  const between = s.slice(docEnd, fnIdx);
  assert(
    /^\s*$/.test(between),
    `unexpected non-whitespace between the JSDoc and chromeFallbackFill(): ${JSON.stringify(between)}`,
  );
  assert(docEnd <= insertPos, "the JSDoc unexpectedly sits after the insertion point");
  // The deletion always ends inside the JSDoc block (before docEnd <= insertPos),
  // so it can never overlap the insertion site. trimDocBlock() enforces that N
  // fits inside the block's prose and reports the exact capacity if it does not.

  const block = s.slice(docStart, docEnd);
  const trimmed = trimDocBlock(block, n);
  const delStartAbs = docStart + trimmed.boundary.delStart;
  const delEndAbs = docStart + trimmed.boundary.delEnd;

  // --- assemble ---------------------------------------------------------
  const newStr =
    s.slice(0, docStart) + trimmed.block + s.slice(docEnd, insertPos) + options + s.slice(insertPos);
  const newBuf = Buffer.from(newStr, "latin1");
  eq(newBuf.length, oldBuf.length, "patched lib/main.js byte length (must be unchanged)");
  eq(countOccurrences(newStr, "show," + options), 1, "inserted marker occurrences in lib/main.js");
  assert(trimmed.block.slice(0, -2).indexOf("*/") === -1, "trimmed JSDoc body must not contain a new */");

  return {
    buf: newBuf,
    info: {
      n,
      docStart,
      docEnd,
      delStartAbs,
      delEndAbs,
      insertPos,
      showOffset,
      markerOffset: showOffset - n,
      beforeBlock: block,
      afterBlock: trimmed.block,
      boundary: trimmed.boundary,
    },
  };
}

/**
 * Remove exactly `n` bytes from a JSDoc block (`/** ... *\/`) as ONE contiguous
 * run taken from the end of its PROSE, immediately before the closing `*\/`
 * line. Trailing `@tag` lines (such as `@returns`) are preserved. The
 * delimiters stay intact and the result stays pure ASCII.
 */
function trimDocBlock(block, n) {
  const lines = block.split("\n");
  assert(lines.length >= 3, "the JSDoc block has no prose lines to trim");
  eq(lines[0].trim(), "/**", "JSDoc opening line");
  eq(lines[lines.length - 1].trim(), "*/", "JSDoc closing line");
  assert(block.endsWith("*/"), "JSDoc block must end with */");

  // Byte offset of every line's first character.
  const offsets = [];
  let acc = 0;
  for (const line of lines) {
    offsets.push(acc);
    acc += line.length + 1;
  }

  const open = block.indexOf("/**") + 3;
  const closeIdx = block.length - 2;

  // End of the prose region: the newline before the first trailing @tag line,
  // or (when the block has no tags) the newline before the closing "*\/" line.
  let proseEnd = -1;
  let tagLine = null;
  for (let i = 1; i < lines.length - 1; i++) {
    if (/^\*\s*@/.test(lines[i])) {
      tagLine = lines[i];
      proseEnd = offsets[i] - 1;
      break;
    }
  }
  if (proseEnd === -1) proseEnd = block.lastIndexOf("\n", closeIdx - 1);
  assert(proseEnd > open, "could not locate the prose region inside the JSDoc block");

  const removable = proseEnd - open;
  assert(
    n <= removable,
    `cannot remove ${n} bytes from the chromeFallbackFill() JSDoc: only ${removable} removable characters are available`,
  );

  const delStart = proseEnd - n;
  assert(delStart > open, "the compensation would eat into the JSDoc opening delimiter");

  const newBlock = block.slice(0, delStart) + block.slice(proseEnd);
  eq(block.length - newBlock.length, n, "bytes removed from the JSDoc block");
  assert(newBlock.startsWith("/**") && newBlock.endsWith("*/"), "trimmed JSDoc lost its delimiters");
  assert(!/[^\x00-\x7f]/.test(newBlock), "trimmed JSDoc is no longer pure ASCII");
  assert(newBlock.slice(0, -2).indexOf("*/") === -1, "trimmed JSDoc gained a premature */");
  assert(!/\n[ \t]*\/\*\*[ \t]*\*\/$/.test(newBlock), "the JSDoc block was emptied entirely");
  if (tagLine !== null) assert(newBlock.includes(tagLine), "a @tag line was lost during trimming");

  const removedText = block.slice(delStart, proseEnd);
  const boundary = {
    delStart,
    delEnd: proseEnd,
    removedText,
    preservedTag: tagLine,
    keptTailLine: newBlock.split("\n").slice(-2, -1)[0] ?? "",
  };
  return { block: newBlock, boundary };
}

/* ------------------------------------------------------------------ */
/* writing the patched archive                                         */
/* ------------------------------------------------------------------ */

/** Copy `srcPath` -> `tmpPath`, substituting the lib/main.js payload. */
function writePatchedCopy(srcPath, tmpPath, dataStart, entry, newMain) {
  const total = fs.statSync(srcPath).size;
  const src = fs.openSync(srcPath, "r");
  const dst = fs.openSync(tmpPath, "w");
  try {
    const regionStart = dataStart + Number(entry.offset);
    const regionEnd = regionStart + entry.size;
    assert(regionEnd <= total, "lib/main.js region extends past the end of the archive");
    assert(newMain.length === entry.size, "patched lib/main.js length must equal the entry size");

    const copyRange = (from, to) => {
      const chunk = Buffer.alloc(8 << 20);
      let pos = from;
      while (pos < to) {
        const want = Math.min(chunk.length, to - pos);
        const got = fs.readSync(src, chunk, 0, want, pos);
        assert(got > 0, "short read while copying");
        let off = 0;
        while (off < got) {
          const wrote = fs.writeSync(dst, chunk, off, got - off);
          assert(wrote > 0, "short write while copying");
          off += wrote;
        }
        pos += got;
      }
    };

    copyRange(0, regionStart);
    let off = 0;
    while (off < newMain.length) {
      const wrote = fs.writeSync(dst, newMain, off, newMain.length - off);
      assert(wrote > 0, "short write of the patched lib/main.js");
      off += wrote;
    }
    copyRange(regionEnd, total);
    fs.fsyncSync(dst);
  } finally {
    fs.closeSync(dst);
    fs.closeSync(src);
  }
}

/* ------------------------------------------------------------------ */
/* self-verification (on-disk files, BEFORE any rename)                */
/* ------------------------------------------------------------------ */

/**
 * Verify the finished temp archive against the untouched original.
 * The lib/main.js check is non-tautological: the patched payload is
 * reconstructed independently from the original bytes as
 *   orig[0..docStart) + orig[docStart+n..insertPos) + options + orig[insertPos..)
 * and must match the on-disk patched payload byte-for-byte. That proves
 * exactly n bytes were deleted at docStart and exactly n bytes inserted at
 * insertPos, both inside lib/main.js.
 */
function verifyPatched({ originalPath, patchedPath, edit }) {
  const { options, n, delStartAbs, delEndAbs, insertPos, markerOffset } = edit;
  const optionBuf = Buffer.from(options, "latin1");
  eq(optionBuf.length, n, "declared options byte length");
  eq(delEndAbs - delStartAbs, n, "declared delete span length");

  const failures = [];
  const report = { diff: {} };
  const check = (label, fn) => {
    try {
      fn();
      log.ok(label);
    } catch (err) {
      failures.push(`${label} — ${err.message}`);
      log.fail(`${label} — ${err.message}`);
    }
  };

  const origSize = fs.statSync(originalPath).size;
  const newSize = fs.statSync(patchedPath).size;

  // 1. identical total size ------------------------------------------------
  check(`1/5 archive size unchanged (${bytes(newSize)})`, () => eq(newSize, origSize, "archive size"));

  const fdO = fs.openSync(originalPath, "r");
  const fdN = fs.openSync(patchedPath, "r");
  try {
    const ho = readHeader(fdO);
    const hn = readHeader(fdN);

    // 2. header + entry table identical -----------------------------------
    check("2/5 header (preamble + JSON) parses and is byte-identical", () => {
      assert(ho.preamble.equals(hn.preamble), "16-byte preamble differs");
      eq(hn.jsonLength, ho.jsonLength, "jsonLength");
      eq(hn.dataStart, ho.dataStart, "data start offset");
      assert(ho.jsonRaw.equals(hn.jsonRaw), "header JSON bytes differ");
      eq(typeof hn.json, "object", "parsed header type");
    });

    const nodesO = walkNodes(ho.json);
    const nodesN = walkNodes(hn.json);
    check(`   entry count identical (${nodesN.length.toLocaleString()} entries)`, () => {
      eq(nodesN.length, nodesO.length, "entry count");
      eq(Object.keys(hn.json.files ?? {}).length, Object.keys(ho.json.files ?? {}).length, "root entry count");
    });
    check("   every entry offset/size identical (no offset shifted)", () => {
      const mapN = new Map(nodesN.map((x) => [x.path, x.entry]));
      let compared = 0;
      for (const { path: p, entry: eo } of nodesO) {
        const en = mapN.get(p);
        assert(en, `entry missing in the patched archive: ${p}`);
        eq(!!en.files, !!eo.files, `dir/file kind of ${p}`);
        if (typeof eo.size === "number" || typeof en.size === "number") eq(en.size, eo.size, `size of ${p}`);
        if (eo.offset !== undefined || en.offset !== undefined) eq(en.offset, eo.offset, `offset of ${p}`);
        if (eo.integrity !== undefined || en.integrity !== undefined) {
          eq(JSON.stringify(en.integrity), JSON.stringify(eo.integrity), `integrity of ${p}`);
        }
        compared++;
      }
      eq(compared, nodesO.length, "entries compared");
    });

    // 3. only lib/main.js differs -----------------------------------------
    const filesO = payloadFiles(ho.json);
    const filesN = payloadFiles(hn.json);
    check(`3/5 payload hashes: only ${MAIN_JS} differs (${filesN.length.toLocaleString()} payload entries)`, () => {
      eq(filesN.length, filesO.length, "payload entry count");
      const mapN = new Map(filesN.map((x) => [x.path, x.entry]));
      const differing = [];
      for (const { path: p, entry: eo } of filesO) {
        const en = mapN.get(p);
        assert(en, `payload entry missing: ${p}`);
        const a = readEntry(fdO, ho.dataStart, eo);
        const b = readEntry(fdN, hn.dataStart, en);
        eq(b.length, a.length, `payload length of ${p}`);
        if (!a.equals(b)) differing.push(p);
      }
      eq(differing.length, 1, "number of differing payload entries");
      eq(differing[0], MAIN_JS, "the only differing payload entry");
      report.payloadEntries = filesN.length;
    });

    const mainO = readEntry(fdO, ho.dataStart, entryForPath(ho.json, MAIN_JS));
    const mainN = readEntry(fdN, hn.dataStart, entryForPath(hn.json, MAIN_JS));

    check("   lib/main.js: exactly n bytes deleted + n bytes inserted at the declared sites", () => {
      eq(mainN.length, mainO.length, "lib/main.js length");
      assert(delStartAbs >= 0 && delEndAbs <= insertPos && insertPos <= mainO.length, "declared edit sites out of range");
      const expected = Buffer.concat([
        mainO.subarray(0, delStartAbs),
        mainO.subarray(delEndAbs, insertPos),
        optionBuf,
        mainO.subarray(insertPos),
      ]);
      eq(expected.length, mainO.length, "reconstructed lib/main.js length");
      assert(
        mainN.equals(expected),
        "patched lib/main.js does not match the declared n-byte delete + n-byte insert",
      );
      const cp = commonPrefix(mainO, mainN);
      const cs = commonSuffix(mainO, mainN);
      let positional = 0;
      for (let i = 0; i < mainO.length; i++) if (mainO[i] !== mainN[i]) positional++;
      report.diff = {
        commonPrefix: cp,
        commonSuffix: cs,
        windowStart: cp,
        windowEnd: mainO.length - cs,
        windowBytes: mainO.length - cs - cp,
        deleted: n,
        inserted: n,
        positional,
        deleteSiteInMain: delStartAbs,
        insertSiteInMain: insertPos,
        mainLength: mainO.length,
      };
    });

    // 4. ESM parse check ---------------------------------------------------
    check("4/5 extracted lib/main.js passes `node --check` (ESM)", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-glass-check-"));
      const file = path.join(dir, "main.mjs");
      try {
        fs.writeFileSync(file, mainN);
        const res = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
        eq(res.status, 0, `node --check status (${(res.stderr || "").trim()})`);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    // 5. marker exactly once ----------------------------------------------
    check("5/5 inserted marker appears exactly once, at the expected offset", () => {
      const marker = Buffer.from("show," + options, "latin1");
      const hits = findAll(mainN, marker);
      eq(hits.length, 1, "marker occurrences in lib/main.js");
      eq(hits[0], markerOffset, "marker offset");
    });

    // extra: nothing outside lib/main.js changed, anywhere in the archive --
    check(`   whole-archive scan: zero differing bytes outside ${MAIN_JS}`, () => {
      const e = entryForPath(ho.json, MAIN_JS);
      const regionStart = ho.dataStart + Number(e.offset);
      const regionEnd = regionStart + e.size;
      const chunk = Buffer.alloc(4 << 20);
      let pos = 0;
      let total = 0;
      let outside = 0;
      while (pos < origSize) {
        const want = Math.min(chunk.length, origSize - pos);
        const a = Buffer.alloc(want);
        const b = Buffer.alloc(want);
        const ra = fs.readSync(fdO, a, 0, want, pos);
        const rb = fs.readSync(fdN, b, 0, want, pos);
        eq(ra, want, "read original chunk");
        eq(rb, want, "read patched chunk");
        if (!a.equals(b)) {
          for (let i = 0; i < want; i++) {
            if (a[i] !== b[i]) {
              total++;
              const abs = pos + i;
              if (abs < regionStart || abs >= regionEnd) outside++;
            }
          }
        }
        pos += want;
      }
      eq(outside, 0, "differing bytes outside lib/main.js");
      report.diff.positionalArchive = total;
      report.diff.diffRangeArchive = { from: regionStart, to: regionEnd };
    });

    // extra: compensation comment remains a valid, ASCII JSDoc block -------
    check("   compensation JSDoc is still well-formed", () => {
      const s = mainN.toString("latin1");
      const fnIdx = s.indexOf(COMPENSATION_FN);
      assert(fnIdx !== -1, "chromeFallbackFill() disappeared");
      const start = s.lastIndexOf("/**", fnIdx);
      const end = s.indexOf("*/", start) + 2;
      assert(start !== -1 && end > start && end <= fnIdx, "JSDoc block malformed after trimming");
      const body = s.slice(start, end);
      assert(body.slice(0, -2).indexOf("*/") === -1, "premature */ inside the trimmed JSDoc");
      assert(/^[\x00-\x7f]*$/.test(body), "trimmed JSDoc is not ASCII");
    });
  } finally {
    fs.closeSync(fdO);
    fs.closeSync(fdN);
  }

  if (failures.length > 0) {
    throw new AssertionError(
      `self-verification failed (${failures.length} check(s)):\n  - ${failures.join("\n  - ")}`,
    );
  }
  return report;
}

/* ------------------------------------------------------------------ */
/* sidecar / backup                                                    */
/* ------------------------------------------------------------------ */

function sidecarPaths(asar) {
  return { backup: asar + BACKUP_SUFFIX, sidecar: asar + SIDECAR_SUFFIX };
}

function readSidecar(asar) {
  const { sidecar } = sidecarPaths(asar);
  if (!fs.existsSync(sidecar)) return null;
  try {
    return JSON.parse(fs.readFileSync(sidecar, "utf8"));
  } catch (err) {
    throw new AssertionError(`sidecar ${sidecar} is not valid JSON: ${err.message}`);
  }
}

function readSidecarSafe(asar) {
  try {
    return readSidecar(asar);
  } catch (err) {
    log.warn(`sidecar unreadable: ${err.message}`);
    return null;
  }
}

function writeSidecar(asar, data) {
  const { sidecar } = sidecarPaths(asar);
  const tmp = `${sidecar}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, sidecar);
}

/* ------------------------------------------------------------------ */
/* inspection / status                                                 */
/* ------------------------------------------------------------------ */

function inspectArchive(asar) {
  const st = fs.statSync(asar);
  const fd = fs.openSync(asar, "r");
  try {
    const h = readHeader(fd);
    const mainEntry = entryForPath(h.json, MAIN_JS);
    assert(mainEntry, `${MAIN_JS} not found in ${asar}`);
    const main = readEntry(fd, h.dataStart, mainEntry);
    const s = main.toString("latin1");
    const sidecar = readSidecarSafe(asar);
    const candidates = [sidecar?.insertedOptions, DEFAULT_OPTIONS].filter(Boolean);
    let marker = null;
    for (const opt of candidates) {
      const hits = findAll(s, "show," + opt);
      if (hits.length === 1) {
        marker = { options: opt, offset: hits[0] };
        break;
      }
    }
    return {
      size: st.size,
      mtime: st.mtime,
      header: h,
      entries: walkNodes(h.json).length,
      mainSize: mainEntry.size,
      mainOffset: Number(mainEntry.offset),
      marker,
      backgroundMaterialCount: countOccurrences(s, 'backgroundMaterial:"'),
      anchorCount: countOccurrences(s, ANCHOR),
      fnCount: countOccurrences(s, COMPENSATION_FN),
      sidecar,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function printArchiveSummary(info) {
  log.info(`size          ${bytes(info.size)}`);
  log.info(`mtime         ${info.mtime.toISOString()}`);
  log.info(`header        jsonLength ${info.header.jsonLength.toLocaleString("en-US")}, dataStart ${info.header.dataStart.toLocaleString("en-US")}`);
  log.info(`entries       ${info.entries.toLocaleString("en-US")}`);
  log.info(`lib/main.js   offset ${info.mainOffset.toLocaleString("en-US")}, size ${info.mainSize.toLocaleString("en-US")}`);
}

function stateOf(info) {
  if (info.marker) return "enabled";
  if (info.backgroundMaterialCount > 0) return "unknown-marker";
  if (info.anchorCount === 1 && info.fnCount === 1) return "disabled";
  if (info.anchorCount === 0 || info.fnCount === 0) return "unrecognized";
  return "disabled";
}

/* ------------------------------------------------------------------ */
/* commands                                                            */
/* ------------------------------------------------------------------ */

function cmdStatus(args) {
  const asar = args.asar;
  log.head("status");
  log.info(`archive       ${asar}`);
  assert(fs.existsSync(asar), `archive not found: ${asar}`);
  const info = inspectArchive(asar);
  printArchiveSummary(info);

  const state = stateOf(info);
  const colored =
    state === "enabled" ? C.green("enabled") : state === "disabled" ? C.dim("disabled") : C.yellow(state);
  log.step("state");
  console.log(`     ${C.bold(colored)}`);
  if (info.marker) {
    log.info(`marker        show,${info.marker.options}`);
    log.info(`              at lib/main.js +${info.marker.offset}`);
  }
  if (state === "unknown-marker") {
    log.warn(`found ${info.backgroundMaterialCount} backgroundMaterial: occurrence(s) that do not match a known marker — run \`disable\` to restore`);
  }
  if (state === "unrecognized") {
    log.warn("expected anchors were not found — this may be a different build");
  }

  const { backup, sidecar } = sidecarPaths(asar);
  log.step("files");
  if (fs.existsSync(backup)) {
    log.info(`backup        ${backup}`);
    log.info(`              ${bytes(fs.statSync(backup).size)}`);
  } else {
    log.info(`backup        ${C.dim("(none)")}`);
  }
  if (info.sidecar) {
    log.info(`sidecar       ${sidecar}`);
    log.info(`              original sha256 ${info.sidecar.originalSha256}`);
    log.info(`              original size   ${bytes(Number(info.sidecar.originalSize))}`);
    log.info(`              options         ${info.sidecar.insertedOptions}`);
    log.info(`              patched at      ${info.sidecar.timestamp}`);
  } else {
    log.info(`sidecar       ${C.dim("(none)")}`);
  }

  log.step("sha256");
  log.info(`current       ${sha256File(asar)}`);
  if (info.sidecar && fs.existsSync(backup)) log.info(`backup        ${sha256File(backup)}`);

  if (state === "enabled") {
    console.log("\nNext: fully quit and restart the DSH desktop app for the glass window to take effect.");
  } else if (state === "disabled") {
    console.log("\nNext: `node tools/dsh-glass-desktop.mjs enable` to patch (restart the app afterwards).");
  }
}

function cmdEnable(args) {
  const asar = args.asar;
  log.head("enable");
  log.info(`archive       ${asar}`);
  assert(fs.existsSync(asar), `archive not found: ${asar}`);

  const options = args.options;
  const n = validateOptions(options);
  log.ok("options validated (ASCII, ends with \",\", no \"*/\", no backtick, no \";\" or \"}\")");
  log.info(`options       ${options}`);
  log.info(`insert length ${bytes(n)}`);

  const info = inspectArchive(asar);
  printArchiveSummary(info);

  // --- idempotency -----------------------------------------------------
  if (info.marker) {
    if (info.marker.options === options) {
      log.head("already-enabled");
      log.ok("the requested marker is already present — nothing to do");
      log.info(`state         enabled (${info.marker.options})`);
      return;
    }
    die(
      `already enabled with different options\n` +
        `      found:   ${info.marker.options}\n` +
        `      wanted:  ${options}\n` +
        `    run \`disable\` first, then \`enable\` again`,
    );
  }
  if (info.backgroundMaterialCount > 0) {
    die(
      `found ${info.backgroundMaterialCount} pre-existing backgroundMaterial: occurrence(s) — the archive is not in a pristine state; run \`disable\` first`,
    );
  }
  assert(info.anchorCount === 1, `the anchor must occur exactly once in ${MAIN_JS} (found ${info.anchorCount})`);
  assert(info.fnCount === 1, `"${COMPENSATION_FN}" must occur exactly once in ${MAIN_JS} (found ${info.fnCount})`);

  // --- build the patch (pure, no writes yet) ---------------------------
  log.step("building the length-preserving patch inside lib/main.js");
  let oldMain;
  {
    const fd = fs.openSync(asar, "r");
    try {
      oldMain = readEntry(fd, info.header.dataStart, entryForPath(info.header.json, MAIN_JS));
    } finally {
      fs.closeSync(fd);
    }
  }
  const { buf: newMain, info: pinfo } = buildPatchedMain(oldMain, options);
  log.ok(`lib/main.js   ${bytes(oldMain.length)} in, ${bytes(newMain.length)} out (unchanged)`);
  log.ok(`delete site   lib/main.js +${pinfo.delStartAbs} (JSDoc prose above chromeFallbackFill)`);
  log.ok(`insert site   lib/main.js +${pinfo.insertPos} (BrowserWindow options, after show,)`);

  // --- backup + sidecar (only when there is none yet) ------------------
  // Done AFTER the patch is known to be constructible, so a rejected
  // --options leaves no stray backup/sidecar behind.
  const { backup, sidecar } = sidecarPaths(asar);
  const originalSha = sha256File(asar);
  if (!fs.existsSync(backup)) {
    log.step("writing backup + sidecar (first enable)");
    const tmpB = `${backup}.tmp-${process.pid}`;
    fs.copyFileSync(asar, tmpB);
    const fdB = fs.openSync(tmpB, "r+");
    fs.fsyncSync(fdB);
    fs.closeSync(fdB);
    eq(sha256File(tmpB), originalSha, "backup sha256");
    fs.renameSync(tmpB, backup);
    writeSidecar(asar, {
      tool: "dsh-glass-desktop",
      version: TOOL_VERSION,
      asarPath: asar,
      originalSha256: originalSha,
      originalSize: fs.statSync(asar).size,
      insertedOptions: options,
      insertedBytes: n,
      timestamp: new Date().toISOString(),
    });
    log.ok(`backup        ${backup}`);
    log.ok(`sidecar       ${sidecar}`);
  } else {
    log.step("backup already exists — reusing it (never overwritten)");
    log.info(`backup        ${backup}`);
    const sc = info.sidecar;
    assert(sc, "a backup exists but its sidecar is missing — refusing to guess the original sha256");
    eq(sha256File(backup), sc.originalSha256, "existing backup sha256 vs sidecar");
    log.ok("existing backup matches the sidecar sha256");
  }

  log.plain("");
  log.plain(C.dim("  JSDoc above chromeFallbackFill() — before:"));
  for (const line of pinfo.beforeBlock.split("\n")) log.plain(`    ${line}`);
  log.plain(C.dim("  JSDoc above chromeFallbackFill() — after:"));
  for (const line of pinfo.afterBlock.split("\n")) log.plain(`    ${line}`);
  if (pinfo.boundary) {
    log.info(`deleted span  lib/main.js +${pinfo.delStartAbs}..+${pinfo.delEndAbs} (${bytes(pinfo.boundary.delEnd - pinfo.boundary.delStart)})`);
    log.info(`removed text  ${JSON.stringify(pinfo.boundary.removedText)}`);
  }
  log.plain("");

  // --- write temp, verify, atomically replace --------------------------
  const tmp = `${asar}.dsh-glass.tmp-${process.pid}`;
  let report;
  /** Whether the temp file became the target; governs cleanup on failure. */
  let replaced = false;
  /** Whether to keep the verified temp file for a manual move (locked target). */
  let keepTemp = false;
  log.step("writing the patched archive to a temp file (fsync)");
  try {
    writePatchedCopy(asar, tmp, info.header.dataStart, entryForPath(info.header.json, MAIN_JS), newMain);
    log.ok(`temp written: ${tmp}`);

    log.step("self-verification against the temp file (before replacing the target)");
    report = verifyPatched({
      originalPath: asar,
      patchedPath: tmp,
      edit: {
        options,
        n,
        delStartAbs: pinfo.delStartAbs,
        delEndAbs: pinfo.delEndAbs,
        insertPos: pinfo.insertPos,
        markerOffset: pinfo.markerOffset,
      },
    });

    log.step("atomically replacing the target");
    try {
      fs.renameSync(tmp, asar);
      replaced = true;
    } catch (err) {
      if (err && (err.code === "EPERM" || err.code === "EBUSY" || err.code === "EACCES")) {
        // Leave the verified temp file in place: it is a complete, correct
        // archive, so the user can move it over the target once the app quits
        // instead of paying for another full 180 MB write.
        keepTemp = true;
        throw new Error(
          `the archive is locked by a running process, so nothing was replaced (${err.code}).\n` +
            `  Your current archive is untouched and still matches the backup.\n` +
            `  A fully verified patched copy has been kept at:\n    ${tmp}\n` +
            `  Quit DeepSeek Harness completely (tray icon included), then run\n` +
            `  \`enable\` again — or move that file over the archive yourself.`,
        );
      }
      throw err;
    }
    log.ok(`patched: ${asar}`);
  } finally {
    if (!keepTemp) {
      try {
        if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
      } catch {}
    }
  }

  // --- post-rename sanity ---------------------------------------------
  const after = inspectArchive(asar);
  eq(after.size, info.size, "post-rename archive size");
  assert(after.marker && after.marker.options === options, "post-rename marker check failed");

  const d = report.diff;
  log.head("diff summary");
  log.info(`common prefix          ${bytes(d.commonPrefix)}`);
  log.info(`common suffix          ${bytes(d.commonSuffix)}`);
  log.info(`changed window         ${bytes(d.windowBytes)} (lib/main.js +${d.windowStart} .. +${d.windowEnd})`);
  log.info(`deleted                ${bytes(d.deleted)}  at lib/main.js +${d.deleteSiteInMain}`);
  log.info(`inserted               ${bytes(d.inserted)}  at lib/main.js +${d.insertSiteInMain}`);
  log.info(`both edit sites inside ${MAIN_JS}: yes`);
  log.info(`net size change        0 bytes`);
  log.info(`positional byte diff   ${d.positional.toLocaleString("en-US")} in lib/main.js, ${d.positionalArchive.toLocaleString("en-US")} archive-wide`);
  log.info(`(positional diff exceeds N because the two edit sites are ${d.windowBytes - n} bytes apart:`);
  log.info(` bytes between them shift by N; the edit script is still 1 delete + 1 insert of N)`);
  log.info(`payload entries hashed ${report.payloadEntries.toLocaleString("en-US")} (all but lib/main.js identical)`);

  log.head("done — enable");
  log.ok(`state         enabled`);
  log.info(`options       ${options}`);
  log.info(`sha256        ${sha256File(asar)}`);
  log.info(`size          ${bytes(after.size)} (unchanged)`);
  console.log("\nRestart the DSH desktop app (fully quit, then relaunch) to see the glass window.");
  console.log("Undo any time with: node tools/dsh-glass-desktop.mjs disable");
}

function cmdDisable(args) {
  const asar = args.asar;
  log.head("disable");
  log.info(`archive       ${asar}`);
  assert(fs.existsSync(asar), `archive not found: ${asar}`);

  const { backup, sidecar } = sidecarPaths(asar);
  assert(
    fs.existsSync(backup),
    `no backup found at ${backup} — cannot restore.\n    Without a backup the original archive must be restored by reinstalling DSH.`,
  );
  const sc = readSidecar(asar);
  assert(sc, `sidecar ${sidecar} is missing — cannot verify the backup sha256`);

  log.step("verifying the backup against the sidecar");
  log.info(`expected  ${sc.originalSha256}`);
  log.info(`backup    ${sha256File(backup)}`);
  eq(sha256File(backup), sc.originalSha256, "backup sha256");
  eq(fs.statSync(backup).size, Number(sc.originalSize), "backup size");
  log.ok("backup matches the recorded original");

  const currentSha = sha256File(asar);
  if (currentSha === sc.originalSha256) {
    log.head("already-disabled");
    log.ok("the archive already equals the original backup — nothing to do");
    if (args.purgeBackup) {
      fs.rmSync(backup, { force: true });
      fs.rmSync(sidecar, { force: true });
      log.ok("purged backup + sidecar");
    }
    return;
  }

  const tmp = `${asar}.dsh-glass.tmp-${process.pid}`;
  log.step("restoring from backup via temp file (fsync) + atomic rename");
  try {
    fs.copyFileSync(backup, tmp);
    const fd = fs.openSync(tmp, "r+");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    eq(sha256File(tmp), sc.originalSha256, "restored temp sha256");
    log.ok("temp copy verified against the sidecar sha256");
    try {
      fs.renameSync(tmp, asar);
    } catch (err) {
      if (err && (err.code === "EPERM" || err.code === "EBUSY" || err.code === "EACCES")) {
        throw new Error(
          `the archive is locked by a running process, so it was NOT restored (${err.code}).\n` +
            `  Your archive is unchanged and still contains the patch.\n` +
            `  Quit DeepSeek Harness completely (tray icon included) and run \`disable\` again.\n` +
            `  The verified original is kept at:\n    ${backup}\n` +
            `  so you can also copy it over the archive yourself.`,
        );
      }
      throw err;
    }
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
    } catch {}
    throw err;
  }

  eq(sha256File(asar), sc.originalSha256, "restored archive sha256");
  const info = inspectArchive(asar);
  eq(info.size, Number(sc.originalSize), "restored archive size");
  assert(!info.marker, "the restored archive still contains the marker");

  log.head("done — disable");
  log.ok("state         disabled (pristine bytes restored)");
  log.info(`sha256        ${sc.originalSha256}`);
  log.info(`size          ${bytes(info.size)}`);

  if (args.purgeBackup) {
    fs.rmSync(backup, { force: true });
    fs.rmSync(sidecar, { force: true });
    log.ok("purged backup + sidecar (--purge-backup)");
  } else {
    log.info(`backup kept   ${backup}`);
    log.info(`sidecar kept  ${sidecar}`);
  }
  console.log("\nRestart the DSH desktop app (fully quit, then relaunch) for the change to apply.");
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command) {
    usage();
    process.exit(args.help ? 0 : 1);
  }
  try {
    switch (args.command) {
      case "status":
        cmdStatus(args);
        break;
      case "enable":
        cmdEnable(args);
        break;
      case "disable":
        cmdDisable(args);
        break;
      default:
        die(`unknown command: ${args.command}\n\nRun with --help for usage.`);
    }
  } catch (err) {
    if (err instanceof AssertionError) {
      console.error(`\n${C.red("FAILED:")} ${err.message}`);
      process.exit(2);
    }
    // Operational errors (locked file, missing backup) are written for a human
    // to act on. Printing their stack buries the instruction, so only show it
    // for unexpected exceptions where the stack is the actual information.
    const message = err && err.message ? String(err.message) : String(err)
    const expected = /locked by a running process|no backup|not in a pristine state|must occur exactly once|refusing/u.test(message)
    console.error(`\n${C.red("ERROR:")} ${message}`);
    if (!expected && err && err.stack) console.error(C.dim(err.stack))
    process.exit(1);
  }
}

main();

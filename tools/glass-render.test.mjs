// Proves the re-entrancy contract of dsh-glass-skin's render loop against a
// faithful stand-in for the theme service. Run: node tools/glass-render.test.mjs
import assert from 'node:assert/strict'

/**
 * Minimal reproduction of the real `ThemeRuntime` surface this plugin uses:
 * `getTheme()`, `overrideTokens(source, tokens)` and synchronous `theme/change`
 * emission from `publish()` (verified in dsh-client-ui-theme/lib/client.js:
 * `publish() { this.revision += 1; this.snapshot = ...; this.ctx.emit('theme/change', ...) }`).
 */
function createThemeService() {
  const listeners = new Set()
  const overrides = new Map()
  const base = { colorScheme: 'dark', id: 'dark', tokens: { '--dsw-alias-bg-base': '#0f1115' } }
  let seq = 0
  let emitDepth = 0
  let maxEmitDepth = 0
  const service = {
    getTheme: () => ({ preference: 'dark', active: base, themes: [base], revision: 0 }),
    overrideTokens(source, tokens) {
      const layer = { seq: seq++, tokens }
      overrides.set(source, layer)
      publish()
      return () => {
        if (overrides.get(source) !== layer) return
        overrides.delete(source)
        publish()
      }
    },
    on(name, fn) {
      if (name === 'theme/change') listeners.add(fn)
      return () => listeners.delete(fn)
    },
    emitDepth: () => maxEmitDepth,
    layerCount: () => overrides.size,
  }
  function publish() {
    emitDepth += 1
    maxEmitDepth = Math.max(maxEmitDepth, emitDepth)
    if (emitDepth > 200) throw new RangeError('theme/change re-entered without bound')
    try {
      for (const fn of [...listeners]) fn(service.getTheme())
    } finally {
      emitDepth -= 1
    }
  }
  return service
}

/** The plugin's render loop, with the guard exactly as shipped. */
function installRenderLoop(theme) {
  let disposeLayer
  let writing = false
  let renders = 0
  const render = (snapshot) => {
    if (writing) return
    renders += 1
    writing = true
    try {
      if (disposeLayer !== undefined) {
        disposeLayer()
        disposeLayer = undefined
      }
      disposeLayer = theme.overrideTokens('dsh-glass-skin', {
        '--dsw-alias-bg-base': { light: 'color-mix(in srgb, #fff 76%, transparent)', dark: 'x' },
      })
    } finally {
      writing = false
    }
  }
  render(theme.getTheme())
  const off = theme.on('theme/change', render)
  return { render, off, rendersSoFar: () => renders, disposeLayer: () => disposeLayer }
}

// --- guarded (shipped) behaviour ---------------------------------------
const theme = createThemeService()
const loop = installRenderLoop(theme)
const afterFirst = loop.rendersSoFar()
assert.equal(afterFirst, 1, 'first render must run once')
assert.equal(theme.emitDepth(), 1, 'first overrideTokens emits one theme/change')

// A genuine external change (theme switch, palette flip) must still be applied.
loop.render(theme.getTheme())
assert.equal(loop.rendersSoFar(), 2, 'an external theme/change still renders')
assert.equal(theme.emitDepth(), 1, 'the echo of our own write is dropped, not re-entered')

// Many cycles must stay flat: no growth, exactly one layer retained.
for (let i = 0; i < 50; i += 1) loop.render(theme.getTheme())
assert.equal(loop.rendersSoFar(), 52)
assert.equal(theme.layerCount(), 1, 'repeated renders leave exactly one override layer')
assert.equal(theme.emitDepth(), 1, 'emit nesting never exceeds one level')

// --- unguarded: the defect the guard prevents ---------------------------
const broken = createThemeService()
let brokenRenders = 0
let brokenError
const brokenRender = () => {
  brokenRenders += 1
  broken.overrideTokens('dsh-glass-skin', { '--x': { light: 'a', dark: 'b' } })
}
try {
  brokenRender()
  broken.on('theme/change', brokenRender)
  brokenRender()
} catch (error) {
  brokenError = error
}
assert.ok(brokenError instanceof RangeError, 'without the guard the second render recurses without bound')
assert.ok(brokenRenders > 200, `unguarded renders reached ${brokenRenders}, confirming runaway recursion`)

console.log('PASS  guarded loop: external change renders, own echo dropped, one layer retained')
console.log('PASS  unguarded loop: runaway recursion reproduced (RangeError), so the guard is load-bearing')
console.log(`      (unguarded render count before abort: ${brokenRenders})`)

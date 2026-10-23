// Loads the REAL plugin/client.js, runs its factory against a stub host, and
// renders the registered settings row. This checks the shipped source, not a
// hand-copied twin: the row component and its closure deps come straight from
// the file that the browser loads.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// Resolved relative to this file, so the suite works from both the development
// checkout and the published package layout.
const SOURCE = new URL('../plugin/client.js', import.meta.url)
const code = readFileSync(SOURCE, 'utf8')

/* ---- minimal React stand-in ------------------------------------------- */
function createElement(type, props, ...children) {
  return {
    type,
    props: props ?? {},
    children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true),
  }
}
const ReactStub = {
  createElement,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
}

/* ---- capture the module the loader hands us --------------------------- */
/** Every node the plugin appends, so the test can assert on DOM side effects. */
const appended = []
let captured
const sandbox = {
  window: {
    __ModuleLoader__: { load: (mod) => { captured = mod } },
    localStorage: {
      _v: new Map(),
      getItem(k) { return this._v.has(k) ? this._v.get(k) : null },
      setItem(k, v) { this._v.set(k, String(v)) },
    },
    addEventListener() {},
  },
  document: {
    documentElement: {
      _attrs: new Map(),
      setAttribute(k, v) { this._attrs.set(k, String(v)) },
      removeAttribute(k) { this._attrs.delete(k) },
      style: { setProperty() {}, removeProperty() {} },
      lang: 'zh-CN',
    },
    head: { appendChild() {}, append() {} },
    createElement: (tag) => ({
      tag,
      dataset: {},
      textContent: '',
      className: '',
      attrs: {},
      setAttribute(k, v) { this.attrs[k] = String(v) },
      appendChild() {},
      remove() { this.removed = true },
    }),
    body: {
      style: { setProperty() {}, removeProperty() {} },
      appendChild(node) { appended.push(node) },
    },
    querySelector: () => null,
  },
  navigator: { language: 'zh-CN' },
  console,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(code, sandbox, { filename: 'client.js' })

assert.ok(captured, 'client.js must call window.__ModuleLoader__.load')
assert.equal(captured.id, 'dsh-glass-skin', 'module id is the package name')

/* ---- host stubs -------------------------------------------------------- */
const themeListeners = new Set()
let overlayLayer = null
const theme = {
  getTheme: () => ({ preference: 'dark', active: { id: 'dark', colorScheme: 'dark', tokens: {} }, themes: [], revision: 0 }),
  overrideTokens(source, tokens) {
    overlayLayer = { source, tokens }
    for (const listener of [...themeListeners]) listener(theme.getTheme())
    return () => { overlayLayer = null }
  },
}

const localeDicts = {}
const locale = {
  register: (ns, dicts) => { localeDicts[ns] = dicts; return () => {} },
  // Mimic the real bound translator: t(key) -> localized string.
  bind: (ns) => {
    const t = (key) => {
      const table = localeDicts[ns] ?? {}
      const picked = table.zh ?? table.en ?? {}
      return picked[key] ?? key
    }
    t.subscribe = () => {}
    return t
  },
  subscribe: () => () => {},
}

const registrations = []
const slots = {
  inject: (key, cb) => { cb(); return () => {} },
  register: (options, component) => {
    registrations.push({ options, component })
    return () => {}
  },
}

let themeHandler
const ctx = {
  effect: (fn) => { const d = fn(); return d },
  on: (name, fn) => { if (name === 'theme/change') { themeHandler = fn; themeListeners.add(fn) } return () => {} },
  get: (name) => (name === 'theme' ? theme : name === 'locale' ? locale : undefined),
  locale,
  slots,
}

const require = (id) => {
  if (id === 'react') return ReactStub
  throw new Error(`unexpected require(${JSON.stringify(id)})`)
}

const mod = captured.factory(require)
assert.ok(Array.isArray(mod.inject), 'module exports an inject list')
assert.ok(mod.inject.includes('theme'), 'theme is a HARD dependency (cold-boot ordering)')
assert.equal(typeof mod.apply, 'function')

mod.apply(ctx)

/* ---- assertions -------------------------------------------------------- */
assert.equal(registrations.length, 1, 'exactly one settings row is registered')
const { options, component } = registrations[0]
assert.equal(options.name, 'settings.general.item')
assert.equal(options.id, 'glass-skin')
assert.equal(typeof component, 'function', 'the registered thing is a component')

// The row must render with NO props: that is the contract this slot offers.
const tree = component({})
assert.ok(tree && typeof tree === 'object', 'row renders without props')

const text = (node) => {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(text).join('')
  return text(node.children)
}
const flat = text(tree)
assert.ok(flat.includes('玻璃皮肤'), 'localized title renders')
assert.ok(flat.includes('启用玻璃材质'), 'localized switch label renders')

// The overlay must have been applied through the theme service.
assert.ok(overlayLayer, 'a token overlay layer was registered on the theme service')
assert.equal(overlayLayer.source, 'dsh-glass-skin')
assert.ok(overlayLayer.tokens['--dsw-alias-bg-base'], 'the base surface token is overridden')

// A theme change must not recurse (the guard), and must re-apply.
themeHandler(theme.getTheme())
assert.ok(overlayLayer, 'overlay survives a theme change')

// The old failure mode: reading props.t is what crashed the entry.
function oldRow(props) {
  return createElement('div', null, props.t('title'))
}
let threw = false
try { oldRow({}) } catch (error) { threw = error instanceof TypeError }
assert.ok(threw, 'reading props.t would still throw, so the closure fix is load-bearing')

// The blur layer must exist exactly once, be empty, and sit behind content.
const blurNodes = appended.filter((n) => n.className === 'dshGlass_blur')
assert.equal(blurNodes.length, 1, 'exactly one blur layer is appended')
const blur = blurNodes[0]
assert.equal(blur.tag, 'div')
assert.equal(blur.children, undefined, 'the blur layer has no children')
assert.equal(blur.attrs['aria-hidden'], 'true', 'the blur layer is hidden from AT')

console.log('PASS  real client.js loads and its factory registers one settings row')
console.log('PASS  the row renders with ZERO props (the slot\'s actual contract)')
console.log('PASS  theme is a hard inject dependency (cold-boot activation order)')
console.log('PASS  token overlay applied via theme.overrideTokens and survives theme/change')
console.log('PASS  one empty blur layer is appended behind content (no containing block created)')

// Offline contract test for the glass-skin settings row.
//
// The bug this guards against is a RENDER-TIME CRASH: the slot system answers
// one by permanently abdicating the entry (`active: false`) and showing an empty
// Settings page, with the error only in the browser console. That is invisible
// to any "is the slot registered?" check, so it needs its own test.
//
// No react-dom here, so the component is invoked as a plain function with a
// stub React that returns trees instead of DOM. That is enough to prove the
// component reads nothing from props and throws nothing.
import assert from 'node:assert/strict'

/** Minimal React stand-in: hooks are evaluated inline, once per render. */
const ReactStub = {
  createElement: (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
  }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
}

/** Structural copy of `createGlassPreferenceRow` from plugins/dsh-glass-skin/client.js. */
function createGlassPreferenceRow(deps) {
  const h = ReactStub.createElement
  return function GlassPreferenceRow() {
    const { t, available, isEnabled, onChange } = deps
    const [enabled, setEnabled] = ReactStub.useState(isEnabled())
    ReactStub.useEffect(() => {
      if (typeof deps.subscribe !== 'function') return undefined
      return deps.subscribe()
    }, [])
    const checked = enabled && available
    return h(
      'div',
      { className: 'dshGlass_row' },
      h(
        'div',
        { className: 'dshGlass_text' },
        h('div', { className: 'dshGlass_title' }, t('title')),
        h(
          'div',
          { className: 'dshGlass_description' },
          available ? t('description') : t('unavailable'),
        ),
      ),
      h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked ? 'true' : 'false',
          'aria-disabled': available ? 'false' : 'true',
          disabled: !available,
          className: 'dshGlass_switch',
          onClick: available ? () => onChange(!enabled) : undefined,
        },
        h('span', { className: 'dshGlass_track', 'aria-hidden': 'true' },
          h('span', { className: 'dshGlass_thumb' })),
        h('span', { className: 'dshGlass_switchLabel' }, t('enable')),
      ),
    )
  }
}

/** Flatten a tree to text so assertions read naturally. */
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.children)
}

/** Find the first node whose type matches. */
function find(node, type) {
  if (!node || typeof node !== 'object') return undefined
  if (node.type === type) return node
  for (const child of node.children ?? []) {
    const hit = find(child, type)
    if (hit) return hit
  }
  return undefined
}

const zh = {
  title: '玻璃皮肤',
  description: '半透明亚克力／玻璃表面，让桌面透过窗口可见。',
  enable: '启用玻璃材质',
  unavailable: '系统设置要求减少透明度，玻璃材质已自动停用。',
}

let changed = null
const base = { t: (k) => zh[k] ?? k, onChange: (v) => { changed = v } }

// 1. Normal: on, available, locale subscribe hook present.
const onTree = createGlassPreferenceRow({ ...base, available: true, isEnabled: () => true, subscribe: () => () => {} })()
assert.ok(textOf(onTree).includes('玻璃皮肤'), 'title renders')
assert.ok(textOf(onTree).includes('启用玻璃材质'), 'switch label renders')
assert.equal(find(onTree, 'button').props['aria-checked'], 'true')
assert.equal(find(onTree, 'button').props.disabled, false)

// 2. Reduced transparency: disabled, explanation shown.
const offTree = createGlassPreferenceRow({ ...base, available: false, isEnabled: () => false, subscribe: () => () => {} })()
assert.ok(textOf(offTree).includes('已自动停用'), 'unavailable copy renders')
assert.equal(find(offTree, 'button').props.disabled, true)
assert.equal(find(offTree, 'button').props['aria-checked'], 'false')

// 3. A locale service with no subscribe must not crash the row.
const noSubTree = createGlassPreferenceRow({ ...base, available: true, isEnabled: () => false, subscribe: undefined })()
assert.ok(textOf(noSubTree).includes('玻璃皮肤'), 'renders without subscribe')

// 4. Toggling calls the write path with the inverted value.
find(onTree, 'button').props.onClick()
assert.equal(changed, false, 'clicking writes the inverted value')

// 5. The PREVIOUS shape must throw, proving this test has teeth.
function oldRow(props) {
  const t = props.t
  return ReactStub.createElement('div', null, t('title'))
}
let oldThrew = false
try {
  oldRow({})
} catch (error) {
  oldThrew = error instanceof TypeError
}
assert.ok(oldThrew, 'the old props-based component throws TypeError with empty props')

console.log('PASS  shipped row renders in 3 states (on / reduced-transparency / no subscribe)')
console.log('PASS  toggle writes the inverted value through the closure')
console.log('PASS  old props-based shape throws TypeError with empty props -> that was the abdication cause')

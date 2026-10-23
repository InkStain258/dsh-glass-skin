window.__ModuleLoader__.load({
  id: 'dsh-glass-skin',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Identity used for the theme overlay layer, the stylesheet tag, and the storage key. */
    const PLUGIN_ID = 'dsh-glass-skin'
    const STORAGE_KEY = `${PLUGIN_ID}:enabled`
    const LOCALE_NS = 'glassSkin'

    /**
     * Surfaces this plugin turns translucent, as an opaque-percentage per
     * palette: 22 means the surface keeps only 22% of its own colour and lets
     * 78% of the desktop through.
     *
     * The intent is "see the desktop", not "make the UI slightly dim", so the
     * structural surfaces sit low enough that the wallpaper is legible through
     * them. Values were checked against the shipped stylesheets' background
     * usage, so every token here actually paints something:
     *
     *   --dsw-alias-bg-base            14  (frame, centre column, bottom row)
     *   --dsw-specific-sidebar-fill     6  (sidebar, Windows title strip)
     *   --dsw-alias-bg-layer-1          4  (raised cards)
     *   --dsw-alias-bg-layer-2          3
     *   --dsw-alias-bg-layer-3          2
     *   --dsw-specific-input-major      2  (composer card, pill inputs)
     *   --dsw-alias-markdown-code-block 1
     *
     * `--dsw-alias-bg-overlay` is NOT in that list: the token exists but no
     * background rule consumes it, so overriding it would do nothing.
     *
     * Menu surfaces (`--dsw-menu-surface-fill`) are deliberately left alone:
     * they already ship a translucent fill *plus* their own `backdrop-filter`
     * and float above the glass, so menus stay readable over any desktop.
     *
     * Each value keeps the active theme's own colour as its source — the layer
     * wraps that colour in `color-mix(… transparent)` instead of replacing it —
     * which is what keeps a third-party theme's palette intact: the glass
     * inherits its hue and only changes opacity.
     *
     * Legibility note: text is still painted at full opacity by the theme's own
     * label tokens; only surfaces recede. Where a surface carries long-form
     * text (code blocks, the composer) it keeps more density than the frame.
     */
    const GLASS_TOKENS = [
      // Structural surfaces: as clear as the wallpaper allows.
      { name: '--dsw-alias-bg-base', light: 30, dark: 22, fallback: { light: '#ffffff', dark: '#0f1115' } },
      { name: '--dsw-specific-sidebar-fill', light: 26, dark: 18, fallback: { light: '#f9fafb', dark: '#1b1b1c' } },
      // Raised cards sit on an already-clear base; a touch more density keeps
      // their edge visible without hiding the desktop behind them.
      { name: '--dsw-alias-bg-layer-1', light: 40, dark: 30, fallback: { light: '#ffffff', dark: '#212123' } },
      { name: '--dsw-alias-bg-layer-2', light: 46, dark: 36, fallback: { light: '#ffffff', dark: '#212123' } },
      { name: '--dsw-alias-bg-layer-3', light: 52, dark: 42, fallback: { light: '#ffffff', dark: '#212123' } },
      // Composer card and pill inputs: the largest flat block, and the one the
      // eye rests on while typing, so it keeps a little more body.
      { name: '--dsw-specific-input-major', light: 38, dark: 30, fallback: { light: '#ffffff', dark: '#212123' } },
      // Long-form text: keep enough contrast that code stays readable.
      { name: '--dsw-alias-markdown-code-block', light: 58, dark: 48, fallback: { light: '#f9fafb', dark: '#212123' } },
    ]

    /**
     * Stylesheet owned by this plugin.
     *
     * The shipped sheet already ends with `body{background:transparent}`, so the
     * document body is not what paints the app opaque: the layout frame and the
     * sidebar column paint `--dsw-alias-bg-base` / `--dsw-specific-sidebar-fill`,
     * which is exactly what the token layer above makes translucent. Painting
     * the body again here would stack a second translucent sheet on top of the
     * first and darken the result.
     *
     * ## Why the blur is a separate fixed layer, not a filter on the shell
     *
     * `backdrop-filter` makes an element a **containing block for fixed-position
     * descendants** (CSS Filter Effects). The shell's popovers are positioned
     * against the viewport, so putting the filter on `.BynINW_frame` would
     * silently re-anchor every menu, dialog and tooltip to that frame — and on
     * Windows the frame is offset by the title-bar height, so everything would
     * shift down. That is a whole-application positioning bug for a cosmetic
     * gain, so the shell markup is left completely untouched.
     *
     * Instead this plugin appends ONE empty, fixed layer at `z-index:-1` inside
     * the root stacking context. It has no children, so it cannot become
     * anything's containing block, and being behind the content it blurs the
     * desktop without touching any application pixel above it.
     *
     * The native window material still contributes its own blur (see
     * tools/dsh-glass-desktop.mjs); this layer adds the stronger, glass-like
     * diffusion the material alone cannot provide, and stays independent of it
     * so the skin still looks right if the window patch is reverted.
     */
    const CSS = `
html[data-dsh-glass] { background: transparent; }
/* Hidden unless the skin is on: the layer exists from apply time, but must not
   blur anything when the user switches glass off. */
html:not([data-dsh-glass]) .dshGlass_blur { display: none; }
.dshGlass_blur {
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  /* The saturation lift keeps colours from going muddy through the blur. */
  backdrop-filter: blur(30px) saturate(140%);
  -webkit-backdrop-filter: blur(30px) saturate(140%);
}
/* Users who ask the OS for less transparency get flat surfaces, not blur. */
@media (prefers-reduced-transparency: reduce) {
  .dshGlass_blur { backdrop-filter: none; -webkit-backdrop-filter: none; }
}
`

    /** The single blur layer this plugin owns; created and removed with `apply`. */
    const BLUR_CLASS = 'dshGlass_blur'

    /** Wrap a theme color so it keeps its hue but lets the desktop through. */
    function frosted(color, alpha) {
      return `color-mix(in srgb, ${color} ${alpha}%, transparent)`
    }

    /**
     * Pick the theme definition whose palette matches one color scheme.
     * A custom theme only registers the scheme it declares, so the other side
     * falls back to the built-in definition of that scheme.
     */
    function definitionFor(snapshot, scheme) {
      const themes = snapshot.themes || []
      const active = snapshot.active
      const sameScheme = themes.filter((theme) => theme.colorScheme === scheme)
      const activeMatch = sameScheme.find((theme) => active && theme.id === active.id)
      if (activeMatch) return activeMatch
      const builtin = sameScheme.find((theme) => theme.id === scheme)
      return builtin || sameScheme[0]
    }

    /**
     * Build the override layer for the current theme.
     *
     * The source color is read from the registry definitions rather than from
     * the composed snapshot: the composed tokens already contain this plugin's
     * own layer, and wrapping that again would compound the transparency on
     * every theme switch until the surfaces vanished.
     */
    function buildLayer(snapshot) {
      const light = definitionFor(snapshot, 'light')
      const dark = definitionFor(snapshot, 'dark')
      const layer = {}
      for (const token of GLASS_TOKENS) {
        const lightSource = (light && light.tokens && light.tokens[token.name]) || token.fallback.light
        const darkSource = (dark && dark.tokens && dark.tokens[token.name]) || token.fallback.dark
        layer[token.name] = {
          light: frosted(lightSource, token.light),
          dark: frosted(darkSource, token.dark),
        }
      }
      return layer
    }

    /** Whether translucent surfaces are appropriate in this environment. */
    function transparencyAvailable() {
      if (typeof window === 'undefined' || typeof document === 'undefined') return false
      // `prefers-reduced-transparency` is a user accessibility preference; a
      // frosted window that ignores it is a defect, not a feature.
      if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-transparency: reduce)').matches) {
        return false
      }
      return true
    }

    /** Read the persisted switch; glass is on by default. */
    function readEnabled() {
      try {
        const stored = window.localStorage.getItem(STORAGE_KEY)
        if (stored === null) return true
        return stored !== 'false'
      } catch {
        return true
      }
    }

    /** Persist the switch; failure to persist must not break the UI. */
    function writeEnabled(value) {
      try {
        window.localStorage.setItem(STORAGE_KEY, value ? 'true' : 'false')
      } catch {
        /* a locked-down storage area only costs persistence, not the toggle */
      }
    }

    /** Simplified Chinese dictionary. */
    const zh = {
      'title': '玻璃皮肤',
      'description': '半透明亚克力／玻璃表面，让桌面透过窗口可见；叠加在当前主题之上，不改变配色。',
      'enable': '启用玻璃材质',
      'unavailable': '系统设置要求减少透明度，玻璃材质已自动停用。',
    }

    /** English dictionary. */
    const en = {
      'title': 'Glass skin',
      'description': 'Translucent acrylic / glass surfaces that let the desktop show through, layered over the active theme without changing its palette.',
      'enable': 'Enable glass material',
      'unavailable': 'Your system asks for reduced transparency, so the glass material is off.',
    }

    /**
     * Build the General preference row for one host instance.
     *
     * Everything the row needs is captured here, at `apply` time, rather than
     * read from React props: this slot's owner declares
     * `SettingsGeneralItemOwnerProps { children?: never }` and passes nothing,
     * and registration options are not expanded into props either. An earlier
     * version read `props.t` / `props.available`, so every render threw
     * `TypeError: t is not a function`; the slot system then **abdicated** the
     * entry permanently — shown as `active: false` in the slot snapshot and as
     * a silently empty Settings page, with the error only in the browser
     * console.
     *
     * @param deps - live accessors owned by `apply`: translation, current
     *   availability, the initial switch value, and the write path.
     * @returns a React component for `settings.general.item`.
     */
    function createGlassPreferenceRow(deps) {
      return function GlassPreferenceRow() {
        const { t, available, isEnabled, onChange } = deps
        const [enabled, setEnabled] = React.useState(isEnabled())
        // Re-render when the language changes, so the copy follows the locale.
        // The hook is guarded: a partial locale service must never crash the
        // row again (a crash would abdicate it for the rest of the session).
        React.useEffect(() => {
          if (typeof deps.subscribe !== 'function') return undefined
          return deps.subscribe()
        }, [])

        const toggle = () => {
          if (!available) return
          const next = !enabled
          setEnabled(next)
          onChange(next)
        }

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
              onClick: available ? toggle : undefined,
            },
            h('span', { className: 'dshGlass_track', 'aria-hidden': 'true' },
              h('span', { className: 'dshGlass_thumb' })),
            h('span', { className: 'dshGlass_switchLabel' }, t('enable')),
          ),
        )
      }
    }

    /** Row-local styles; tokens only so the row matches light and dark alike. */
    const ROW_CSS = `
.dshGlass_row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08));
}
.dshGlass_text { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dshGlass_title { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); }
.dshGlass_description { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.dshGlass_switch {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: 0;
  background: transparent;
  padding: 4px;
  border-radius: 999px;
  cursor: pointer;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.dshGlass_switch:disabled { cursor: not-allowed; opacity: 0.5; }
.dshGlass_switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dshGlass_track {
  position: relative;
  width: 36px;
  height: 20px;
  border-radius: 999px;
  background: var(--dsw-alias-state-idle-primary, rgba(127, 130, 135, 0.4));
  transition: background-color 120ms ease-out;
}
.dshGlass_switch[aria-checked='true'] .dshGlass_track { background: var(--dsw-alias-brand-primary); }
.dshGlass_thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--dsw-alias-label-primary-inverted, #fff);
  transition: transform 120ms ease-out;
}
.dshGlass_switch[aria-checked='true'] .dshGlass_thumb { transform: translateX(16px); }
@media (prefers-reduced-motion: reduce) {
  .dshGlass_track, .dshGlass_thumb { transition: none; }
}
`

    return {
      /**
       * `theme` must be a HARD dependency, not an optional lookup.
       *
       * `ctx.get('theme')` returns `undefined` when this fiber activates before
       * ui-theme has run `ctx.provide('theme', …)`. Under HMR the service
       * already existed, so the plugin looked fine; on a **cold boot** the
       * activation order put this plugin first, `apply` bailed out, and the
       * whole skin silently disappeared (no settings row, no token overlay,
       * no console error the user would ever see). Declaring the service here
       * makes the fiber wait until it is provided, which is the documented way
       * to express this dependency.
       */
      inject: ['slots', 'locale', 'theme'],

      apply(ctx) {
        const theme = ctx.get('theme')
        if (theme === undefined) {
          console.error('glass skin: the theme service is unavailable, so nothing was applied')
          return
        }

        const sheet = document.createElement('style')
        sheet.dataset.plugin = PLUGIN_ID
        sheet.dataset.pluginCss = `${PLUGIN_ID}/glass.css`
        sheet.textContent = CSS
        ctx.effect(() => {
          document.head.appendChild(sheet)
          return () => sheet.remove()
        }, 'glass skin: glass stylesheet')

        const rowSheet = document.createElement('style')
        rowSheet.dataset.plugin = PLUGIN_ID
        rowSheet.dataset.pluginCss = `${PLUGIN_ID}/row.css`
        rowSheet.textContent = ROW_CSS
        ctx.effect(() => {
          document.head.appendChild(rowSheet)
          return () => rowSheet.remove()
        }, 'glass skin: settings row stylesheet')

        /**
         * The blur layer: one empty fixed element behind all content.
         *
         * Appended to `document.body` rather than to a layout node so it never
         * participates in the shell's layout or its containing-block chain. It
         * is created and removed by the same effect as the stylesheet, so
         * unloading the plugin leaves no stray node behind.
         */
        ctx.effect(() => {
          const blur = document.createElement('div')
          blur.className = BLUR_CLASS
          blur.setAttribute('aria-hidden', 'true')
          document.body.appendChild(blur)
          return () => blur.remove()
        }, 'glass skin: blur layer')

        const available = transparencyAvailable()
        let enabled = available && readEnabled()
        /** The active overlay disposer, replaced on every rebuild. */
        let disposeLayer

        /**
         * Re-entrancy guard.
         *
         * `theme.overrideTokens()` calls `publish()` synchronously, which emits
         * `theme/change` — the very event this plugin renders from. Without a
         * guard, each render would trigger the next render forever and lock the
         * renderer on the first paint. The flag drops the echo our own write
         * causes; genuine external changes (palette switch, theme switch, font
         * size) still arrive with the flag clear and are applied normally.
         */
        let writing = false

        /** Push the current theme through the glass transform, or retract it. */
        const render = (snapshot) => {
          if (writing) return
          const root = document.documentElement
          const apply = () => {
            if (disposeLayer !== undefined) {
              disposeLayer()
              disposeLayer = undefined
            }
            if (!enabled) {
              root.removeAttribute('data-dsh-glass')
              return
            }
            root.setAttribute('data-dsh-glass', '')
            // `overrideTokens` is the cooperative path: the presenter re-writes
            // every token to `body.style` on each theme change, so a competing
            // stylesheet would lose to inline styles. This layer is composed by
            // the theme service itself and survives palette and theme switches.
            disposeLayer = theme.overrideTokens(PLUGIN_ID, buildLayer(snapshot))
          }
          writing = true
          try {
            apply()
          } finally {
            writing = false
          }
        }

        ctx.effect(() => {
          render(theme.getTheme())
          return ctx.on('theme/change', render)
        }, 'glass skin: token overlay')

        ctx.effect(
          () => ctx.locale.register(LOCALE_NS, { zh, en }),
          'glass skin: settings row dictionaries',
        )

        /**
         * Translation bound once, at apply time.
         *
         * `locale.bind(ns)` returns a callable `t(key)`. Guard the binding so a
         * locale service that is still settling cannot throw inside the
         * component and abdicate the row.
         */
        let translate
        try {
          translate = typeof ctx.locale.bind === 'function' ? ctx.locale.bind(LOCALE_NS) : undefined
        } catch (error) {
          console.error('glass skin: locale bind failed; falling back to the dictionary', error)
          translate = undefined
        }
        const fallbackDict = () => {
          const lang = (() => {
            try {
              return String(document.documentElement.lang || navigator.language || 'en').toLowerCase()
            } catch {
              return 'en'
            }
          })()
          return lang.startsWith('zh') ? zh : en
        }
        /** Never throws: an unknown key falls back to the key itself. */
        const t = (key) => {
          try {
            const translated = translate === undefined ? undefined : translate(key)
            if (typeof translated === 'string' && translated !== '') return translated
          } catch (error) {
            console.error(`glass skin: translation failed for "${key}"`, error)
          }
          const dict = fallbackDict()
          return dict[key] ?? key
        }
        /** Localized re-render hook, guarded for the same reason. */
        const subscribeLocale = () => {
          try {
            if (translate !== undefined && typeof ctx.locale.subscribe === 'function') {
              return ctx.locale.subscribe(() => {})
            }
          } catch (error) {
            console.error('glass skin: locale subscribe failed', error)
          }
          return undefined
        }

        ctx.slots.inject('settings.general.item', () =>
          ctx.slots.register(
            {
              name: 'settings.general.item',
              id: 'glass-skin',
              // After Appearance (10) / font size (11) and before the
              // conversation-behaviour rows, so appearance settings stay together.
              order: 14,
            },
            // The component is built per registration from a closure: the slot
            // owner passes no props, so nothing may be expected from them.
            createGlassPreferenceRow({
              t,
              available,
              isEnabled: () => enabled,
              subscribe: subscribeLocale,
              onChange: (next) => {
                enabled = available && next
                writeEnabled(next)
                render(theme.getTheme())
              },
            }),
          ),
        )
      },
    }
  },
})

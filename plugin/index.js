/**
 * Host half of the dsh-glass-skin bundle.
 *
 * Every visual decision belongs to the Client half (`client.js`), which stacks
 * a theme-token overlay and scoped CSS in the browser. Nothing here touches the
 * filesystem, the network, tools, or the prompt, so the Host half stays inert;
 * it exists only so `plugin_manager` can mount the bundle row.
 *
 * @module dsh-glass-skin
 */

/**
 * Mount the bundle. Intentionally empty: the Host contributes no service,
 * tool, route, or session state for an appearance-only plugin.
 */
export function apply() {}

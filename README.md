# RSS

This OpenClaw feature plugin includes a typed draft-analysis operation, a model tool, a native page, and a composer replacement. The browser entry owns its DOM and uses the host's standard draft and send operations.

## Build and install

```sh
npm install
npm run build
npm run validate
openclaw plugins install .
```

Installation applies the plugin in the running local Gateway. If the Gateway is stopped, start it to load the saved installation.

Native UI is available by default once the plugin is enabled, with no Labs opt-in. An existing advanced native UI opt-out remains honored; see https://docs.openclaw.ai/plugins/feature-plugins#enable-custom-plugin-ui.

Select RSS in the Control UI sidebar. Open **Plugins > Customize UI** and choose Draft composer to try the replacement; choose Built-in to restore it.

For agent-requested activation, run `npm run pack`. The receipt contains the exact archive path and SHA-256 digest for `plugin_activate_artifact`. Approval applies to those bundled bytes, including their native UI; existing advanced native UI opt-outs remain honored. The archive has no install scripts or package dependencies; backend activation applies through the running Gateway.

After browser-only changes, run the build again and use **Plugins > Customize UI > Reload plugin UI** as an administrator. After editing installed backend source, run `openclaw plugins reload rss`. Rebuild compiled code before reloading; for a copied installation, reinstall the rebuilt package. Plugin install and update commands apply changes through the running Gateway. Native plugins run trusted code in the Gateway and browser; install only code you trust.

Keep browser imports on the browser-safe `control-ui` and `feature-contract` SDK entrypoints. Bundle framework dependencies with the plugin. Return a dispose handle for DOM, subscriptions, and other resources; check the view's abort signal after asynchronous work.

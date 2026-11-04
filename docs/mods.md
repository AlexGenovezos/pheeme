# Mods

Pheeme mods add personal features without rebuilding or forking the app. API 1
supports commands, keyboard shortcuts, settings, a panel, compact sidebar
controls, saved preferences, external HTTP requests, and OAuth connections.
Mods cannot access mail in this first version.

## Install and use

Open **Settings → Mods → Install from folder**, select a built mod folder, review
its identity and requested access, and choose **Install and enable**. The folder
must contain `manifest.json` and its bundled JavaScript entry point. Pheeme
copies the package into its app-data directory; you can move the original folder
after installation. App upgrades preserve installed mods, preferences, and
connections.

Enabled mods appear near the bottom of the sidebar. Click the mod name to open
its panel. Its commands appear in the command palette and **Keyboard shortcuts**;
its settings appear under **Mods** in the settings sidebar. Conflicting default
shortcuts are left unassigned, so existing commands retain their bindings.

**Reload** restarts the installed copy. To apply edited source, choose **Install
from folder** again and approve the update. Updates with the same ID replace that
mod; only install replacements from an author you trust. Review requested access
on every update. A startup failure restores the previous package where available;
this is not a rollback of changes the mod already made to preferences or an
external service. A changed connection declaration clears its saved credentials.

Disable stops execution, removes controls and commands, and cancels pending
requests and login flows. Preferences and connections remain. Requests already
accepted by an external service may still take effect. Remove deletes saved
connections and lets you keep or delete ordinary preferences.

If a mod prevents normal use, quit and launch with `--disable-mods` or
`PHEEME_DISABLE_MODS=1`. On macOS:

```sh
open -a Pheeme --args --disable-mods
```

The app must be fully quit first. This launch runs no mod code and lets you
disable or remove mods in Settings. Restart normally when finished.

## Examples

Install `examples/mods/counter` to try a complete offline mod. Increment the
counter from its panel, sidebar, or palette command. Rename it and toggle the
sidebar count in its settings. The count and preferences survive reloads and
restarts.

`examples/mods/spotify` demonstrates an external integration: current track and
a **Save track** action. In the Spotify developer dashboard, create a public
client supporting authorization code with PKCE, register
`http://127.0.0.1:43821/callback` as a redirect URI, and satisfy Spotify's current
developer-account and user-access requirements. Install the mod, open its
settings, enter the public client ID, and choose **Connect**. Login opens in your
system browser. A desktop mod must not embed a client secret.

The sample uses `user-read-currently-playing` and `user-library-modify`. Provider
policies and endpoint availability can change; the sample is not a promise of
Spotify API access for every account. Protocol behavior is tested with fixtures
and a fake provider; live Spotify login requires your own registered client and
account. See [Spotify's PKCE guide](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow)
and [redirect rules](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri).

Disconnect removes tokens locally. To revoke the provider's grant too, use the
provider's account settings. Disabling a mod preserves its connection.

## Write a mod

Start with the Counter folder. A minimal manifest:

```json
{
  "id": "yourname.example",
  "name": "My example",
  "version": "1.0.0",
  "apiVersion": 1,
  "entry": "main.js",
  "description": "My personal feature",
  "commands": [{ "id": "hello", "title": "Say hello" }],
  "permissions": { "network": [], "connections": [] }
}
```

And `main.js`:

```js
pheeme.on("hello", async () => {
  await pheeme.render("panel", [{ type: "text", text: "Hello from my mod" }]);
});
pheeme.render("compact", [{ type: "button", id: "hello", label: "Say hello" }]);
```

Use `sdk/pheeme.d.ts` for the API types and `sdk/manifest.schema.json` for manifest
validation in your editor. TypeScript authors bundle to one plain JavaScript
script (for example esbuild with `--bundle --format=iife --target=es2020`). Only
install the output folder, without `node_modules`. No runtime module loader,
package installation, or install scripts are provided.

Register action handlers with `pheeme.on(id, handler)`. IDs are local to the mod;
Pheeme namespaces palette and shortcut IDs automatically. Render text, buttons,
toggles, or inputs with `pheeme.render(surface, controls)`. Buttons and commands
deliver `null`, toggles deliver a boolean, and an input's Save action delivers a
string. Plain text is rendered as text; HTML, CSS, and React components are not
accepted. Catch expected failures such as offline requests in your handlers;
uncaught script or promise errors stop the mod and show an error in Settings.

`pheeme.storage.get(key)` returns the saved JSON value or `null`.
`pheeme.storage.set(key, value)` saves a value. Keys use the same lowercase ID
syntax as action IDs. Storage belongs to that mod; it cannot read another mod's
preferences. Do not store credentials here.

Use `pheeme.http.request({ url, method, body, contentType, connection })` for
network requests. Methods default to GET. Responses contain a numeric `status`
and string `body`; non-2xx responses are returned for the mod to handle. Network
failures reject the promise with a sanitized message. Declare exact HTTPS origins
in `permissions.network` for unauthenticated requests. No wildcard hosts,
arbitrary headers, proxies, redirect following, local network, or loopback access
are supported.

For OAuth, declare `permissions.connections` using the Spotify manifest as a
reference. Authorization/token endpoints are HTTPS; the authorization endpoint
has no query string. Scopes and API origins are explicit. Login and disconnect
are handled by Pheeme's settings. `pheeme.connections.status(id)` reports whether
a saved connection exists. Set `connection` on a request to use that connection;
its allowed origins come from `apiOrigins`. Pheeme refreshes tokens when needed
and attaches authorization only to those origins. Tokens never enter the mod
runtime. Unsupported provider flows requiring a confidential backend are outside
API 1.

## Limits and compatibility

Each mod runs in an independent embedded QuickJS runtime. It has no browser DOM,
Node APIs, Tauri bridge, filesystem, process execution, or direct networking.
Host calls are checked against the active session and approved manifest.

- Up to 32 installed mods; packages up to 2 MiB, 128 entries, and 8 directory
  levels. Symlinks, escaping paths, and special files are rejected.
- 16 MiB JavaScript heap, a 512 KiB JavaScript stack, and 250 ms per execution
  turn, including its promise microtasks. A CPU loop is interrupted.
- 32 outstanding API calls, 120 calls per second, and 64 KiB per API message.
- 32 commands, 32 controls per settings/panel surface, and 4 compact controls.
- 64 KiB of stored JSON across at most 128 keys.
- Up to 8 timers, running at most once per second each. A timer returns a cleanup
  function. Suspend/resume does not replay missed timer ticks.
- Network requests time out after 20 seconds and responses are limited to 1 MiB.
  Login has a three-minute timeout and uses one local callback port at a time.

Package versions are independent of `apiVersion`. API 1 gets compatible
additions; breaking contracts require a new API version. Unsupported versions
are rejected on installation and never executed on startup. App internals,
database tables, store shapes, and DOM selectors are outside the mod contract.

Mods run while Pheeme is running. There is no marketplace, automatic mod update,
native-code loading, mail capability, or execution after quitting the app in this
version.

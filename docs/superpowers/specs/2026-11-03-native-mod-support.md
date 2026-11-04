# Proposal: native mod support

Date: 2026-11-03

Status: implementation authorized by Alex ("Full send build it"). API 1 ships
local installation, an isolated QuickJS runtime, declarative controls, commands,
storage, an HTTP broker, and public-client OAuth connections. See [the authoring
guide](../../mods.md) for the shipped contract and examples. Mail-specific APIs
and richer custom views remain later work.

## Purpose

Users should be able to add personal features, keep using official Pheeme
releases, and retain those features across app updates without maintaining a
fork. Mods are separately installed packages that use a versioned public API.
They can extend mail workflows or add independent integrations.

Alex's example is a mod in another app that connects to Spotify through Settings
and lets him heart music. Pheeme's design must support that kind of integration:
its own settings, authentication, controls, external requests, and persistent
state. Spotify is the design example, not a new built-in Pheeme feature or a
commitment to ship a Spotify integration.

## User experience

Settings gains a Mods page with Install from folder, enable/disable, reload,
remove, version, requested access, and readable error details. A mod needs no
Pheeme rebuild. Initial distribution is local folders; archives, discovery, and
automatic mod updates can come later.

Installation copies a validated package into Pheeme's app-data directory. The
installed copy survives app upgrades independently of the app bundle. Reloading
a development folder is an explicit action that stages a fresh validated copy.
Install and replacement show requested access before activating code. A
replacement that needs more access stays inactive until that access is granted.

Each mod can add a searchable settings page under Mods, commands in the existing
palette and shortcut editor, and controls in supported interface locations. The
initial locations are a sidebar entry opening a mod panel and a compact area at
the bottom of the sidebar. Message actions are the next mail-specific surface.
Contributions identify their mod, use Pheeme's theme and accessibility patterns,
and disappear when it is disabled.

Disabling stops execution and access immediately, cancels pending login flows,
removes subscriptions and controls, and retains preferences and connections for
later re-enabling. Disconnect deletes local tokens and directs users to the provider to revoke
the external grant. Removing a mod deletes local credentials and asks
whether to keep its ordinary preferences; it explains that disconnecting inside
Pheeme may not remove the grant listed in the provider's account settings.

A startup option must open Pheeme with all mods disabled, without starting any
mod code, so a faulty mod cannot prevent access to mail or the Mods page.

## Package and public API

A package contains a JSON manifest, a bundled JavaScript entry point, and local
assets. TypeScript authors compile to JavaScript before installation. Packages
have no install scripts and require no package-manager execution by Pheeme.

The manifest declares a stable mod ID, name, package version, supported mod API
version, entry point, contributions, and requested permissions. All package paths
must remain within the package; reject traversal, escaping symlinks, duplicate
IDs, unsupported API versions, and excessive package sizes before execution.
Replacement requires an explicit update operation, not another package silently
claiming the same ID.

The first API provides:

- Commands with titles, optional default shortcuts, and asynchronous handlers.
  IDs are namespaced by the host. Mods cannot replace built-in or other mods'
  commands. Existing shortcut conflict handling applies.
- Settings and small panels described as data: text, buttons, toggles, inputs,
  lists, and status. Mod handlers update their state through messages. Pheeme
  renders the controls; functions and React components do not cross the bridge.
- A compact sidebar contribution suitable for track status and a heart button.
- Namespaced JSON storage for preferences and cached data, with quotas.
- Scoped external HTTP requests and OAuth connections through the host.
- Lifecycle events, cancellable timers, and sanitized diagnostics.

The first version supports the Spotify example through these declarative
controls. Rich custom views remain a later extension of the public API. Mods
must not depend on Pheeme's DOM, CSS selectors, internal React components,
Zustand stores, database schema, or raw Tauri commands. This supported surface is
what allows Pheeme's internals to change without requiring mod rewrites.

Public data contracts have independent API versions. Compatible additions keep
working; breaking changes require a new major API version and documented
migration. Unsupported mods remain installed with an explanation and are not
executed. Preferences are retained through app and mod upgrades. Package
replacements are staged so a failed activation can restore the previous package;
data migrations must define their own recovery behavior before being supported.

## Execution and access

Mod code executes in an isolated JavaScript runtime, outside the main interface.
The host grants capabilities and renders contributions. Loading arbitrary mod
JavaScript into Pheeme's main webview would give it the app's privileges and
cannot implement the proposed access model.

The runtime must have no ambient filesystem, process, network, main-window DOM,
or Tauri access. It must be possible to stop a mod that loops forever, bound its
memory and message volume, and keep mail responsive. The implementation uses embedded QuickJS with per-mod memory and stack limits,
an interrupt deadline, and bounded message channels; cross-platform CI checks
compilation and runtime tests. A Web Worker
alone does not establish all of these restrictions.

The host derives mod identity from the runtime session, never from a mod-supplied
ID. Rust checks capabilities on every privileged operation. Disable, removal,
and permission changes invalidate sessions and discard late responses. A mod
cannot retain access through a cached connection handle after being disabled.
Requests already accepted by an external service may still take effect;
disabling a mod cannot undo those effects.

Permissions are specific: allowed network origins, declared OAuth connections
and scopes, and later individual mail capabilities. Ordinary per-mod storage
and contributions stay within host-imposed limits. A Spotify mod receives no
mail access. Future mail APIs call the existing Rust services, preserving account
boundaries, cache behavior, and queued mutations; they never expose SQL or Gmail
tokens. Mail read, draft creation, and sending require separate decisions and
permissions when those APIs are added.

External requests pass through a host HTTP broker. It validates scheme, exact
origin, resolved destinations, redirects, response size, and timeouts. Private
and loopback destinations are blocked except for the host-owned OAuth callback.
Every redirect is checked again, and authorization headers never follow a
redirect to another origin. Mod-authenticated requests cannot supply arbitrary
destinations for host-held tokens. Mod images and other UI assets cannot bypass
this broker by loading remote URLs in the main interface.

OAuth uses the system browser, state validation, and PKCE for supported public
desktop clients. The host owns callback handling, token exchange, refresh, and
token storage. Mods receive opaque connection handles and connection status;
authenticated requests attach tokens only to the connection's declared API
origins. Refresh tokens and client secrets never enter mod code, browser storage,
ordinary preferences, or logs. Keychain records are isolated by mod and
connection, separate from Pheeme's Google-account credentials.

A mod declares its provider endpoints and scopes; the host supports a bounded
OAuth flow rather than promising compatibility with every provider. Provider
registration, allowed redirect URIs, developer-account restrictions, and API
availability still apply. A distributed desktop package cannot conceal a client
secret. The Spotify example must validate current provider requirements before
promising a working connection; it may require the user to supply a client ID.

## Fit with this checkout

- `src/keyboard/registry.ts` already provides command registration, cleanup,
  palette entries, and shortcut overrides. Add an owned adapter for mod commands.
- `src/settings/pages.tsx` and `src/settings/schema.ts` define built-in settings
  using React component references. Keep those internal; adapt declarative mod
  settings into the same presentation and search system.
- `src/shell/Sidebar.tsx` and `src/shell/AppShell.tsx` are the initial hosts for
  sidebar contributions and a mod panel.
- Rust services behind `src-tauri/src/commands/` remain the authority for future
  mail operations. Add a mod service and a narrow broker rather than exposing
  the existing invoke surface wholesale.
- `src-tauri/src/secrets.rs` has an OS-keychain abstraction. Reuse that mechanism
  with separate mod records; its account-specific vault is not a generic mod
  credential format.
- `src-tauri/src/gmail/auth.rs` has Google-specific OAuth behavior. Share suitable
  primitives through a provider-neutral service without changing Gmail scopes
  or error handling as a side effect.
- `src-tauri/tauri.conf.json` restricts scripts and connections, and the existing
  external-link command has a fixed allowlist. Add brokered mod loading and
  validated browser authorization instead of broadly relaxing those policies.

## Implementation slices and completion criteria

1. Prove runtime isolation and termination on macOS, Windows, and Linux. A test
   mod cannot call Tauri, read app files, make direct network requests, or stall
   the mail interface. Establish the bridge and stable error contracts.
2. Add package validation, local installation, session ownership, permissions,
   mod state, storage, Mods settings, and startup with mods disabled. Verify
   traversal rejection, incompatible versions, permission escalation on update,
   disable during an in-flight operation, and failure recovery.
3. Add commands, settings, panel, and compact sidebar contributions. Ship a small
   offline example that demonstrates every surface, survives app restart, cleans
   up on disable, and requires no app-specific source patch. Verify keyboard
   conflicts, accessibility, theme behavior, and cleanup after handler failures.
4. Add the HTTP/OAuth broker and an integration example with a fake provider for
   automated tests. Verify callback state, refresh, origin enforcement including
   redirects, isolated credentials, disconnect, cancellation, and redaction.
   Manually validate Spotify only after confirming provider setup and access.
5. Publish the authoring guide, manifest schema, API types, and supported version
   policy. Demonstrate a compatible host upgrade retaining an installed mod,
   preferences, and connection without a rebuild or rebase of the mod.

The first usable mod release includes slices 1–5 and supports an independent
integration with settings, login, and controls. Mail actions, arbitrary custom
views, background execution while Pheeme is closed, native binaries, dependency
resolution between mods, a marketplace, and automatic mod updates are later
work. Mods run only while Pheeme is running; quitting the app stops them.

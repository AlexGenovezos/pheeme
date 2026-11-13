# Security

## Reporting a problem

Report security problems privately through
[a GitHub security advisory](https://github.com/AlexGenovezos/pheeme/security/advisories/new),
not in a public issue, pull request or discussion. Say what an attacker can do, and include the
steps or a proof of concept and the Pheeme version (Settings › About).

You'll get a reply within a week. Once a fix ships, the advisory is published with credit to you
unless you'd rather stay anonymous.

## Supported versions

Only the latest release gets fixes. Pheeme offers each new release in the app, and installing it
takes one click.

## What counts

Pheeme handles Google OAuth tokens and renders mail from strangers, so these matter most:

- Script or active content from an email running in the app, or a way past the HTML sanitizer
  (`src-tauri/src/render.rs`).
- Reading tokens, mail or the database from outside the app, including through the local MCP
  server (`127.0.0.1:43830`) without a valid token.
- Anything that lets an update, a release artifact or the CI that builds it be tampered with.
- Mail, attachments or account data leaving the device anywhere other than Google's APIs (or the
  anonymous usage ping, which you can turn off).

Problems that need someone already in control of your computer or your Google account are out of
scope, as are bugs in Google's services themselves.

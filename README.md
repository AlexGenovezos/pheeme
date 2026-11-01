# Pheeme

A fast, open-source desktop client for Gmail, with Google Calendar coming next, for macOS, Windows and Linux.

- **Gmail-native:** uses the Gmail API, with real labels and category tabs (Primary, Social, Promotions, Updates, Forums).
- **Instant:** reads come from a local cache and actions apply immediately, with Gmail syncing in the background.
- **Free to run:** you bring your own Google Cloud OAuth client, so there's no subscription and no server between you and your mail.
- **Multi-account:** one combined inbox, or switch between accounts.

> **Status:** early development. Not usable yet.

Website: [pheeme.app](https://pheeme.app)

## Install

Download the latest build from [Releases](https://github.com/AlexGenovezos/pheeme/releases/latest). Versions are two-part (`v0.2`); 0.x is beta, and 1.0 is when Pheeme leaves beta.

- **macOS:** open the `.dmg` and drag Pheeme to Applications. If the build is
  unsigned, right-click the app and choose Open, or run
  `xattr -dr com.apple.quarantine /Applications/Pheeme.app`.
- **Windows:** run the installer. If SmartScreen warns about it, choose
  More info, then Run anyway.
- **Linux:** `chmod +x Pheeme_*.AppImage` and run it, or install the deb with
  `sudo apt install ./Pheeme_*.deb`.

Pheeme checks for updates on launch and every 6 hours, and asks before
restarting to apply one.

## Docs

- [Design](docs/superpowers/specs/2026-10-31-mail-calendar-client-design.md): scope, priorities and roadmap
- [Technical plan](Gmail%20client%20project%20plan.md): the detailed implementation reference

A step-by-step Google Cloud setup guide comes with the OAuth phase.

## Develop on macOS

```bash
git clone https://github.com/AlexGenovezos/pheeme.git
cd pheeme
scripts/setup-macos.sh
npm run tauri dev
```

The setup script checks the Apple and Rust toolchains, installs the universal
Rust targets and SQLx CLI, and runs `npm ci`. To test the real macOS keychain
integration once, run:

```bash
cd src-tauri
SQLX_OFFLINE=true cargo test -- --ignored keyring_store_round_trip_on_this_os
```

## Releasing

Versions are two-part (`v0.2`): 0.x is beta, and 1.0 is when Pheeme leaves beta.

1. `npm run version:set 0.2` (files store `0.2.0`; Cargo and MSI need three parts)
2. Commit as `release: v0.2` and merge it through a PR.
3. After the merge: `git tag v0.2 && git push origin v0.2`
4. The Release workflow creates a draft release, builds macOS (universal),
   Windows and Linux, checks `latest.json`, then publishes.

Signing setup:

- macOS signing and notarization need a one-time
  `scripts/setup-release-secrets-macos.sh` run on a Mac with your Developer ID
  certificate. Without those secrets the macOS build is unsigned.
- The updater private key lives in the GitHub secrets
  `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and in
  Alex's password manager. If the key is lost, existing installs can't
  auto-update.

## License

MIT

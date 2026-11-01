# Pheeme

A fast, open-source desktop client for Gmail, with Google Calendar coming next, for macOS, Windows and Linux.

- **Gmail-native:** uses the Gmail API, with real labels and category tabs (Primary, Social, Promotions, Updates, Forums).
- **Instant:** reads come from a local cache and actions apply immediately, with Gmail syncing in the background.
- **Free to run:** you bring your own Google Cloud OAuth client, so there's no subscription and no server between you and your mail.
- **Multi-account:** one combined inbox, or switch between accounts.

> **Status:** early development. Not usable yet.

Website: [pheeme.app](https://pheeme.app)

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

## License

MIT

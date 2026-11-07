#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
  echo "Setup error: $1" >&2
  exit 1
}

xcode-select -p >/dev/null 2>&1 || fail "Install Xcode Command Line Tools with: xcode-select --install"

command -v rustup >/dev/null 2>&1 || fail "Install Rust with: https://rustup.rs"
command -v cargo >/dev/null 2>&1 || fail "Install Rust with: https://rustup.rs"

command -v node >/dev/null 2>&1 || fail "Install Node.js 22.12 or newer from: https://nodejs.org"
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 12)) process.exit(1)' \
  || fail "Install Node.js 22.12 or newer from: https://nodejs.org"
command -v npm >/dev/null 2>&1 || fail "Install npm (ships with Node.js 22+): https://nodejs.org"

rustup toolchain install
rustup target add aarch64-apple-darwin

if [ "$(sqlx --version 2>/dev/null)" != "sqlx-cli 0.9.0" ]; then
  cargo install sqlx-cli --version 0.9.0 --locked --force --no-default-features --features sqlite,rustls
fi

npm ci

echo "Ready: npm run tauri dev"

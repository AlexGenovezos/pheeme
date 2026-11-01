#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "Setup error: $1" >&2
  exit 1
}

xcode-select -p >/dev/null 2>&1 || fail "Install Xcode Command Line Tools with: xcode-select --install"

command -v rustup >/dev/null 2>&1 || fail "Install Rust with: https://rustup.rs"
command -v cargo >/dev/null 2>&1 || fail "Install Rust with: https://rustup.rs"

command -v node >/dev/null 2>&1 || fail "Install Node.js 22 or newer from: https://nodejs.org"
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' \
  || fail "Install Node.js 22 or newer from: https://nodejs.org"

rustup target add aarch64-apple-darwin x86_64-apple-darwin

if ! command -v sqlx >/dev/null 2>&1; then
  cargo install sqlx-cli --no-default-features --features sqlite,rustls
fi

command -v npm >/dev/null 2>&1 || fail "Install npm (ships with Node.js 22+): https://nodejs.org"
npm ci

echo "Ready: npm run tauri dev"

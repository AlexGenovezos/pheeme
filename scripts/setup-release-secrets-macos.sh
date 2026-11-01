#!/usr/bin/env bash
# One-time setup: stores the Apple signing and notarization secrets in the
# GitHub repo so tagged releases ship a signed, notarized macOS app.
set -euo pipefail

repo=AlexGenovezos/pheeme

fail() {
  echo "Setup error: $1" >&2
  exit 1
}

command -v security >/dev/null 2>&1 || fail "the macOS 'security' tool is required (run this on a Mac)"
command -v gh >/dev/null 2>&1 || fail "install the GitHub CLI: brew install gh"
gh auth status >/dev/null 2>&1 || fail "log in to GitHub first: gh auth login"

identities=()
while IFS= read -r line; do
  identities+=("$(sed -E 's/^.*"(.*)"$/\1/' <<<"$line")")
done < <(security find-identity -v -p codesigning | grep 'Developer ID Application' || true)

if [ "${#identities[@]}" -eq 0 ]; then
  cat >&2 <<'EOF'
No "Developer ID Application" signing identity found in your keychain.
Create one: Xcode -> Settings -> Accounts -> select your team -> Manage Certificates -> + -> Developer ID Application.
Then run this script again.
EOF
  exit 1
fi

echo "Developer ID Application identities:"
for i in "${!identities[@]}"; do
  echo "  $((i + 1))) ${identities[$i]}"
done
read -rp "Pick one [1]: " choice
choice="${choice:-1}"
[[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "${#identities[@]}" ] || fail "invalid choice"
signing_identity="${identities[$((choice - 1))]}"
default_team_id="$(sed -E 's/^.*\(([A-Z0-9]{10})\)$/\1/' <<<"$signing_identity")"

echo
echo "Export the certificate: Keychain Access -> My Certificates -> right-click it -> Export -> .p12"
read -rp "Path to the exported .p12: " p12_path
p12_path="${p12_path/#\~/$HOME}"
[ -f "$p12_path" ] || fail "no file at $p12_path"
read -rsp "Password for the .p12: " certificate_password
echo
certificate="$(base64 -i "$p12_path")"

echo
read -rp "Apple ID email: " apple_id
echo "Create an app-specific password: appleid.apple.com -> Sign-In and Security -> App-Specific Passwords"
read -rsp "App-specific password: " apple_password
echo
read -rp "Team ID [$default_team_id]: " team_id
team_id="${team_id:-$default_team_id}"

set_secret() {
  [ -n "$2" ] || fail "$1 is empty"
  printf '%s' "$2" | gh secret set "$1" --repo "$repo"
  echo "Set $1"
}

set_secret APPLE_CERTIFICATE "$certificate"
set_secret APPLE_CERTIFICATE_PASSWORD "$certificate_password"
set_secret APPLE_SIGNING_IDENTITY "$signing_identity"
set_secret APPLE_ID "$apple_id"
set_secret APPLE_PASSWORD "$apple_password"
set_secret APPLE_TEAM_ID "$team_id"

echo "Done. The next tagged release will be signed and notarized."

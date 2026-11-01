#!/usr/bin/env bash
# Exports the Apple signing/notarization secrets to later steps only when all
# six are present; otherwise warns (names only) so the macOS build runs unsigned.
set -uo pipefail

names=(APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID)
missing=()
for name in "${names[@]}"; do
  [ -n "${!name:-}" ] || missing+=("$name")
done

if [ "${#missing[@]}" -gt 0 ]; then
  list="$(printf '%s, ' "${missing[@]}")"
  echo "::warning::Apple signing secrets incomplete (missing: ${list%, }) — building unsigned macOS app"
  exit 0
fi

for name in "${names[@]}"; do
  delim="$(openssl rand -hex 16)"
  printf '%s<<%s\n%s\n%s\n' "$name" "$delim" "${!name}" "$delim" >>"$GITHUB_ENV"
done
exit 0

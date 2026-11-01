#!/usr/bin/env bash
set -euo pipefail

resolver="$(dirname "$0")/resolve-apple-env.sh"
names=(APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID)
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

set_dummies() {
  export APPLE_CERTIFICATE=$'cert-line-1\ncert-line-2\ncert-line-3'
  export APPLE_CERTIFICATE_PASSWORD=dummy-cert-pass
  export APPLE_SIGNING_IDENTITY='Developer ID Application: Dummy (ABCDE12345)'
  export APPLE_ID=dummy@example.com
  export APPLE_PASSWORD=dummy-app-pass
  export APPLE_TEAM_ID=ABCDE12345
}

run_resolver() {
  : >"$scratch/env"
  GITHUB_ENV="$scratch/env" bash "$resolver" >"$scratch/out" 2>&1 || fail "resolver exited non-zero"
}

# Case 1: nothing set
unset "${names[@]}"
run_resolver
[ ! -s "$scratch/env" ] || fail "none set: GITHUB_ENV was written"
grep -qF '::warning::Apple signing secrets incomplete (missing: APPLE_CERTIFICATE, APPLE_CERTIFICATE_PASSWORD, APPLE_SIGNING_IDENTITY, APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID)' "$scratch/out" \
  || fail "none set: warning does not list all six"
echo "ok: none set"

# Case 2: APPLE_PASSWORD empty
set_dummies
export APPLE_PASSWORD=
run_resolver
[ ! -s "$scratch/env" ] || fail "one missing: GITHUB_ENV was written"
grep -qF '(missing: APPLE_PASSWORD)' "$scratch/out" || fail "one missing: warning does not list only APPLE_PASSWORD"
for value in cert-line dummy-cert-pass 'Dummy (ABCDE12345)' dummy@example.com ABCDE12345; do
  ! grep -qF "$value" "$scratch/out" || fail "one missing: output leaked '$value'"
done
echo "ok: one missing"

# Case 3: all set, multi-line certificate
set_dummies
run_resolver
for name in "${names[@]}"; do
  grep -q "^$name<<" "$scratch/env" || fail "all set: $name not written"
done
delim="$(sed -n 's/^APPLE_CERTIFICATE<<//p' "$scratch/env")"
[ -n "$delim" ] || fail "all set: no certificate delimiter"
cert="$(awk -v d="$delim" '$0 == "APPLE_CERTIFICATE<<" d {on=1; next} $0 == d {on=0} on' "$scratch/env")"
[ "$cert" = "$APPLE_CERTIFICATE" ] || fail "all set: multi-line certificate not intact"
[ ! -s "$scratch/out" ] || fail "all set: unexpected output"
echo "ok: all set"

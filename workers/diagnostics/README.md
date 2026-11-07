# Diagnostics Worker

Receives **Settings › About › Send diagnostics** uploads from the app at
`https://diagnostics.pheeme.email/v1/upload`, stores each zip in the private R2
bucket `pheeme-diagnostics` (deleted after 30 days), and emails a notification
from `diagnostics@pheeme.email` to `ajg0360@gmail.com` with the user's note,
the summary highlights, and the command to download the zip. The zip is never
attached to the email.

- `src/handler.ts` — all request handling, pure and tested (`handler.test.ts`).
- `src/mime.ts` — builds the notification email (`mime.test.ts`).
- `src/index.ts` — wires the real bindings and defines the `DailyCap` Durable Object.
- `src/types.ts`, `src/cloudflare.d.ts` — the minimal runtime types used; no npm dependencies.

Limits: 2 uploads per IP per minute (approximate, per Cloudflare location),
200 accepted uploads per UTC day (exact, one Durable Object), 5 MB per bundle.
Over a limit the Worker answers 429 and stores and sends nothing.

## Request contract

`POST /v1/upload`, `multipart/form-data`:

- `meta`: JSON `{ version, os, arch, replyTo: string | null, note: string (≤ 2000 chars), highlights: string[] (≤ 20, each ≤ 500 chars) }`. `version`, `os` and `arch` are required, at most 100 characters, no line breaks. `replyTo` must be a plain ASCII email address.
- `bundle`: the zip (`application/zip`), at most 5 MB.

Responses: `204` stored; `400` malformed; `404`/`405` wrong path or method; `413` too large; `429` with `Retry-After` (60 s for the per-IP limit, seconds to the next UTC midnight for the daily cap); `5xx` failure.

## One-time setup

Run these from the repo root, logged in to the Cloudflare account in
`wrangler.jsonc` (`wrangler login` if needed). The `pheeme.email` zone is
already on that account.

1. Create the bucket and the 30-day expiry rule (no prefix, so it covers every object):

   ```bash
   wrangler r2 bucket create pheeme-diagnostics
   wrangler r2 bucket lifecycle add pheeme-diagnostics expire-after-30-days --expire-days 30
   wrangler r2 bucket lifecycle list pheeme-diagnostics
   ```

   R2 removes expired objects typically within 24 hours of expiry, which is why
   the privacy policy says "about 30 days".

2. Turn on Email Routing for `pheeme.email` (skip if it's already on; it adds
   the MX and SPF records Email Routing needs, so check the zone has no other
   mail provider first), then add and verify the destination address:

   ```bash
   wrangler email routing enable pheeme.email
   wrangler email routing addresses create ajg0360@gmail.com
   ```

   Open the "Verify email address" email Cloudflare sends to ajg0360@gmail.com
   and click the link. Check it shows as verified:

   ```bash
   wrangler email routing addresses list
   ```

   (Dashboard equivalent: Compute › Email Service › Email Routing › Destination
   Addresses.) Sends to a verified destination address are free and need no
   Email Service sending domain; until it is verified, every notification
   fails (uploads are still stored and the app still gets 204).

3. Check the bundle, then deploy. The custom domain creates the
   `diagnostics.pheeme.email` DNS record and certificate, and the first deploy
   runs the `v1` migration that creates the `DailyCap` Durable Object class.

   ```bash
   wrangler deploy --dry-run --config workers/diagnostics/wrangler.jsonc
   wrangler deploy --config workers/diagnostics/wrangler.jsonc
   ```

4. Smoke test (counts against the limits above):

   ```bash
   dir=$(mktemp -d) && echo '{}' > "$dir/summary.json" && (cd "$dir" && zip -q t.zip summary.json)
   curl -i https://diagnostics.pheeme.email/v1/upload \
     --form-string 'meta={"version":"smoke","os":"curl","arch":"x86_64","replyTo":null,"note":"Smoke test","highlights":[]}' \
     -F "bundle=@$dir/t.zip;type=application/zip"
   rm -rf "$dir"
   ```

   Expect `HTTP/2 204` and, within a minute, an email titled
   "Pheeme diagnostics: anonymous (smoke, curl)".

## Fetching a bundle

Each notification email ends with the exact command, for example:

```bash
wrangler r2 object get pheeme-diagnostics/2026-11-06/<id>.zip --file <id>.zip --remote
```

Keys are `YYYY-MM-DD/<id>.zip` (UTC upload day). To browse everything still
stored, open the `pheeme-diagnostics` bucket in the Cloudflare dashboard (R2 ›
Overview); each object's custom metadata holds `version`, `os` and `replyTo`.
Replying to the notification email goes straight to the user's reply address.

Live logs (for example a failed notification): `wrangler tail pheeme-diagnostics`.

## Development

```bash
npm run test -- workers
npx wrangler deploy --dry-run --config workers/diagnostics/wrangler.jsonc --outdir "$(mktemp -d)"
```

`npm run typecheck`, `npm run lint` and `npm run format:check` cover this
directory too.

# Reuse OnlyUno proclamation signing and verification — integration

Status: CODE READY, NOT YET DEPLOYED. Until the deploy checklist below is complete, the live .org form cannot record anything (its POST reaches Pages, not the Worker, and fails closed).

## What was found (step 1–2 of the original handoff)
- **Authoritative service:** Cloudflare Worker `copyrights-for-humans`, route `onlyuno.xyz/copyrightsforhumans*`. Its source now lives in [`worker/`](worker/).
- **Bindings:** D1 `copyrights-for-humans` (`DB`), Cloudflare Email Routing `send_email` (`EMAIL`), `FROM_EMAIL=proclamation@onlyuno.xyz`, `NOTIFY_TO`, secret `ADMIN_KEY`. Not Resend, not `shiny-surf-8843`.
- **Submit endpoint:** `POST /copyrightsforhumans/api/sign`, JSON, origin-checked, honeypot `website`, optional Turnstile, D1 rate limits (5/IP/hour, 40/min global), disposable-domain block, one row per email.
- **Verify:** `GET /copyrightsforhumans/verify?t=<48 hex>` marked verified and rendered the certificate. Tokens never expired and could be reused.
- **Count:** `GET /copyrightsforhumans/api/count`. Admin: `/admin/stats`, `/admin/signatures.csv`, `/admin/send-pending`.
- The deployed code already allowed the .org origin and had a hostname mode for it, but no route sent .org traffic to the Worker.
- The D1 `stance` column had a CHECK limited to the three OnlyUno stances, so `for` / `against` could not be stored.

## What the integration does
1. **One service, one table, one sender.** The .org reuses the same Worker, D1 table and `proclamation@onlyuno.xyz` email. One email = one row across both sites (no duplicates).
2. **Same-origin.** Worker routes on the .org zone (`/api/*`, `/verify*`, `/certificate*`, `/unsubscribe*`, `/admin/*`). Pages keeps serving everything else. `script.js` posts to `/api/sign`; no secrets in the browser.
3. **Strict request checks.** Origin header required and must match the site being served (fail closed); `application/json` only; body ≤ 6 KB; per-site schema validation; 405 on wrong method; 503 with "nothing was recorded" if email is unavailable.
4. **For / Against.** Only verified `for` counts toward `movement` in `GET /api/count`. Both positions may opt in to publish name + position + comment via `GET /api/comments` (verified, opted-in only; email and profession never selected). Motivation and profession are stored privately.
5. **Tokens.** Verification tokens are single-use (burned atomically on verify), expire after 72 hours, and are rotated on resubmission. Verifying issues a separate certificate link (`/certificate?c=`). Resubmitting a confirmed email never changes the record; it re-sends the certificate link instead.
6. **Certificate from the server record only:** name, position, email-confirmation date, Supporter No. (For only). No AIN is shown because none is issued. Copy text / Markdown / HTML, download HTML, print-to-PDF, plus the public invite link `https://rightsforhumansnotrobots.org/`.
7. **OnlyUno page unchanged** (byte-identical, SHA-256 `636129a1…611c2e`). Old OnlyUno verification links still work once; afterwards they move to a certificate link.
8. **Privacy fix:** confirmation emails are no longer BCC'd to the owner (that copied every person's token into the owner's inbox). The owner still gets a notice on each verified response.

## Deploy checklist (in this order)
1. `wrangler d1 execute copyrights-for-humans --remote --file worker/migrations/0002_backup.sql`
2. `wrangler d1 execute copyrights-for-humans --remote --file worker/migrations/0002_rfh_positions.sql` (the currently deployed Worker keeps working on the new schema)
3. `cd worker && npx wrangler deploy` (existing `ADMIN_KEY` secret is kept)
4. Merge this branch to `main` so Pages publishes the wired `index.html` / `script.js`.
5. Live test with consenting addresses: For and Against, counts, comments privacy, reused and expired links, resubmission, and Spam-folder placement at Gmail and Outlook.

## Tests
`node worker/test/run.mjs` (16 groups: origin/method, validation, honeypot, fail-closed email, For/Against, counts, comments privacy, expiry, reuse, resubmission, legacy flow, unsubscribe, rate limit, admin) and `node worker/test/browser.mjs` (Playwright: fill form → email link → certificate). Both use Node's built-in SQLite as a D1 stand-in and never send real email.

## Still not done
- Real inbox and spam-folder delivery (needs the live deploy).
- AIN / NFARTIFACT issuance: not connected; certificates say so.
- Turnstile on the .org form: supported server-side when `TURNSTILE_SECRET` is set, but the .org page has no widget yet. Do not set the secret until the widget is added, or .org submissions will be rejected.
- Never open or paste an individual's real confirmation token into tests, URLs or repository history.

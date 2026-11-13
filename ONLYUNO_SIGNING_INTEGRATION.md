# Reuse OnlyUno proclamation signing and verification — integration handoff

Status: NOT CONNECTED. Do not treat submissions as recorded.

## Confirmed clues
- Public frontend: https://rightsforhumansnotrobots.org/
- Existing OnlyUno proclamation: https://onlyuno.xyz/copyrightsforhumans/
- Verification route shape: https://onlyuno.xyz/copyrightsforhumans/verify?t=SECRET
- Sender observed in email: proclamation@onlyuno.xyz
- Active submit endpoint, accepted schema, token store and verification handler: NOT YET IDENTIFIED in accessible source.
- Other OnlyUno documentation describes shiny-surf-8843 and Resend mail transport, but that does not establish the proclamation uses them.

## Required implementation
1. Locate the active Cloudflare Worker, Pages Function or service owning the verification route. Inspect routes and bindings without revealing tokens or secrets.
2. Identify the submission route used by the original OnlyUno form, its method, schema, response, anti-abuse and CORS. Verification GET is not a submission endpoint.
3. Preserve one authoritative storage and verification service. Avoid duplicate signatures or AINs.
4. Connect the .org form by a same-origin server-side proxy or validated CORS, with strict origin/method checks, schema validation, rate limiting and fail-closed errors. No service secrets in browser JavaScript.
5. Map For/Against positions: only For joins the movement. Both may opt into publication of their named comments; email never appears publicly. Preserve optional motivation and profession.
6. Keep verification server-authoritative with expiring, single-use tokens. The OnlyUno verification page may continue until safe redirect is configured.
7. Issue personal certificate only from confirmed server record: verified name, position, timestamp and AIN only if actually issued. Client-editable preview is never proof.
8. Give verified users text, Markdown, HTML, print-to-PDF certificate, plus independent public invite link https://rightsforhumansnotrobots.org/.
9. End-to-end test consented addresses for For and Against, counts, privacy, expired and reused tokens, resubmissions, and spam-folder confirmation.

## Present safeguards
- The new site script.js currently has FORM_ENDPOINT empty. It deliberately declines real submissions.
- certificate-preview.html is a locally generated, visibly unverified demonstration.
- No production email, Cloudflare binding, registry mutation or AIN issuance has been activated by this document.
- Never open or paste an individual's real confirmation token into tests, URLs, or repository history.

# Copyrights for Humans

https://rightsforhumansnotrobots.org

Copyrights Are PersonHood the value in Humans Intrinsic SouL ROBOTS Are Cloned

Static landing-page project for the Proclamation of Copyrights for Humans.

## Files

- `index.html` — page structure and proclamation content
- `styles.css` — parchment, typography, responsive layout and seal styling
- `script.js` — client-side validation, same-origin submission to `/api/sign`, live count and share actions
- `worker/` — the `copyrights-for-humans` Cloudflare Worker: the single signing, email-confirmation and certificate service for this site and onlyuno.xyz/copyrightsforhumans (see `ONLYUNO_SIGNING_INTEGRATION.md`)

## Cloudflare Pages

This repository is intended for a Cloudflare Pages deployment.

- Production branch: `main`
- Build command: leave blank (static site)
- Build output directory: `/` (repository root)
- Custom domain: `rightsforhumansnotrobots.org`

The site is a static front end. Signing is handled by the Worker in `worker/`, routed on this domain for `/api/*`, `/verify*`, `/certificate*`, `/unsubscribe*` and `/admin/*`. Responses count only after email confirmation, and email addresses are never published. Deploy order and tests are in `ONLYUNO_SIGNING_INTEGRATION.md`.

Do not put API keys, tokens, or private credentials in this repository or browser JavaScript.

Canonical/share URLs in the page point to:

https://rightsforhumansnotrobots.org/

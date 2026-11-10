# Copyrights for Humans

https://rightsforhumansnotrobots.org

Copyrights Are PersonHood the value in Humans Intrinsic SouL ROBOTS Are Cloned

Static landing-page project for the Proclamation of Copyrights for Humans.

## Files

- `index.html` — page structure and proclamation content
- `styles.css` — parchment, typography, responsive layout and seal styling
- `script.js` — client-side validation and share actions

## Cloudflare Pages

This repository is intended for a Cloudflare Pages deployment.

- Production branch: `main`
- Build command: leave blank (static site)
- Build output directory: `/` (repository root)
- Custom domain: `rightsforhumansnotrobots.org`

The site is a static front end. Signature collection is deliberately **not active** yet: `FORM_ENDPOINT` in `script.js` is empty. Connect a backend that validates submissions, sends an email-confirmation link, prevents duplicate/unverified signatures from appearing in the public count, and protects email addresses before enabling the sign button's submission flow.

Do not put API keys, tokens, or private credentials in this repository or browser JavaScript.

Canonical/share URLs in the page point to:

https://rightsforhumansnotrobots.org/

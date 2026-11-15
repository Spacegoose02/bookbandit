# Accounts and sign-in changes (`ws/auth`)

- 2026-11-15: Settings → Your account → Link Tinyauth account: a signed-in grown-up (admin included) links their own account through the single sign-on round trip (`/api/auth/sso/start?link=1`), merging an account SSO made on its own; Unlink keeps at least one way to sign in (`DELETE /api/auth/sso/identities/:id`). (this PR)
- 2026-11-15: Single sign-on with Tinyauth (OpenID Connect): `PUBLIC_URL` + `SSO_ISSUER` + `SSO_CLIENT_ID` + `SSO_CLIENT_SECRET` (+ `SSO_LABEL`, `SSO_AUTO_CREATE`) show a "Sign in with Tinyauth" button; emails match People's sign-in emails, new ones get an adult account. Admins can link, remove and move sign-in emails on People (moving merges an SSO-made account into a real profile). (#54)
- 2026-11-14: Top bar links to Discover, Series, Categories and Requests; the grown-up menu wraps onto its own row on tablets. (this PR)
- 2026-11-14: Top bar links to Family (parents and admins) and Admin (admins). (#24)
- 2026-11-14: Sign-in screens: first-run admin setup, username/password, Google button (`GOOGLE_SIGN_IN_URL`), tablet pairing by code, "Who's reading?" with kid PIN and picture pads, Settings → your name and kids' names, Switch reader / Sign out. Tablet browsers keep the device token in a `bb_device` cookie (#14)
- 2026-11-14: Family accounts: kid accounts under a parent, PIN/picture sign-in, QR device pairing, local passwords (#5)

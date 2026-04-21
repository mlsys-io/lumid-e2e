# lumid-e2e

End-to-end auth tests for `lum.id` + LumidOS, written from the **end-user perspective**. No REST-seeding, no dev shortcuts — every test drives real URLs the way a user would, clicks through the actual UI, polls a real inbox for OTP/reset emails.

## Why this exists

The lumid ecosystem has mature REST-level tests (TC10 PAT lifecycle, TC11 unified introspect). Nothing automated today catches a user-visible bug like "OAuth redirects to 500", "forgot-password email never arrives", "admin nav shows empty data after login", or "fresh install.sh produces a broken CLI". This repo closes that gap.

## Flows covered

| # | Journey | File |
|---|---------|------|
| 1 | Signup → email OTP → verify → land on dashboard | `tests/01-signup.spec.ts` |
| 2 | Login (email/password) → dashboard → logout → protected 401 | `tests/02-login-logout.spec.ts` |
| 3 | Login (Google OAuth) → dashboard | _skipped — known gap, quarterly manual smoke_ |
| 4 | Forgot password → email link → set new → login with new | `tests/04-forgot-password.spec.ts` |
| 5 | Profile page: display name + avatar upload | `tests/05-profile.spec.ts` |
| 6 | Password change → other device's next request returns 401 | `tests/06-change-password.spec.ts` |
| 7 | Admin → `/account/admin/runmesh/users` → sees real list via SSO bridge | `tests/07-admin-runmesh-sso.spec.ts` |
| 8 | Fresh `curl lum.id/start \| bash` → `lumid trading status` works | `cli/test_case_14_install_lifecycle.py` |
| 9 | Installed CLI with revoked PAT → clean error | `cli/test_case_14_install_lifecycle.py` step 4 |

## Setup (one-time)

```bash
npm install
npx playwright install --with-deps chromium firefox
cp .env.example .env.local
# edit .env.local with the secrets listed at the top
```

### What you need in `.env.local`

1. **`E2E_GMAIL_USER` + `E2E_GMAIL_APP_PASSWORD`** — a dedicated Gmail account (e.g. `lumid-e2e@lum.id`) with IMAP enabled and a generated [app password](https://myaccount.google.com/apppasswords). Tests use `+subaddress` tagging to isolate concurrent runs.
2. **`E2E_ADMIN_EMAIL` + `E2E_ADMIN_PASSWORD`** — a seed admin account, **not** a real user (the password will change during spec 06). Create via the normal signup UI and promote to `role=admin` in the lumid-identity DB.


### Known gaps

- **Google OAuth** is not exercised automatically. Playwright against the real Google login UI is too flaky (bot detection, UI changes). Spec `03-google-oauth.spec.ts` is a `test.skip()` placeholder with a manual repro in the doc comment; run it quarterly by hand.

## Running

```bash
# Full suite — chromium + firefox
npm test

# Chromium only (fast feedback)
npm run test:chromium

# Headed (watch what happens)
npm run test:headed

# Single spec
npx playwright test tests/01-signup.spec.ts

# Debug a spec step-by-step
npm run test:debug
```

## Against a local stack

```bash
BASE_URL=http://localhost:13080 npm test
```

Assumes lumid-identity + lumid_front + lumid_ui are running locally and the nginx proxy on :13080 is up.

## CI

- **PR**: `.github/workflows/e2e.yml` runs chromium only, skips OAuth + TC14.
- **Nightly**: full suite, both browsers, TC14 included (requires self-hosted runner for docker-in-docker).

## Concurrency + isolation

Tests run **serially** (`workers: 1`). Rationale: the admin persona is shared; the Gmail mailbox is shared; the admin password-change spec intentionally mutates state. Parallel runs would race on these shared resources. For speed, use `test:chromium` which halves the run by skipping Firefox.

Fresh signups use a timestamped `+subaddress` so their inboxes don't collide with concurrent manual testing.

## Teardown

Each spec that creates a user puts a unique email in its `fixtures/test-user.ts` call. A nightly cron (configured in `/proj/infra/cron/`) deletes `lumid-e2e+*@lum.id` users older than 24h so the DB doesn't grow forever.

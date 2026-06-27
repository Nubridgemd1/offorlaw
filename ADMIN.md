# Offor Law — Site Editor (admin)

A password-protected editor at **offorlaw.com/admin** lets an authorized person update key
website text (announcement bar, hero intro, practice-area descriptions, the call-to-action,
and contact details) without touching code.

## How it works
- The homepage reads `public/content.json` and renders it over the built-in defaults.
- `/admin` is a login + form. On **Save**, the server (1) writes `content.json` on the running
  server for an instant update, and (2) commits `content.json` back to the GitHub repo so the
  change survives the next redeploy (Hyperlift's container disk resets on each deploy).
- Auth is email + password. The password is stored only as a one-way scrypt hash; sessions are
  signed HttpOnly cookies (default 12h).

## Go-live checklist (one-time)

These secrets live in **Hyperlift → the offorlaw app → Environment variables**. The feature is
inert until they're set (the public site is unaffected either way).

1. **Pick Perry's password and hash it** (run locally in the `offorlaw` folder):
   ```
   node tools/hash-password.js "his-chosen-password"
   ```
   Copy the printed `ADMIN_PASSWORD_HASH=...` value.

2. **Generate a session secret:**
   ```
   node -e "console.log('SESSION_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
   ```

3. **Create a GitHub token for persistence** (so edits aren't lost on redeploy):
   - GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new token.
   - Repository access: only `Nubridgemd1/offorlaw`. Permission: **Contents → Read and write**.
   - Copy the token for the next step.

4. **Set these env vars on Hyperlift, then redeploy:**
   | Variable | Value |
   |----------|-------|
   | `ADMIN_EMAIL` | `perryernest@offorlaw.com` |
   | `ADMIN_PASSWORD_HASH` | the `salt:hash` from step 1 |
   | `SESSION_SECRET` | the value from step 2 |
   | `GITHUB_TOKEN` | the token from step 3 |

   Optional (sensible defaults already in code): `GIT_REPO=Nubridgemd1/offorlaw`,
   `GIT_BRANCH=main`, `CONTENT_PATH=public/content.json`, `SESSION_HOURS=12`.

5. Visit **https://offorlaw.com/admin**, sign in, edit, Save. You should see *"Saved and
   published."* (If you see a revert warning, `GITHUB_TOKEN` isn't set correctly.)

## Notes & security
- Never commit real secrets. `.env` is gitignored; set values in Hyperlift, not in the repo.
- Login is rate-limited (5 tries → 5-min lockout per IP). Cookies are HttpOnly + Secure +
  SameSite=Lax; POSTs are same-origin checked.
- Editable fields are a fixed whitelist; values are stored and rendered as plain text
  (`textContent`), so an editor can't inject scripts or HTML.
- To change Perry's password later: re-run step 1 and update `ADMIN_PASSWORD_HASH`.
- To add another editor or more editable fields, extend `ADMIN_EMAIL` handling /
  `CONTENT_KEYS` in `server.js` and the form in `public/admin.html`.

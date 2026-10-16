# Acme Workspace

A small Express app used as the **target** for an end-to-end security demo:

> point at this repo → a Daytona sandbox clones, builds and runs it → OWASP ZAP logs in
> and scans it → a browser agent proves the finding → a model proposes a patch → the patch
> is applied → the retest proves the attack no longer works.

## Run it

```bash
npm ci
npm start
# http://localhost:3000
```

## Demo accounts

| Email                | Password   | Notes                                   |
| -------------------- | ---------- | --------------------------------------- |
| `analyst@acme.test`  | `demo1234` | Owns two notes                          |
| `admin@acme.test`    | `admin123` | Owns a confidential note (see IDOR)     |

## Intentional vulnerabilities

The app ships a few deliberately planted issues so a scan surfaces a realistic spread.

1. **Reflected XSS (public)** — `/search?q=` echoes the query back unescaped.
2. **Reflected XSS (authenticated)** — `/dashboard?q=` uses the same shared renderer, so the
   same bug is reachable once signed in. This is the "authenticated area" the demo proves.
3. **Off-site redirect** — `/go?next=` redirects to any caller-supplied URL.
4. **IDOR** — `/notes/:id` returns any note by id with no ownership check, so the analyst
   account can read the admin's confidential note.
5. **Missing hardening headers / CSRF** — no CSP, anti-clickjacking, or login CSRF token.

The shared renderer is where the cookie-cutter bug lives:

```js
const termHtml = term          // ← reflected XSS (both /search and /dashboard)
```

## The fix (one line)

```js
const termHtml = escapeHtml(term)
```

The demo applies exactly this change, restarts the app, and re-runs the browser proof —
the dialog no longer fires while the search box keeps working.

## Routes

| Route            | Auth | Purpose                                  |
| ---------------- | ---- | ---------------------------------------- |
| `/search?q=`     | no   | Public knowledge-base search (XSS)       |
| `/login`         | no   | Form login → sets `sid` cookie           |
| `/dashboard?q=`  | yes  | Private notes + search (authenticated XSS)|
| `/notes/:id`     | yes  | Note viewer (IDOR)                       |
| `/go?next=`      | no   | Redirect helper (open redirect)          |
| `/health`        | no   | `{ ok, version }`                        |

## Notes

- `/health` returns `{ ok, version }`; the version string is what the demo watches change
  (`1.2.0-vulnerable` → `1.2.0-fixed`).
- This app is deliberately vulnerable and is only intended to be run in an isolated sandbox.

# Deploy / Handoff — Live QR Poll

Self-contained Node + Express + Socket.io app. One always-on web service serves
the host screen (`/`), the admin page (`/admin`), and the voter page (`/vote`),
with live updates over WebSockets.

> **This is a handoff doc for taking the app live.** A fresh session/developer
> can act on it cold — everything needed is below.

---

## Architecture facts that drive the deploy

- **Must run as ONE persistent Node process.** State (votes, "watching" count) is
  in-memory and Socket.io holds long-lived WebSocket connections. **Do not** deploy
  to serverless/functions (Vercel/Netlify functions, Lambda). Render/Railway/Fly/VPS
  are correct.
- **Single instance only.** Because state is in-memory and there's no shared
  pub/sub, do **not** scale to multiple instances — a second instance would have
  its own separate vote counts. One instance handles the PRD's "few hundred
  voters" target fine.
- **Entry point:** `npm start` → `node server.js`. Listens on `process.env.PORT`
  (falls back to 3000).
- **Public URL for the QR code** is resolved in `server.js` → `publicOrigin()`, in
  this order: `PUBLIC_URL` → `RENDER_EXTERNAL_URL` (auto on Render) →
  `RAILWAY_PUBLIC_DOMAIN` (auto on Railway) → LAN IP (local dev). So on Render and
  Railway **the QR link works with zero URL config.**

---

## Option A — Render (recommended)

A `render.yaml` blueprint is included.

1. Push this folder to a GitHub repo (see "Git setup" below).
2. Render → **New → Blueprint** → pick the repo. It reads `render.yaml` and creates
   a free web service (`npm install` / `npm start`).
   - Or **New → Web Service** manually: Build `npm install`, Start `npm start`.
3. The blueprint declares `ADMIN_PASSCODE` as a `sync:false` var, so Render
   **prompts you for a value** during the Blueprint flow. The poll is already
   protected by the built-in passcode `firstwave`; enter a value here only to
   use a private passcode instead (recommended if the repo is public). See
   "Admin passcode" below.
4. Deploy. Render assigns `https://<name>.onrender.com` and injects
   `RENDER_EXTERNAL_URL`, so the QR code points there automatically.
5. Open `https://<name>.onrender.com/` (host screen) and `/admin` to configure.

> Free tier sleeps after inactivity and cold-starts in ~30–60s on first hit. For a
> live event, upgrade to a paid instance or ping it right before you start.

## Option B — Railway

A `Procfile` (`web: npm start`) is included.

1. Push to GitHub (below). Railway → **New Project → Deploy from GitHub repo**.
2. Railway auto-detects Node and runs `npm start`.
3. Under the service → **Settings → Networking → Generate Domain**. Railway sets
   `RAILWAY_PUBLIC_DOMAIN`, which the server uses for the QR link automatically.
4. Optional: under **Variables**, add `ADMIN_PASSCODE` to override the built-in
   default passcode `firstwave` (see "Admin passcode" below).
5. Open the generated URL `/` and `/admin`.

## Git setup (needed for either)

This folder is not yet a git repo:

```bash
cd qr-poll
git init
git add .
git commit -m "Live QR Poll"
# create an empty GitHub repo, then:
git remote add origin git@github.com:<you>/qr-poll.git
git push -u origin main
```

`node_modules/` is gitignored; the logo/icon images in `public/uploads/` are **kept**
on purpose so the configured poll renders on the live site.

---

## Before you call it "production" — known gaps

These are deliberate v1 simplifications (per the PRD). Decide which matter for your
launch:

| Gap | Impact | Fix if needed |
| --- | --- | --- |
| **`/admin` password** — ✅ shipped | Poll edits and the host controls (open/close/reset) require a passcode. **Default is `firstwave`** (built in, gate always on); override with the `ADMIN_PASSCODE` env var. See "Admin passcode" below. | Done. |
| **Votes are in-memory** | A redeploy/restart resets all counts. | Move state to SQLite or Redis. |
| **Uploads on ephemeral disk** | Logos/icons uploaded via `/admin` *after* deploy vanish on the next redeploy. Images committed in the repo are fine. | Store uploads in S3/Cloudflare R2. |
| **One-vote-per-device is light** | Incognito / another browser = another vote. | Add IP or cookie limiting, or real identity (kills the no-login goal). |
| **Single instance** | Won't horizontally scale. | Add a Redis Socket.io adapter + shared store. |

## Admin passcode

**The passcode is `firstwave`** by default (built into `server.js`), so the gate
is **always on** — you can't accidentally ship an unprotected poll. Set the
`ADMIN_PASSCODE` env var to override it (rotate the passcode without a code
change). It locks down the two privileged surfaces:

- **Poll setup** (`/admin` → Save, and image uploads) — `POST /api/config` /
  `POST /api/upload` reject requests without a valid token.
- **Host controls** on the big screen (`/`) — Reset / Close / Open voting. These
  fire over WebSockets, so they're gated server-side too, not just hidden.

What stays **public** (no passcode): the host display and live results, the QR
code, and voting itself. That's intentional — the room needs those.

How it works: the operator enters the passcode once per browser tab. `/admin`
prompts on load; the host screen shows an **"Unlock controls"** button. The
server hands back a short-lived token (kept in `sessionStorage`) that's attached
to privileged requests. Auth state is in-memory, consistent with the
single-instance model — a restart just means re-entering the passcode.

⚠️ **The default `firstwave` is committed to the repo.** If the GitHub repo is
**public**, anyone can read it — set `ADMIN_PASSCODE` to a private value in
Render/Railway, or keep the repo private. The startup log shows whether the
passcode came from the built-in default or from `ADMIN_PASSCODE`.

## Environment variables

| Var | Needed? | Notes |
| --- | --- | --- |
| `PORT` | Auto on Render/Railway | Server reads it; defaults to 3000 locally. |
| `ADMIN_PASSCODE` | Optional (overrides default) | Passcode for poll edits + host controls. Defaults to `firstwave` if unset, so the gate is always on. Override to rotate it / hide it from a public repo. `render.yaml` prompts for it (`sync:false`). |
| `PUBLIC_URL` | Optional | Force the QR origin (e.g. a custom domain). Overrides auto-detection. |

## Smoke test after deploy

1. `GET /` returns the host page; the QR shows your public `https://…/vote` URL.
2. Open `/vote` on a phone (cellular, not Wi-Fi) → vote → host bars update live.
3. `/admin` → enter the passcode (`firstwave`, or your `ADMIN_PASSCODE`
   override) → change the question → Save → host + voter pages update instantly.
4. **Passcode check:** in a fresh incognito window, open `/` — Reset/Close/Open
   are hidden behind "Unlock controls", and `/admin` refuses to Save until you
   enter the passcode.

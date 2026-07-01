# Live QR Polling Screen

A no-login, real-time polling tool. A host shows a poll on a big screen; attendees
scan a QR code, tap an answer, and the bar graph updates live. Built per the PRD —
self-hosted Node + Express + Socket.io, no accounts or API keys.

## Run

```bash
npm install
npm start
```

Then:

- **Host / big screen** → open `http://localhost:3000/` on the laptop driving the projector.
- **Voters** → scan the QR shown on the host screen (it points at your machine's LAN
  address, e.g. `http://192.168.x.x:3000/vote`), or open that URL on a phone.

> Phones must be on the **same Wi-Fi/LAN** as the host laptop for the QR link to work.
> To expose it beyond the LAN, put it behind a tunnel (ngrok/Cloudflare) and set the
> public URL — see `VOTER_URL` in `server.js`.

## Configure the poll

**Easiest: the admin page** → open `http://localhost:3000/admin`. From there you can:

- Set the **poll logo** (upload an image or keep the default).
- Set the **poll name / question**.
- Add, rename, reorder, and remove **options** — each with its own **icon**
  (type an emoji, or upload a small image).
- Click **Save & start poll** — the new poll goes live on every connected screen
  instantly and vote counts reset.

**Or edit `poll.config.json` directly:**

```json
{
  "logo": "/logo.svg",
  "question": "What should we build next?",
  "options": [
    { "label": "ChatGPT", "icon": "🤖" },
    { "label": "Gemini", "icon": "✨" },
    { "label": "Claude", "icon": "🧠" },
    { "label": "Others", "icon": "🔧" }
  ]
}
```

- An option may be a plain string (`"ChatGPT"`) or `{ "label", "icon" }`. `icon` is
  either an emoji or an image path (e.g. an uploaded `/uploads/...png`).
- Drop your own logo into `public/` and point `logo` at it (e.g. `/mylogo.png`).
- Click **Reset** on the host screen to reload the question/options and clear votes.

Uploaded images are saved under `public/uploads/`.

## Host controls (big screen footer)

- **Close voting / Open voting** — stop or resume accepting votes.
- **Reset** — reload config and zero out all counts (starts a fresh round).

## How requirements map to the build

| PRD | Where |
| --- | --- |
| F1 QR → voter page | `GET /api/qr` generates a QR for the LAN voter URL |
| F2 one-tap vote | `public/vote.js` → `vote` socket event |
| F3/F4 live bars | server `broadcast()` → `host.js` animates bar widths via CSS |
| F5 open/close | host footer buttons → `host:open` / `host:close` |
| F6 one vote per device | `deviceId` in `localStorage` + server-side `votedDevices` set |
| F7 logo per poll | `logo` field in `poll.config.json` |

## Notes / scope

In-memory single-poll state, per the PRD's v1 scope (no DB, no accounts, light
per-device limiting only). Restarting the server clears votes.

# WhatsApp Connector (Railway)

A tiny Node.js service that wraps [whatsapp-web.js](https://wwebjs.dev/) and exposes a JSON API for the LifeAdmin AI backend.

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/status` | `{connected, status}` |
| GET | `/qr` | QR data URL for linking a WhatsApp account |
| GET | `/chats?limit=20` | Recent chats |
| GET | `/chat-messages/:chatId?limit=100` | Chat messages |
| POST | `/send` | `{phone OR group, message}` |
| POST | `/disconnect` | Log out |
| POST | `/restart` | Restart the whatsapp-web.js client |

## Auth (recommended for public deploys)

Set `WHATSAPP_SERVICE_TOKEN` to a long random string. Every request then requires:

```
Authorization: Bearer <token>
```

Set the **same** value on the FastAPI backend (`WHATSAPP_SERVICE_TOKEN` env var) — it will be sent automatically.

Leave unset for open access (local dev only).

## Deploy on Railway

1. Push this folder to a GitHub repo.
2. Railway → New Project → Deploy from GitHub repo.
3. **Variables:**
   - `WHATSAPP_SERVICE_TOKEN` = your random string (64+ chars)
   - Railway auto-sets `PORT`.
4. **Volume (important):** attach a persistent volume at `/app/.wwebjs_auth` so your WhatsApp session survives redeploys. Otherwise you'll need to scan the QR code again after every deploy.
5. After first deploy, visit `https://<your-app>.up.railway.app/qr` (or use the LifeAdmin UI) to scan the QR and link an account.

## Local dev

```bash
npm install
node index.js          # listens on 3001, no token required
```

## Env vars

| Var | Purpose |
|---|---|
| `PORT` | HTTP port (Railway sets automatically, local default 3001) |
| `WHATSAPP_SERVICE_TOKEN` | Optional shared-secret for Bearer auth |
| `PUPPETEER_EXECUTABLE_PATH` | Override Chromium path (Nixpacks / custom Docker) |

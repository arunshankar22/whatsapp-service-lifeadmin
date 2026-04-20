# WhatsApp Connector (Baileys, Railway-ready)

Pure Node.js WhatsApp Web client using [Baileys](https://github.com/WhiskeySockets/Baileys). **No Chromium, no Puppeteer** — deploys in under a minute on Railway.

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET  | `/status`                     | `{connected, status}` |
| GET  | `/qr`                         | QR data URL for linking a WhatsApp account |
| GET  | `/chats?limit=20`             | Recent chats |
| GET  | `/chat-messages/:chatId`      | Messages cached since service start |
| POST | `/send`                       | Body `{phone, message}` or `{group, message}` |
| POST | `/disconnect`                 | Log out and wipe local auth |
| POST | `/restart`                    | Recycle the WA socket |

## Auth (recommended)

Set `WHATSAPP_SERVICE_TOKEN` to a long random string. All requests then require:
```
Authorization: Bearer <token>
```
Leave unset for open access (local dev only). Set the **same** value on the FastAPI backend — it will be sent automatically.

## Deploy on Railway

1. Push this folder to a GitHub repo.
2. Railway → New Project → Deploy from GitHub repo.
3. **Variables:**
   - `WHATSAPP_SERVICE_TOKEN` = long random string (same as on backend)
4. **Volume** (important): attach a persistent volume with mount path `/usr/src/app/.wa_auth` so your WhatsApp session survives redeploys. Without it, you'll re-scan the QR every deploy.
5. After first deploy, hit `GET /qr` (with your token) and scan the returned QR code with WhatsApp → Linked Devices.

## Local dev

```bash
npm install
node index.js          # listens on 3001
```

## Caveats

- **Message history**: Baileys only surfaces messages it observes during the session. On first connect, WhatsApp pushes a partial history (chats.set / messaging-history.set) which we cache. Older messages are not retrievable without an active session that has seen them.
- **Group send by name**: uses case-insensitive substring match on group subject. If you have multiple similar group names, pass the full JID (`123456@g.us`) in the `group` field instead.

/*
 * WhatsApp Connector (Baileys edition)
 *
 * Pure Node.js WhatsApp Web client — no Chromium, no Puppeteer.
 * Exposes the same JSON API shape that LifeAdmin's FastAPI backend expects.
 *
 * Endpoints:
 *   GET  /status                    -> {connected, status}
 *   GET  /qr                        -> {qr: dataUrl}
 *   GET  /chats?limit=20            -> {chats: [...]}
 *   GET  /chat-messages/:id?limit=N -> {chatName, messages: [...]}
 *   POST /send  body: {phone|group, message}
 *   POST /disconnect
 *   POST /restart
 *
 * Env vars:
 *   PORT                      HTTP port (Railway sets automatically, default 3001)
 *   WHATSAPP_SERVICE_TOKEN    Optional Bearer token for all endpoints
 */

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const P = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ---------- Optional Bearer auth ----------
const SERVICE_TOKEN = (process.env.WHATSAPP_SERVICE_TOKEN || '').trim();

if (SERVICE_TOKEN) {
  console.log('[WhatsApp] Bearer token auth ENABLED');
  app.use((req, res, next) => {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${SERVICE_TOKEN}`) {
      return res.status(401).json({ success: false, error: 'unauthorized' });
    }
    next();
  });
} else {
  console.log('[WhatsApp] Bearer token auth DISABLED (WHATSAPP_SERVICE_TOKEN not set)');
}

// ---------- State ----------
const authDir = path.resolve(__dirname, '.wa_auth');
let sock = null;
let qrDataUrl = null;
let status = 'disconnected';   // disconnected | qr_ready | connecting | connected
let connected = false;
let reconnectTimer = null;

// Chat + message caches (in-memory; persists only while process is alive)
const chats = new Map();           // jid -> {id, name, isGroup, lastMessage, timestamp, unreadCount}
const messagesByChat = new Map();  // jid -> Array<msg>
const MAX_MSGS_PER_CHAT = 500;

// ---------- Helpers ----------
function extractText(msg) {
  const m = msg.message || {};
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    ''
  );
}

function normalisePhone(phone) {
  const cleaned = (phone || '').replace(/[^0-9]/g, '');
  return cleaned + '@s.whatsapp.net';
}

function cacheMessage(msg) {
  const jid = msg.key?.remoteJid;
  if (!jid || jid === 'status@broadcast') return;
  const text = extractText(msg);
  const entry = {
    id: msg.key.id,
    body: text,
    fromMe: !!msg.key.fromMe,
    timestamp: Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
    from: jid,
    senderName: msg.key.fromMe
      ? 'You'
      : msg.pushName || (msg.key.participant ? msg.key.participant.split('@')[0] : jid.split('@')[0]),
    type: Object.keys(msg.message || {})[0] || 'text',
    hasMedia: !!(msg.message?.imageMessage || msg.message?.videoMessage || msg.message?.audioMessage || msg.message?.documentMessage),
  };

  if (!messagesByChat.has(jid)) messagesByChat.set(jid, []);
  const arr = messagesByChat.get(jid);
  arr.push(entry);
  if (arr.length > MAX_MSGS_PER_CHAT) arr.shift();

  // Update chat entry
  const existing = chats.get(jid) || {};
  chats.set(jid, {
    id: jid,
    name: existing.name || msg.pushName || jid.split('@')[0],
    isGroup: jid.endsWith('@g.us'),
    timestamp: entry.timestamp,
    lastMessage: {
      body: (text || '').substring(0, 200),
      timestamp: entry.timestamp,
      fromMe: entry.fromMe,
    },
    unreadCount: existing.unreadCount || 0,
  });
}

// ---------- WhatsApp client ----------
async function start() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();
  console.log(`[WhatsApp] Using WA version ${version.join('.')}`);

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: P({ level: 'silent' }),
    browser: ['LifeAdmin AI', 'Chrome', '1.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  status = 'connecting';

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        qrDataUrl = await qrcode.toDataURL(qr);
        status = 'qr_ready';
        console.log('[WhatsApp] QR code ready');
      } catch (e) {
        console.error('[WhatsApp] QR encode error:', e.message);
      }
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const reason = lastDisconnect?.error?.message || 'unknown';
      connected = false;
      status = 'disconnected';
      qrDataUrl = null;
      console.log(`[WhatsApp] Disconnected (${code}): ${reason}`);
      if (code !== DisconnectReason.loggedOut) {
        reconnectTimer = setTimeout(() => start().catch(e => console.error('Reconnect error:', e.message)), 5000);
      }
    } else if (connection === 'open') {
      connected = true;
      status = 'connected';
      qrDataUrl = null;
      console.log('[WhatsApp] Connected');
    }
  });

  // Populate chat list from server events
  sock.ev.on('messaging-history.set', ({ chats: chatList, messages }) => {
    for (const c of chatList || []) {
      const existing = chats.get(c.id) || {};
      chats.set(c.id, {
        id: c.id,
        name: c.name || existing.name || c.id.split('@')[0],
        isGroup: c.id.endsWith('@g.us'),
        unreadCount: c.unreadCount || 0,
        timestamp: Number(c.conversationTimestamp) || existing.timestamp || 0,
        lastMessage: existing.lastMessage || null,
      });
    }
    for (const m of messages || []) cacheMessage(m);
    console.log(`[WhatsApp] History sync: ${chats.size} chats, ${messagesByChat.size} with messages`);
  });

  sock.ev.on('chats.upsert', (arr) => {
    for (const c of arr) {
      const existing = chats.get(c.id) || {};
      chats.set(c.id, {
        id: c.id,
        name: c.name || existing.name || c.id.split('@')[0],
        isGroup: c.id.endsWith('@g.us'),
        unreadCount: c.unreadCount || 0,
        timestamp: Number(c.conversationTimestamp) || existing.timestamp || 0,
        lastMessage: existing.lastMessage || null,
      });
    }
  });

  sock.ev.on('chats.update', (arr) => {
    for (const c of arr) {
      const existing = chats.get(c.id) || {};
      chats.set(c.id, {
        ...existing,
        id: c.id,
        name: c.name || existing.name,
        isGroup: c.id?.endsWith('@g.us'),
        unreadCount: c.unreadCount ?? existing.unreadCount,
        timestamp: Number(c.conversationTimestamp) || existing.timestamp,
      });
    }
  });

  sock.ev.on('contacts.upsert', async (contacts) => {
    for (const c of contacts) {
      const existing = chats.get(c.id);
      if (existing && (c.name || c.notify)) {
        existing.name = c.name || c.notify || existing.name;
      }
    }
  });

  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const m of messages) cacheMessage(m);
  });
}

// ---------- HTTP endpoints ----------
app.get('/status', (req, res) => {
  res.json({ success: true, connected, status });
});

app.get('/diag', (req, res) => {
  // Lightweight diagnostic: verifies auth dir exists/writable & lists contents.
  const info = {
    authDir,
    exists: fs.existsSync(authDir),
    files: [],
    writable: false,
    volumeEnv: process.env.RAILWAY_VOLUME_MOUNT_PATH || null,
    volumeName: process.env.RAILWAY_VOLUME_NAME || null,
    railwayEnvVars: Object.keys(process.env).filter(k => k.startsWith('RAILWAY')),
  };
  try {
    if (info.exists) {
      info.files = fs.readdirSync(authDir).slice(0, 20);
      // Write/read test
      const testFile = path.join(authDir, '.diag_write_test');
      fs.writeFileSync(testFile, String(Date.now()));
      info.writable = true;
      fs.unlinkSync(testFile);
    }
    // Also check volume mount path if env var is set
    if (info.volumeEnv && info.volumeEnv !== authDir) {
      info.volumeContents = fs.existsSync(info.volumeEnv)
        ? fs.readdirSync(info.volumeEnv).slice(0, 20)
        : 'volume path does not exist';
    }
  } catch (e) {
    info.error = e.message;
  }
  res.json({ success: true, ...info });
});

app.get('/qr', (req, res) => {
  if (connected) return res.json({ success: true, connected: true, qr: null });
  if (qrDataUrl) return res.json({ success: true, connected: false, qr: qrDataUrl });
  return res.json({ success: true, connected: false, qr: null, message: 'Initializing... try again in a few seconds' });
});

app.post('/send', async (req, res) => {
  if (!connected || !sock) return res.status(400).json({ success: false, error: 'WhatsApp not connected' });
  const { phone, group, message } = req.body || {};
  if ((!phone && !group) || !message) {
    return res.status(400).json({ success: false, error: 'phone or group name required, plus message' });
  }

  try {
    let jid;
    if (group) {
      // group may be a full JID already (...@g.us) or a name
      if (group.endsWith('@g.us')) {
        jid = group;
      } else {
        // Try cache first
        let match = [...chats.values()].find(
          c => c.isGroup && c.name && c.name.toLowerCase().includes(group.toLowerCase())
        );
        if (!match) {
          // Fresh fetch
          const all = await sock.groupFetchAllParticipating();
          const found = Object.values(all).find(g => (g.subject || '').toLowerCase().includes(group.toLowerCase()));
          if (!found) {
            return res.status(404).json({ success: false, error: `Group "${group}" not found` });
          }
          jid = found.id;
          chats.set(jid, { id: jid, name: found.subject, isGroup: true, timestamp: Date.now() / 1000, unreadCount: 0, lastMessage: null });
        } else {
          jid = match.id;
        }
      }
    } else {
      jid = phone.includes('@') ? phone : normalisePhone(phone);
    }

    const sent = await sock.sendMessage(jid, { text: message });
    console.log(`[WhatsApp] Message sent to ${jid}`);
    return res.json({ success: true, messageId: sent?.key?.id });
  } catch (err) {
    console.error('[WhatsApp] Send error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/chats', async (req, res) => {
  if (!connected) return res.status(400).json({ success: false, error: 'WhatsApp not connected' });
  const limit = parseInt(req.query.limit, 10) || 20;

  // Also merge in groups we're participating in, to ensure they're discoverable
  try {
    const all = await sock.groupFetchAllParticipating();
    for (const g of Object.values(all)) {
      const existing = chats.get(g.id) || {};
      chats.set(g.id, {
        ...existing,
        id: g.id,
        name: g.subject || existing.name || g.id.split('@')[0],
        isGroup: true,
        unreadCount: existing.unreadCount || 0,
        timestamp: existing.timestamp || 0,
        lastMessage: existing.lastMessage || null,
      });
    }
  } catch (e) {
    // Non-fatal
  }

  const sorted = [...chats.values()]
    .filter(c => c.id && c.id !== 'status@broadcast')
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, limit);

  res.json({ success: true, chats: sorted });
});

app.get('/chat-messages/:chatId(*)', (req, res) => {
  if (!connected) return res.status(400).json({ success: false, error: 'WhatsApp not connected' });
  const chatId = req.params.chatId;
  const limit = parseInt(req.query.limit, 10) || 100;
  const cached = messagesByChat.get(chatId) || [];
  const chatName = chats.get(chatId)?.name || chatId;
  if (cached.length === 0) {
    return res.json({
      success: true,
      chatName,
      messages: [],
      note: 'No cached messages yet. Baileys only caches messages it has seen since the service started. New messages will appear as they arrive.',
    });
  }
  res.json({ success: true, chatName, messages: cached.slice(-limit) });
});

app.post('/disconnect', async (req, res) => {
  try {
    if (sock) {
      try { await sock.logout(); } catch (_) {}
    }
    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
    connected = false;
    status = 'disconnected';
    qrDataUrl = null;
    sock = null;
    chats.clear();
    messagesByChat.clear();
    // Kick off fresh init for next QR scan
    reconnectTimer = setTimeout(() => start().catch(e => console.error('Post-disconnect start error:', e.message)), 1000);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/restart', async (req, res) => {
  try {
    connected = false;
    status = 'disconnected';
    qrDataUrl = null;
    if (sock) { try { await sock.end(); } catch (_) {} }
    sock = null;
    reconnectTimer = setTimeout(() => start().catch(e => console.error('Restart error:', e.message)), 1500);
    res.json({ success: true, message: 'Restarting...' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- Boot ----------
const PORT = parseInt(process.env.PORT, 10) || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[WhatsApp Connector] Running on port ${PORT}`);
  start().catch(e => console.error('[WhatsApp] Initial start error:', e.message));
});

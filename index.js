const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

const app = express();
app.use(cors());
app.use(express.json());

// Optional shared-secret auth. Set WHATSAPP_SERVICE_TOKEN on both this service
// and the FastAPI backend (same value) to enable. Leave unset for open access.
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

// Railway assigns a port via env. Falls back to 3001 for local dev.
const PORT = parseInt(process.env.PORT, 10) || 3001;

let qrCodeData = null;
let clientStatus = 'disconnected'; // disconnected, qr_pending, connected
let clientReady = false;

// In-memory message cache — stores recent messages per chat
const messageCache = new Map(); // chatId -> [{...msg}]
const MAX_CACHED_MESSAGES = 500;

// Cache of chat list for name lookups when getChats fails
let cachedChatList = [];

// Puppeteer config — on Railway, let puppeteer use its bundled Chromium.
// Override via PUPPETEER_EXECUTABLE_PATH env var if you need a custom binary.
const puppeteerConfig = {
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--single-process',
  ],
};
if (process.env.PUPPETEER_EXECUTABLE_PATH) {
  puppeteerConfig.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
}

// Initialize WhatsApp client
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: puppeteerConfig,
});

client.on('qr', async (qr) => {
  console.log('[WhatsApp] QR code received');
  qrCodeData = await qrcode.toDataURL(qr);
  clientStatus = 'qr_pending';
});

client.on('ready', () => {
  console.log('[WhatsApp] Client ready and connected');
  clientStatus = 'connected';
  clientReady = true;
  qrCodeData = null;

  // Preload recent chats into cache
  client.getChats().then(chats => {
    chats.slice(0, 20).forEach(chat => {
      if (chat.lastMessage) {
        const chatId = chat.id._serialized;
        if (!messageCache.has(chatId)) messageCache.set(chatId, []);
        const cached = messageCache.get(chatId);
        const msg = chat.lastMessage;
        cached.push({
          id: msg.id?._serialized || 'last',
          body: msg.body || '',
          fromMe: msg.fromMe,
          timestamp: msg.timestamp,
          senderName: msg.fromMe ? 'You' : (msg._data?.notifyName || ''),
          type: msg.type || 'chat',
          hasMedia: msg.hasMedia || false,
        });
      }
    });
    console.log(`[WhatsApp] Preloaded ${messageCache.size} chat caches`);
    // Cache the chat list for name lookups
    cachedChatList = chats.slice(0, 50).map(chat => ({
      id: chat.id._serialized,
      name: chat.name || chat.pushname || chat.id.user,
      isGroup: chat.isGroup,
      unreadCount: chat.unreadCount,
      timestamp: chat.timestamp,
    }));
  }).catch(() => {});
});

// Cache all incoming messages
client.on('message', (msg) => {
  const chatId = msg.from;
  if (!messageCache.has(chatId)) messageCache.set(chatId, []);
  const cached = messageCache.get(chatId);
  cached.push({
    id: msg.id._serialized,
    body: msg.body || '',
    fromMe: false,
    timestamp: msg.timestamp,
    senderName: msg._data?.notifyName || msg.author?.replace('@c.us', '') || '',
    type: msg.type,
    hasMedia: msg.hasMedia,
  });
  if (cached.length > MAX_CACHED_MESSAGES) cached.shift();
});

// Cache outgoing messages too
client.on('message_create', (msg) => {
  if (!msg.fromMe) return;
  const chatId = msg.to;
  if (!messageCache.has(chatId)) messageCache.set(chatId, []);
  const cached = messageCache.get(chatId);
  cached.push({
    id: msg.id._serialized,
    body: msg.body || '',
    fromMe: true,
    timestamp: msg.timestamp,
    senderName: 'You',
    type: msg.type,
    hasMedia: msg.hasMedia,
  });
  if (cached.length > MAX_CACHED_MESSAGES) cached.shift();
});

client.on('authenticated', () => {
  console.log('[WhatsApp] Authenticated');
});

client.on('auth_failure', (msg) => {
  console.error('[WhatsApp] Auth failure:', msg);
  clientStatus = 'disconnected';
  clientReady = false;
});

client.on('disconnected', (reason) => {
  console.log('[WhatsApp] Disconnected:', reason);
  clientStatus = 'disconnected';
  clientReady = false;
  qrCodeData = null;
});

// Routes
app.get('/status', (req, res) => {
  res.json({
    success: true,
    connected: clientReady,
    status: clientStatus,
  });
});

app.get('/qr', (req, res) => {
  if (clientReady) {
    return res.json({ success: true, connected: true, qr: null });
  }
  if (qrCodeData) {
    return res.json({ success: true, connected: false, qr: qrCodeData });
  }
  return res.json({ success: true, connected: false, qr: null, message: 'Initializing... try again in a few seconds' });
});

app.post('/send', async (req, res) => {
  if (!clientReady) {
    return res.status(400).json({ success: false, error: 'WhatsApp not connected' });
  }

  const { phone, group, message } = req.body;
  if ((!phone && !group) || !message) {
    return res.status(400).json({ success: false, error: 'phone or group name required, plus message' });
  }

  try {
    let chatId;

    if (group) {
      // Find group by name (case-insensitive partial match)
      const chats = await client.getChats();
      const match = chats.find(c => c.isGroup && c.name && c.name.toLowerCase().includes(group.toLowerCase()));
      if (!match) {
        return res.status(404).json({ success: false, error: `Group "${group}" not found. Available groups: ${chats.filter(c => c.isGroup).map(c => c.name).join(', ')}` });
      }
      chatId = match.id._serialized;
      console.log(`[WhatsApp] Resolved group "${group}" -> ${chatId} (${match.name})`);
    } else {
      // Format phone number: ensure it has country code and @c.us suffix
      chatId = phone.replace(/[^0-9]/g, '');
      if (!chatId.includes('@')) {
        chatId = chatId + '@c.us';
      }
    }

    const sentMsg = await client.sendMessage(chatId, message);
    console.log(`[WhatsApp] Message sent to ${chatId}`);
    res.json({ success: true, messageId: sentMsg.id._serialized });
  } catch (err) {
    console.error('[WhatsApp] Send error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/chats', async (req, res) => {
  if (!clientReady) {
    return res.status(400).json({ success: false, error: 'WhatsApp not connected' });
  }

  try {
    const chats = await client.getChats();
    const limit = parseInt(req.query.limit) || 20;
    const chatList = chats.slice(0, limit).map(chat => ({
      id: chat.id._serialized,
      name: chat.name || chat.pushname || chat.id.user,
      isGroup: chat.isGroup,
      unreadCount: chat.unreadCount,
      lastMessage: chat.lastMessage ? {
        body: chat.lastMessage.body?.substring(0, 200),
        timestamp: chat.lastMessage.timestamp,
        fromMe: chat.lastMessage.fromMe,
      } : null,
      timestamp: chat.timestamp,
    }));

    // Update cached list
    cachedChatList = chats.slice(0, 50).map(chat => ({
      id: chat.id._serialized,
      name: chat.name || chat.pushname || chat.id.user,
      isGroup: chat.isGroup,
      unreadCount: chat.unreadCount,
      timestamp: chat.timestamp,
    }));

    res.json({ success: true, chats: chatList });
  } catch (err) {
    console.error('[WhatsApp] Chats error:', err.message, '- using cached list');
    // Return cached chat list when getChats fails
    if (cachedChatList.length > 0) {
      const limit = parseInt(req.query.limit) || 20;
      return res.json({ success: true, chats: cachedChatList.slice(0, limit), cached: true });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/chat-messages/:chatId', async (req, res) => {
  if (!clientReady) {
    return res.status(400).json({ success: false, error: 'WhatsApp not connected' });
  }

  try {
    const chatId = req.params.chatId;
    const limit = parseInt(req.query.limit) || 100;

    // Get chat name first
    let chatName = chatId;
    try {
      const chat = await client.getChatById(chatId);
      chatName = chat.name || chat.pushname || chatId;
    } catch (e) {
      // Use cached chat list for name
      const cached = cachedChatList.find(c => c.id === chatId);
      if (cached) chatName = cached.name;
    }

    // Use searchMessages as a workaround for fetchMessages bug
    // Search with empty string returns recent messages from the chat
    let messages = [];
    try {
      // First try fetching directly (works for some chats)
      const chat = await client.getChatById(chatId);
      try { await chat.sendSeen(); } catch(e) {}

      // Build a contact name cache from group participants
      const contactNames = {};
      if (chat.isGroup) {
        try {
          const participants = chat.participants || [];
          for (const p of participants) {
            try {
              const contact = await client.getContactById(p.id._serialized);
              contactNames[p.id._serialized] = contact.pushname || contact.name || contact.shortName || p.id.user;
              // Also map @lid variants
              if (p.id._serialized.includes('@')) {
                contactNames[p.id.user] = contactNames[p.id._serialized];
              }
            } catch(e) {}
          }
        } catch(e) { console.log(`[WhatsApp] Could not load participants: ${e.message}`); }
      }

      const resolveNameFromMsg = (msg) => {
        if (msg.fromMe) return 'You';
        // Try notifyName first
        if (msg._data?.notifyName) return msg._data.notifyName;
        // Try author field
        const author = msg.author || msg.from || '';
        // Look up in contact cache
        if (contactNames[author]) return contactNames[author];
        // Try just the user part
        const userPart = author.split('@')[0];
        if (contactNames[userPart]) return contactNames[userPart];
        // Last resort: try getContactById
        return author;
      };

      const fetched = await chat.fetchMessages({ limit });

      // Resolve names asynchronously for any unresolved IDs
      const unresolvedIds = new Set();
      for (const msg of fetched) {
        const author = msg.author || msg.from || '';
        if (!msg.fromMe && !msg._data?.notifyName && !contactNames[author]) {
          unresolvedIds.add(author);
        }
      }
      for (const id of unresolvedIds) {
        try {
          const contact = await client.getContactById(id);
          contactNames[id] = contact.pushname || contact.name || contact.shortName || id.split('@')[0];
        } catch(e) {}
      }

      messages = fetched.map(msg => ({
        id: msg.id._serialized,
        body: msg.body || '',
        fromMe: msg.fromMe,
        timestamp: msg.timestamp,
        from: msg.from,
        senderName: resolveNameFromMsg(msg),
        type: msg.type,
        hasMedia: msg.hasMedia,
      }));
    } catch (fetchErr) {
      console.log(`[WhatsApp] fetchMessages failed: ${fetchErr.message}, trying searchMessages`);
      try {
        const searchResults = await client.searchMessages('', { chatId, limit, page: 1 });
        messages = searchResults.map(msg => ({
          id: msg.id._serialized,
          body: msg.body || '',
          fromMe: msg.fromMe,
          timestamp: msg.timestamp,
          from: msg.from,
          senderName: msg._data?.notifyName || (msg.fromMe ? 'You' : msg.author?.replace('@c.us', '') || ''),
          type: msg.type,
          hasMedia: msg.hasMedia,
        }));
      } catch (searchErr) {
        console.log(`[WhatsApp] searchMessages also failed: ${searchErr.message}`);
      }
    }

    if (messages.length === 0) {
      // Try message cache as final fallback
      const cached = messageCache.get(chatId) || [];
      if (cached.length > 0) {
        return res.json({ success: true, chatName, messages: cached.slice(-limit) });
      }
      return res.json({
        success: true,
        chatName,
        messages: [],
        note: 'No cached messages yet. New messages will appear after they are sent/received while connected.'
      });
    }

    res.json({ success: true, chatName, messages });
  } catch (err) {
    console.error('[WhatsApp] Messages error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/disconnect', async (req, res) => {
  try {
    await client.logout();
    clientStatus = 'disconnected';
    clientReady = false;
    qrCodeData = null;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/restart', async (req, res) => {
  try {
    clientStatus = 'disconnected';
    clientReady = false;
    qrCodeData = null;
    await client.destroy();
    setTimeout(() => client.initialize(), 2000);
    res.json({ success: true, message: 'Restarting...' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Start server and WhatsApp client
app.listen(PORT, () => {
  console.log(`[WhatsApp Connector] Running on port ${PORT}`);
  client.initialize();
});

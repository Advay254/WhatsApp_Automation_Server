require('dotenv').config();
const express = require('express');
const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');
const axios = require('axios');
const { usePostgresAuth } = require('./db');

const app = express();
app.use(express.json());

// CONFIG
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'secret123';
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;

let sock;
let sessionReady = false;

// 1. START WHATSAPP FUNCTION
async function startWhatsApp() {
    // A. Connect to DB and Auto-create table
    const { state, saveCreds, initDb } = await usePostgresAuth('session_1');
    await initDb(); 

    const { version } = await fetchLatestBaileysVersion();
    console.log(`Starting WhatsApp v${version.join('.')}`);

    // B. Initialize Socket
    sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: true,
    });

    // C. Handle Connection Events
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('❌ Connection closed. Reconnecting:', shouldReconnect);
            sessionReady = false;
            if (shouldReconnect) setTimeout(startWhatsApp, 3000);
        } else if (connection === 'open') {
            console.log('✅ Connected to WhatsApp!');
            sessionReady = true;
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // D. Message & Status Handler
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (msg.key.fromMe) continue;

            const isStatus = msg.key.remoteJid === 'status@broadcast';
            const isGroup = msg.key.remoteJid.endsWith('@g.us');
            const sender = msg.key.remoteJid;
            
            // Extract Body
            const body = msg.message?.conversation || 
                         msg.message?.extendedTextMessage?.text || 
                         msg.message?.imageMessage?.caption || 
                         (isStatus ? 'Status Update' : '');

            console.log(`📩 New ${isStatus ? 'Status' : 'Message'} from ${sender}: ${body.substring(0, 50)}...`);

            // Send to n8n
            if (N8N_WEBHOOK_URL) {
                try {
                    await axios.post(N8N_WEBHOOK_URL, {
                        event: isStatus ? 'status_update' : 'message',
                        from: sender.replace('@s.whatsapp.net', '').replace('@g.us', ''),
                        isGroup,
                        isStatus,
                        pushName: msg.pushName,
                        body,
                        messageId: msg.key.id,
                        fullMessage: msg
                    });
                } catch (e) { console.error('Webhook failed'); }
            }
        }
    });
}

// --- MIDDLEWARE ---
const authMiddleware = (req, res, next) => {
    if (req.headers['x-api-key'] !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
    next();
};

const checkSession = (req, res, next) => {
    if (!sessionReady) return res.status(503).json({ error: 'WhatsApp not connected' });
    next();
};

// --- API ENDPOINTS ---

/** * 1. AUTH & PAIRING 
 */
app.post('/pair', authMiddleware, async (req, res) => {
    if (sessionReady) return res.status(400).json({ error: 'Already connected' });
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'Phone number required' });

    try {
        if (!sock) await startWhatsApp();
        await delay(2000); 
        const code = await sock.requestPairingCode(phoneNumber);
        res.json({ status: 'success', pairingCode: code });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * 2. MESSAGING (Private & Group)
 */
app.post('/message/send', authMiddleware, checkSession, async (req, res) => {
    // "to" can be a phone number OR a group ID (123456@g.us)
    const { to, message, isGroup } = req.body;
    let jid = to;
    
    if (!isGroup && !to.includes('@')) {
        jid = `${to}@s.whatsapp.net`;
    }

    try {
        await sock.sendMessage(jid, { text: message });
        res.json({ status: 'success' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/message/reply', authMiddleware, checkSession, async (req, res) => {
    // Requires the original message object (or parts of it) to quote it
    const { to, message, originalMessageId } = req.body;
    // NOTE: For full quoting, you'd usually pass the full `msg` object stored in DB.
    // For simple context, we just send to the JID.
    // Advanced quoting requires the full message object context.
    
    // Simple reply (just sending text to chat)
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message }); 
    res.json({ status: 'success' });
});

/**
 * 3. REACTIONS
 * React to a specific message with an emoji
 */
app.post('/message/react', authMiddleware, checkSession, async (req, res) => {
    const { to, messageId, emoji } = req.body;
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;

    try {
        await sock.sendMessage(jid, {
            react: {
                text: emoji, // e.g., "👍"
                key: { remoteJid: jid, fromMe: false, id: messageId } // fromMe: false usually if reacting to others
            }
        });
        res.json({ status: 'success' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * 4. MEDIA MESSAGES
 * Send Image/Video from URL
 */
app.post('/message/media', authMiddleware, checkSession, async (req, res) => {
    const { to, url, type, caption } = req.body; // type: 'image' or 'video'
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;

    try {
        const mediaObject = type === 'video' 
            ? { video: { url }, caption, gifPlayback: false }
            : { image: { url }, caption };

        await sock.sendMessage(jid, mediaObject);
        res.json({ status: 'success' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * 5. STATUS (STORIES)
 * View or Post Status
 */

// Post a Text Status
app.post('/status/text', authMiddleware, checkSession, async (req, res) => {
    const { text, backgroundColor } = req.body; // Hex color e.g., #FF0000
    try {
        await sock.sendMessage('status@broadcast', { 
            text: text, 
            backgroundArgb: backgroundColor ? parseInt(backgroundColor.replace('#',''), 16) : 0xFFFFFFFF 
        });
        res.json({ status: 'posted' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Post Media Status
app.post('/status/media', authMiddleware, checkSession, async (req, res) => {
    const { url, type, caption } = req.body;
    try {
        const mediaObject = type === 'video' 
            ? { video: { url }, caption } 
            : { image: { url }, caption };
            
        await sock.sendMessage('status@broadcast', mediaObject);
        res.json({ status: 'posted' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * 6. GROUP MANAGEMENT
 */

// Get list of groups
app.get('/groups', authMiddleware, checkSession, async (req, res) => {
    try {
        const groups = await sock.groupFetchAllParticipating();
        res.json(groups);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create Group
app.post('/groups/create', authMiddleware, checkSession, async (req, res) => {
    const { subject, participants } = req.body; // participants = ["2547...", "2547..."]
    try {
        // Format numbers to JIDs
        const pJids = participants.map(p => p.includes('@') ? p : `${p}@s.whatsapp.net`);
        const group = await sock.groupCreate(subject, pJids);
        res.json({ status: 'created', groupId: group.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    startWhatsApp(); // Starts and runs Auto-DB setup
});

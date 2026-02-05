// --- 1. THE CRYPTO FIX (MUST BE AT THE TOP) ---
const crypto = require('crypto');
if (!global.crypto) {
    global.crypto = crypto;
}

require('dotenv').config();
const express = require('express');
const { default: makeWASocket, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');
const axios = require('axios');
const { usePostgresAuth, initDb } = require('./db');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const N8N_WEBHOOK = process.env.N8N_WEBHOOK_URL;

let sock;
let isConnected = false;

async function startWhatsApp() {
    await initDb(); // Auto-create table
    const { state, saveCreds } = await usePostgresAuth('main_session');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        // FIX: Removed hardcoded 'version' and 'browser' to allow Baileys to auto-detect the best config.
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            isConnected = false;
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('❌ Connection lost. Reconnecting in 3s:', shouldReconnect);
            
            // FIX: Added timeout to prevent rapid reconnection loops
            if (shouldReconnect) {
                setTimeout(startWhatsApp, 3000);
            }
        } else if (connection === 'open') {
            isConnected = true;
            console.log('✅ WhatsApp Connected!');
        }
    });

    // Handle Incoming Messages & Statuses
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (msg.key.fromMe) return;

        const data = {
            event: msg.key.remoteJid === 'status@broadcast' ? 'status_update' : 'message',
            from: msg.key.remoteJid,
            pushName: msg.pushName,
            body: msg.message?.conversation || msg.message?.extendedTextMessage?.text || "Media Message",
            msg: msg
        };

        if (N8N_WEBHOOK) {
            axios.post(N8N_WEBHOOK, data).catch(e => console.log("Webhook failed"));
        }
    });
}

// --- MIDDLEWARE ---
const auth = (req, res, next) => {
    if (req.headers['x-api-key'] !== API_KEY) return res.status(401).json({ error: "Invalid API Key" });
    next();
};

// --- ENDPOINTS ---

// FIX: New endpoint to clear bad session data
app.get('/reset-session', async (req, res) => {
    try {
        const { Pool } = require('pg');
        const pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false }
        });
        await pool.query('DELETE FROM wa_sessions'); // Clear the table
        await pool.end();
        console.log("Database cleared via reset endpoint.");
        res.send("✅ Session cleared. The server will now likely restart or you can manually trigger a deploy.");
        process.exit(0); // Restart server to pick up empty state
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// 1. Pairing
app.post('/pair', auth, async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: "Phone number required" });
    try {
        if (!sock) {
             return res.status(503).json({ error: "WhatsApp not initialized yet" });
        }
        const code = await sock.requestPairingCode(phoneNumber.replace(/[^\d]/g, ''));
        res.json({ code });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 2. Sending Messages (Supports Replies)
app.post('/message/send', auth, async (req, res) => {
    const { to, message, quoting } = req.body;
    try {
        const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: message }, { quoted: quoting });
        res.json({ status: "Sent" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 3. Media (Image/Video)
app.post('/message/media', auth, async (req, res) => {
    const { to, url, type, caption } = req.body;
    try {
        const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
        const content = type === 'video' ? { video: { url }, caption } : { image: { url }, caption };
        await sock.sendMessage(jid, content);
        res.json({ status: "Media Sent" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 4. Reactions
app.post('/message/react', auth, async (req, res) => {
    const { to, messageId, emoji } = req.body;
    try {
        const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
        await sock.sendMessage(jid, { react: { text: emoji, key: { remoteJid: jid, fromMe: false, id: messageId } } });
        res.json({ status: "Reacted" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 5. Status Updates
app.post('/status/post', auth, async (req, res) => {
    const { text, url, type } = req.body;
    try {
        const content = url 
            ? (type === 'video' ? { video: { url }, caption: text } : { image: { url }, caption: text })
            : { text };
        await sock.sendMessage('status@broadcast', content);
        res.json({ status: "Status Posted" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 6. Group List
app.get('/groups', auth, async (req, res) => {
    try {
        const groups = await sock.groupFetchAllParticipating();
        res.json(groups);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    startWhatsApp();
});
        

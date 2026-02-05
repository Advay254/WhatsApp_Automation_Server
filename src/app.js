// --- 1. THE CRYPTO FIX ---
const crypto = require('crypto');
if (!global.crypto) {
    global.crypto = crypto;
}

require('dotenv').config();
const express = require('express');
const { default: makeWASocket, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');
const axios = require('axios');
const { usePostgresAuth, initDb, clearSession } = require('./db');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const N8N_WEBHOOK = process.env.N8N_WEBHOOK_URL;

let sock;
let isConnected = false;
let retryCount = 0;
const MAX_RETRIES = 5; // Max rapid retries before we wipe data

async function startWhatsApp() {
    await initDb();
    const { state, saveCreds, clearSession: clearDB } = await usePostgresAuth('main_session');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        connectTimeoutMs: 60000, // Give it time to connect
        defaultQueryTimeoutMs: 60000,
        // Removed hardcoded version/browser to let Baileys handle it
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            isConnected = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log(`❌ Connection closed. Status: ${statusCode}, Reconnecting: ${shouldReconnect}`);

            // CASE 1: Session is invalid (Logged Out) -> Wipe DB and restart fresh
            if (statusCode === DisconnectReason.loggedOut) {
                console.log("⚠️ Session invalid (Logged Out). Clearing DB and restarting...");
                await clearDB('main_session');
                sock = null; // Clear socket instance
                retryCount = 0;
                startWhatsApp(); 
                return;
            }

            // CASE 2: Rapid crash loop detection
            if (shouldReconnect) {
                retryCount++;
                if (retryCount >= MAX_RETRIES) {
                    console.log("🚨 Too many consecutive crashes! Clearing corrupted session data...");
                    await clearDB('main_session'); // NUCLEAR OPTION: Wipe the bad data
                    retryCount = 0;
                    sock = null;
                }
                
                // Wait 5s before retrying to stop the CPU loop
                setTimeout(startWhatsApp, 5000); 
            }

        } else if (connection === 'open') {
            isConnected = true;
            retryCount = 0; // Reset crash counter on success
            console.log('✅ WhatsApp Connected!');
        }
    });

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

// Manual Reset Endpoint (Just in case)
app.get('/reset-session', async (req, res) => {
    try {
        await clearSession('main_session');
        if (sock) sock.end(undefined); // Kill current socket
        res.send("✅ Session cleared. Server restarting...");
        process.exit(0); // Force restart
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.post('/pair', auth, async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: "Phone number required" });
    
    // Check if sock exists, if not, try to initialize it
    if (!sock) {
        return res.status(503).json({ error: "WhatsApp is initializing, please wait 5 seconds and try again." });
    }

    try {
        // Request code
        const code = await sock.requestPairingCode(phoneNumber.replace(/[^\d]/g, ''));
        res.json({ code });
    } catch (e) {
        // If it fails, it usually means the socket is not ready. 
        res.status(500).json({ error: "Failed to generate code. Server might be reconnecting. Wait 10s and try again." });
    }
});

// Message sending
app.post('/message/send', auth, async (req, res) => {
    const { to, message, quoting } = req.body;
    try {
        if (!sock) throw new Error("WhatsApp not connected");
        const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: message }, { quoted: quoting });
        res.json({ status: "Sent" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Media
app.post('/message/media', auth, async (req, res) => {
    const { to, url, type, caption } = req.body;
    try {
        if (!sock) throw new Error("WhatsApp not connected");
        const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
        const content = type === 'video' ? { video: { url }, caption } : { image: { url }, caption };
        await sock.sendMessage(jid, content);
        res.json({ status: "Media Sent" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Status
app.post('/status/post', auth, async (req, res) => {
    const { text, url, type } = req.body;
    try {
        if (!sock) throw new Error("WhatsApp not connected");
        const content = url 
            ? (type === 'video' ? { video: { url }, caption: text } : { image: { url }, caption: text })
            : { text };
        await sock.sendMessage('status@broadcast', content);
        res.json({ status: "Status Posted" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    startWhatsApp();
});
        

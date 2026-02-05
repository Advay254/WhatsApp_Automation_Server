// --- 1. THE CRYPTO FIX (MUST BE AT THE TOP) ---
const crypto = require('crypto');
if (!global.crypto) {
    global.crypto = crypto;
}

require('dotenv').config();
const express = require('express');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
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
let qrCode = null;
let pairingCode = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

async function startWhatsApp() {
    try {
        await initDb();
        
        // Get latest Baileys version (critical for stability)
        const { version } = await fetchLatestBaileysVersion();
        console.log(`📱 Using WA version: ${version.join('.')}`);
        
        const { state, saveCreds } = await usePostgresAuth('main_session');

        sock = makeWASocket({
            auth: state,
            printQRInTerminal: true, // Enable for debugging
            logger: pino({ level: 'warn' }), // Changed from silent to see warnings
            version,
            browser: ["WhatsApp Automation", "Chrome", "4.0.0"],
            connectTimeoutMs: 60000, // Increase timeout
            defaultQueryTimeoutMs: undefined,
            keepAliveIntervalMs: 30000,
            emitOwnEvents: true,
            markOnlineOnConnect: false, // Don't auto mark online
            syncFullHistory: false, // Don't sync full history (saves resources)
            getMessage: async () => ({ conversation: '' }) // Required for some features
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            // Store QR code if generated
            if (qr) {
                qrCode = qr;
                console.log('🔐 QR Code generated (check logs or use /qr endpoint)');
            }

            if (connection === 'close') {
                isConnected = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const reason = DisconnectReason[statusCode] || 'Unknown';
                
                console.log(`❌ Connection closed. Reason: ${reason} (Code: ${statusCode})`);
                
                // Don't reconnect on logout or banned
                const shouldNotReconnect = [
                    DisconnectReason.loggedOut,
                    DisconnectReason.forbidden,
                    DisconnectReason.badSession
                ].includes(statusCode);

                if (shouldNotReconnect) {
                    console.log('🛑 Not reconnecting. Clear session and re-pair.');
                    reconnectAttempts = 0;
                    return;
                }

                // Exponential backoff for reconnection
                if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                    reconnectAttempts++;
                    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
                    console.log(`🔄 Reconnecting in ${delay/1000}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
                    setTimeout(startWhatsApp, delay);
                } else {
                    console.log('🛑 Max reconnect attempts reached. Manual intervention needed.');
                    reconnectAttempts = 0;
                }

            } else if (connection === 'open') {
                isConnected = true;
                reconnectAttempts = 0;
                qrCode = null;
                pairingCode = null;
                console.log('✅ WhatsApp Connected Successfully!');
            } else if (connection === 'connecting') {
                console.log('🔌 Connecting to WhatsApp...');
            }
        });

        // Handle Incoming Messages
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            const msg = messages[0];
            if (msg.key.fromMe) return;

            const data = {
                event: msg.key.remoteJid === 'status@broadcast' ? 'status_update' : 'message',
                from: msg.key.remoteJid,
                pushName: msg.pushName,
                body: msg.message?.conversation || msg.message?.extendedTextMessage?.text || "Media Message",
                messageId: msg.key.id,
                timestamp: msg.messageTimestamp
            };

            console.log(`📨 Message from ${data.pushName}: ${data.body}`);

            if (N8N_WEBHOOK) {
                axios.post(N8N_WEBHOOK, data).catch(e => console.log("⚠️ Webhook failed:", e.message));
            }
        });

    } catch (error) {
        console.error('💥 Fatal error in startWhatsApp:', error);
        setTimeout(startWhatsApp, 10000); // Retry after 10s
    }
}

// --- MIDDLEWARE ---
const auth = (req, res, next) => {
    const apiKey = req.headers['x-api-key'] || req.query.apiKey;
    if (apiKey !== API_KEY) {
        return res.status(401).json({ error: "Invalid API Key" });
    }
    next();
};

// --- ENDPOINTS ---

// Health Check
app.get('/health', (req, res) => {
    res.json({
        status: 'running',
        connected: isConnected,
        timestamp: new Date().toISOString()
    });
});

// Get QR Code (if not using pairing code)
app.get('/qr', auth, (req, res) => {
    if (!qrCode) {
        return res.status(404).json({ error: "No QR code available. Try /pair endpoint instead." });
    }
    res.json({ qr: qrCode });
});

// Request Pairing Code (FIXED)
app.post('/pair', auth, async (req, res) => {
    try {
        let { phoneNumber } = req.body;
        
        if (!phoneNumber) {
            return res.status(400).json({ error: "Phone number required (e.g., 254712345678)" });
        }

        // Clean phone number (remove all non-digits)
        phoneNumber = phoneNumber.replace(/\D/g, '');
        
        // Validate format
        if (phoneNumber.length < 10 || phoneNumber.length > 15) {
            return res.status(400).json({ error: "Invalid phone number format" });
        }

        console.log(`🔐 Requesting pairing code for: ${phoneNumber}`);

        // Request pairing code
        const code = await sock.requestPairingCode(phoneNumber);
        pairingCode = code;
        
        console.log(`✅ Pairing code generated: ${code}`);
        
        res.json({
            success: true,
            code,
            phoneNumber,
            instructions: "Enter this 8-digit code in WhatsApp > Linked Devices > Link a Device > Link with phone number instead"
        });

    } catch (error) {
        console.error('❌ Pairing error:', error);
        res.status(500).json({
            error: error.message,
            hint: "Make sure WhatsApp connection is active. Try restarting the service."
        });
    }
});

// Clear Session (Force Re-pair)
app.post('/session/clear', auth, async (req, res) => {
    try {
        const { Pool } = require('pg');
        const pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false }
        });
        await pool.query('DELETE FROM wa_sessions WHERE session_id = $1', ['main_session']);
        res.json({ status: "Session cleared. Restart service to re-pair." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Send Message
app.post('/message/send', auth, async (req, res) => {
    if (!isConnected) {
        return res.status(503).json({ error: "WhatsApp not connected" });
    }

    const { to, message, quoting } = req.body;
    
    if (!to || !message) {
        return res.status(400).json({ error: "Missing 'to' or 'message' field" });
    }

    try {
        const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: message }, quoting ? { quoted: quoting } : {});
        res.json({ status: "Sent", to: jid });
    } catch (e) {
        console.error('Send error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Send Media
app.post('/message/media', auth, async (req, res) => {
    if (!isConnected) {
        return res.status(503).json({ error: "WhatsApp not connected" });
    }

    const { to, url, type, caption } = req.body;
    
    if (!to || !url) {
        return res.status(400).json({ error: "Missing 'to' or 'url' field" });
    }

    try {
        const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
        const content = type === 'video' 
            ? { video: { url }, caption: caption || '' }
            : { image: { url }, caption: caption || '' };
        
        await sock.sendMessage(jid, content);
        res.json({ status: "Media Sent", to: jid });
    } catch (e) {
        console.error('Media send error:', e);
        res.status(500).json({ error: e.message });
    }
});

// React to Message
app.post('/message/react', auth, async (req, res) => {
    if (!isConnected) {
        return res.status(503).json({ error: "WhatsApp not connected" });
    }

    const { to, messageId, emoji } = req.body;
    
    try {
        const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
        await sock.sendMessage(jid, {
            react: {
                text: emoji,
                key: { remoteJid: jid, fromMe: false, id: messageId }
            }
        });
        res.json({ status: "Reacted" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Post Status
app.post('/status/post', auth, async (req, res) => {
    if (!isConnected) {
        return res.status(503).json({ error: "WhatsApp not connected" });
    }

    const { text, url, type } = req.body;
    
    try {
        const content = url 
            ? (type === 'video' ? { video: { url }, caption: text } : { image: { url }, caption: text })
            : { text };
        
        await sock.sendMessage('status@broadcast', content);
        res.json({ status: "Status Posted" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Get Groups
app.get('/groups', auth, async (req, res) => {
    if (!isConnected) {
        return res.status(503).json({ error: "WhatsApp not connected" });
    }

    try {
        const groups = await sock.groupFetchAllParticipating();
        const groupList = Object.values(groups).map(g => ({
            id: g.id,
            name: g.subject,
            participants: g.participants.length
        }));
        res.json(groupList);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📡 Health check: http://localhost:${PORT}/health`);
    startWhatsApp();
});

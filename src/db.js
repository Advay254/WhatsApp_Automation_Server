const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const initDb = async () => {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS wa_sessions (
                session_id VARCHAR(128) NOT NULL,
                id VARCHAR(128) NOT NULL,
                data TEXT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                PRIMARY KEY (session_id, id)
            );
        `);
        console.log('✅ Database table wa_sessions is ready.');
    } catch (err) {
        console.error('❌ DB Initialization Error:', err);
    } finally {
        client.release();
    }
};

const clearSession = async (sessionId) => {
    try {
        await pool.query('DELETE FROM wa_sessions WHERE session_id = $1', [sessionId]);
        console.log(`🗑️ Session '${sessionId}' cleared from DB.`);
    } catch (e) {
        console.error('❌ Failed to clear session:', e);
    }
};

const usePostgresAuth = async (sessionId) => {
    const { proto, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

    const readData = async (id) => {
        try {
            const res = await pool.query('SELECT data FROM wa_sessions WHERE session_id = $1 AND id = $2', [sessionId, id]);
            if (res.rows.length === 0) return null;
            return JSON.parse(res.rows[0].data, BufferJSON.reviver);
        } catch (e) { return null; }
    };

    const writeData = async (id, data) => {
        try {
            await pool.query(
                `INSERT INTO wa_sessions (session_id, id, data) VALUES ($1, $2, $3)
                 ON CONFLICT (session_id, id) DO UPDATE SET data = $3`,
                [sessionId, id, JSON.stringify(data, BufferJSON.replacer)]
            );
        } catch (e) {
            console.error(`Error writing ${id}:`, e.message);
        }
    };

    const removeData = async (id) => {
        try {
            await pool.query('DELETE FROM wa_sessions WHERE session_id = $1 AND id = $2', [sessionId, id]);
        } catch (e) {
            console.error(`Error deleting ${id}:`, e.message);
        }
    };

    const creds = await readData('creds') || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        if (value) data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            value ? await writeData(key, value) : await removeData(key);
                        }
                    }
                }
            }
        },
        saveCreds: async () => await writeData('creds', creds),
        clearSession // Exporting this so app.js can use it
    };
};

module.exports = { usePostgresAuth, initDb, clearSession };
            

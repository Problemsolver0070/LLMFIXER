const { Pool } = require('pg');
const Database = require('better-sqlite3');
const path = require('path');
const encryption = require('./encryption');

// Sensitive credential fields that get envelope-encrypted at rest.
const ENCRYPTED_CRED_FIELDS = ['openai_key', 'anthropic_key', 'google_refresh_token'];

function encryptCreds(creds) {
    const out = { ...creds };
    for (const f of ENCRYPTED_CRED_FIELDS) {
        if (out[f]) out[f] = encryption.encrypt(out[f]);
    }
    return out;
}

function decryptCredsRow(row) {
    if (!row) return row;
    const out = { ...row };
    for (const f of ENCRYPTED_CRED_FIELDS) {
        if (out[f]) {
            try {
                out[f] = encryption.decrypt(out[f]);
            } catch (e) {
                console.error(`[VAULT] Failed to decrypt ${f} for user_id=${out.user_id}:`, e.message);
                out[f] = null;
            }
        }
    }
    return out;
}

const IS_PROD = process.env.NODE_ENV === 'production';

// Abstracted Database Interface
let db, pgPool;

if (IS_PROD) {
    // Azure Database for PostgreSQL Flexible Server requires SSL.
    // Support either a single DATABASE_URL or discrete env vars.
    const sslConfig = { rejectUnauthorized: false };
    const poolOpts = {
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
        ssl: sslConfig,
    };

    if (process.env.DATABASE_URL) {
        pgPool = new Pool({ ...poolOpts, connectionString: process.env.DATABASE_URL });
    } else {
        pgPool = new Pool({
            ...poolOpts,
            user: process.env.DB_USER,
            host: process.env.DB_HOST,
            database: process.env.DB_NAME,
            password: process.env.DB_PASSWORD,
            port: process.env.DB_PORT || 5432,
        });
    }
    console.log("[VAULT] Initialized PostgreSQL connection pool (SSL enabled) for Azure Flexible Server.");
    
    // Auto-migrate tables (PostgreSQL syntax)
    pgPool.query(`
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            current_briefing TEXT
        );

        CREATE TABLE IF NOT EXISTS messages (
            id SERIAL PRIMARY KEY,
            session_id TEXT REFERENCES sessions(id),
            user_id TEXT NOT NULL,
            role TEXT,
            content TEXT,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS analytics (
            id SERIAL PRIMARY KEY,
            session_id TEXT,
            user_id TEXT NOT NULL,
            model TEXT,
            naive_tokens INTEGER,
            optimized_tokens INTEGER,
            tokens_saved INTEGER,
            estimated_savings_cents REAL,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS user_credentials (
            user_id TEXT PRIMARY KEY,
            openai_key TEXT,
            anthropic_key TEXT,
            google_refresh_token TEXT,
            google_project_id TEXT,
            google_client_email TEXT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `).catch(err => console.error("Cloud SQL Migration Error:", err));

} else {
    // Local SQLite setup
    const dbPath = path.join(__dirname, 'vault.db');
    db = new Database(dbPath);
    console.log("[VAULT] Initialized SQLite local database.");
    
    // Create tables for sessions and messages with multi-tenancy
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        current_briefing TEXT
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        user_id TEXT NOT NULL,
        role TEXT,
        content TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS analytics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        user_id TEXT NOT NULL,
        model TEXT,
        naive_tokens INTEGER,
        optimized_tokens INTEGER,
        tokens_saved INTEGER,
        estimated_savings_cents REAL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS user_credentials (
        user_id TEXT PRIMARY KEY,
        openai_key TEXT,
        anthropic_key TEXT,
        google_refresh_token TEXT,
        google_project_id TEXT,
        google_client_email TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
}

/**
 * Ensures a session exists, creates if not.
 */
async function ensureSession(sessionId, userId) {
    if (IS_PROD) {
        await pgPool.query('INSERT INTO sessions (id, user_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [sessionId, userId]);
    } else {
        const stmt = db.prepare('INSERT OR IGNORE INTO sessions (id, user_id) VALUES (?, ?)');
        stmt.run(sessionId, userId);
    }
}

/**
 * Stores a full array of messages for a session.
 */
async function storeMessages(sessionId, userId, messages) {
  await ensureSession(sessionId, userId);
  
  if (IS_PROD) {
      // Security check
      const checkRes = await pgPool.query('SELECT id FROM sessions WHERE id = $1 AND user_id = $2', [sessionId, userId]);
      if (checkRes.rows.length === 0) throw new Error("Unauthorized: Session does not belong to user");

      const client = await pgPool.connect();
      try {
          await client.query('BEGIN');
          await client.query('DELETE FROM messages WHERE session_id = $1 AND user_id = $2', [sessionId, userId]);
          
          for (const msg of messages) {
              const contentStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
              await client.query('INSERT INTO messages (session_id, user_id, role, content) VALUES ($1, $2, $3, $4)', [sessionId, userId, msg.role, contentStr]);
          }
          await client.query('COMMIT');
      } catch (e) {
          await client.query('ROLLBACK');
          throw e;
      } finally {
          client.release();
      }
  } else {
      // Security check: ensure the session belongs to the user
      const check = db.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?').get(sessionId, userId);
      if (!check) throw new Error("Unauthorized: Session does not belong to user");

      const deleteStmt = db.prepare('DELETE FROM messages WHERE session_id = ? AND user_id = ?');
      deleteStmt.run(sessionId, userId);

      const insertStmt = db.prepare('INSERT INTO messages (session_id, user_id, role, content) VALUES (?, ?, ?, ?)');
      
      const insertMany = db.transaction((msgs) => {
        for (const msg of msgs) {
          const contentStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          insertStmt.run(sessionId, userId, msg.role, contentStr);
        }
      });

      insertMany(messages);
  }
}

/**
 * Retrieves the dense briefing for a session.
 */
async function getBriefing(sessionId, userId) {
    if (IS_PROD) {
        const res = await pgPool.query('SELECT current_briefing FROM sessions WHERE id = $1 AND user_id = $2', [sessionId, userId]);
        return res.rows.length > 0 ? res.rows[0].current_briefing : null;
    } else {
        const stmt = db.prepare('SELECT current_briefing FROM sessions WHERE id = ? AND user_id = ?');
        const row = stmt.get(sessionId, userId);
        return row ? row.current_briefing : null;
    }
}

/**
 * Updates the dense briefing for a session.
 */
async function updateBriefing(sessionId, userId, briefing) {
  await ensureSession(sessionId, userId);
  if (IS_PROD) {
      await pgPool.query('UPDATE sessions SET current_briefing = $1 WHERE id = $2 AND user_id = $3', [briefing, sessionId, userId]);
  } else {
      const stmt = db.prepare('UPDATE sessions SET current_briefing = ? WHERE id = ? AND user_id = ?');
      stmt.run(briefing, sessionId, userId);
  }
}

/**
 * Tool: Search conversation history
 */
async function searchHistory(sessionId, userId, query) {
  let results;
  if (IS_PROD) {
      const res = await pgPool.query(`
        SELECT role, content 
        FROM messages 
        WHERE session_id = $1 AND user_id = $2 AND content ILIKE $3
        ORDER BY timestamp ASC
      `, [sessionId, userId, `%${query}%`]);
      results = res.rows;
  } else {
      const stmt = db.prepare(`
        SELECT role, content 
        FROM messages 
        WHERE session_id = ? AND user_id = ? AND content LIKE ?
        ORDER BY timestamp ASC
      `);
      results = stmt.all(sessionId, userId, `%${query}%`);
  }
  
  if (results.length === 0) {
    return "No relevant history found for that query.";
  }
  
  return results.map(r => `[${r.role.toUpperCase()}]: ${r.content.substring(0, 500)}${r.content.length > 500 ? '...' : ''}`).join('\n\n');
}

/**
 * Logs analytics for a request
 */
async function logAnalytics(sessionId, userId, model, naiveTokens, optimizedTokens, savingsCents) {
    if (IS_PROD) {
        await pgPool.query(`
            INSERT INTO analytics (session_id, user_id, model, naive_tokens, optimized_tokens, tokens_saved, estimated_savings_cents)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [sessionId, userId, model, naiveTokens, optimizedTokens, Math.max(0, naiveTokens - optimizedTokens), savingsCents]);
    } else {
        const stmt = db.prepare(`
            INSERT INTO analytics (session_id, user_id, model, naive_tokens, optimized_tokens, tokens_saved, estimated_savings_cents)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(sessionId, userId, model, naiveTokens, optimizedTokens, Math.max(0, naiveTokens - optimizedTokens), savingsCents);
    }
}

/**
 * Fetches global analytics
 */
async function getGlobalStats(userId) {
    let totals, recent;
    
    if (IS_PROD) {
        if (userId === 'ADMIN_VIEW') {
            const tRes = await pgPool.query(`
                SELECT 
                    COUNT(*) as total_requests,
                    SUM(naive_tokens) as total_naive_tokens,
                    SUM(optimized_tokens) as total_optimized_tokens,
                    SUM(tokens_saved) as total_tokens_saved,
                    SUM(estimated_savings_cents) as total_savings_cents
                FROM analytics
            `);
            totals = tRes.rows[0];
        
            const rRes = await pgPool.query(`
                SELECT user_id, model, naive_tokens, optimized_tokens, tokens_saved, estimated_savings_cents, timestamp
                FROM analytics
                ORDER BY timestamp DESC
                LIMIT 20
            `);
            recent = rRes.rows;
        } else {
            const tRes = await pgPool.query(`
                SELECT 
                    COUNT(*) as total_requests,
                    SUM(naive_tokens) as total_naive_tokens,
                    SUM(optimized_tokens) as total_optimized_tokens,
                    SUM(tokens_saved) as total_tokens_saved,
                    SUM(estimated_savings_cents) as total_savings_cents
                FROM analytics
                WHERE user_id = $1
            `, [userId]);
            totals = tRes.rows[0];
        
            const rRes = await pgPool.query(`
                SELECT model, naive_tokens, optimized_tokens, tokens_saved, estimated_savings_cents, timestamp
                FROM analytics
                WHERE user_id = $1
                ORDER BY timestamp DESC
                LIMIT 20
            `, [userId]);
            recent = rRes.rows;
        }
    } else {
        if (userId === 'ADMIN_VIEW') {
            totals = db.prepare(`
                SELECT 
                    COUNT(*) as total_requests,
                    SUM(naive_tokens) as total_naive_tokens,
                    SUM(optimized_tokens) as total_optimized_tokens,
                    SUM(tokens_saved) as total_tokens_saved,
                    SUM(estimated_savings_cents) as total_savings_cents
                FROM analytics
            `).get();
        
            recent = db.prepare(`
                SELECT user_id, model, naive_tokens, optimized_tokens, tokens_saved, estimated_savings_cents, timestamp
                FROM analytics
                ORDER BY timestamp DESC
                LIMIT 20
            `).all();
        } else {
            totals = db.prepare(`
                SELECT 
                    COUNT(*) as total_requests,
                    SUM(naive_tokens) as total_naive_tokens,
                    SUM(optimized_tokens) as total_optimized_tokens,
                    SUM(tokens_saved) as total_tokens_saved,
                    SUM(estimated_savings_cents) as total_savings_cents
                FROM analytics
                WHERE user_id = ?
            `).get(userId);
        
            recent = db.prepare(`
                SELECT model, naive_tokens, optimized_tokens, tokens_saved, estimated_savings_cents, timestamp
                FROM analytics
                WHERE user_id = ?
                ORDER BY timestamp DESC
                LIMIT 20
            `).all(userId);
        }
    }

    return { totals, recent };
}

/**
 * Triggers an asynchronous background job to update the briefing.
 * We do not await this in the critical path.
 */
function triggerBackgroundBriefing(sessionId, userId, optimizerKey, optimizerObj) {
    // Fire and forget background promise
    setTimeout(async () => {
        try {
            console.log(`[BACKGROUND] Starting pre-computation for session ${sessionId}`);
            // Fetch the full history
            let messages;
            if (IS_PROD) {
                const res = await pgPool.query('SELECT role, content FROM messages WHERE session_id = $1 AND user_id = $2 ORDER BY timestamp ASC', [sessionId, userId]);
                messages = res.rows;
            } else {
                messages = db.prepare('SELECT role, content FROM messages WHERE session_id = ? AND user_id = ? ORDER BY timestamp ASC').all(sessionId, userId);
            }

            if (messages.length > 4) {
                const briefing = await optimizerObj.generateDenseBriefing(messages, optimizerKey);
                if (briefing) {
                    await updateBriefing(sessionId, userId, briefing);
                    console.log(`[BACKGROUND] Successfully pre-computed briefing for session ${sessionId}`);
                }
            }
        } catch (e) {
            console.error(`[BACKGROUND] Failed to pre-compute briefing for ${sessionId}:`, e.message);
        }
    }, 0);
}

/**
 * Securely fetches a user's third-party credentials
 */
async function getUserCredentials(userId) {
    let row;
    if (IS_PROD) {
        const res = await pgPool.query('SELECT * FROM user_credentials WHERE user_id = $1', [userId]);
        row = res.rows.length > 0 ? res.rows[0] : null;
    } else {
        const stmt = db.prepare('SELECT * FROM user_credentials WHERE user_id = ?');
        row = stmt.get(userId) || null;
    }
    return decryptCredsRow(row);
}

/**
 * Save BYOK credentials for a user. Sensitive fields are envelope-encrypted
 * (AES-256-GCM with the master key wrapped in Azure Key Vault) before persistence.
 */
async function saveUserCredentials(userId, creds) {
    const enc = encryptCreds(creds);
    if (IS_PROD) {
        await pgPool.query(`
            INSERT INTO user_credentials (user_id, openai_key, anthropic_key, google_refresh_token, google_project_id, google_client_email)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (user_id) DO UPDATE SET
                openai_key = EXCLUDED.openai_key,
                anthropic_key = EXCLUDED.anthropic_key,
                google_refresh_token = EXCLUDED.google_refresh_token,
                google_project_id = EXCLUDED.google_project_id,
                google_client_email = EXCLUDED.google_client_email,
                updated_at = CURRENT_TIMESTAMP
        `, [userId, enc.openai_key, enc.anthropic_key, enc.google_refresh_token, enc.google_project_id, enc.google_client_email]);
    } else {
        const stmt = db.prepare(`
            INSERT INTO user_credentials (user_id, openai_key, anthropic_key, google_refresh_token, google_project_id, google_client_email)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (user_id) DO UPDATE SET
                openai_key = excluded.openai_key,
                anthropic_key = excluded.anthropic_key,
                google_refresh_token = excluded.google_refresh_token,
                google_project_id = excluded.google_project_id,
                google_client_email = excluded.google_client_email,
                updated_at = CURRENT_TIMESTAMP
        `);
        stmt.run(userId, enc.openai_key, enc.anthropic_key, enc.google_refresh_token, enc.google_project_id, enc.google_client_email);
    }
}

module.exports = {
  db,
  ensureSession,
  storeMessages,
  getBriefing,
  updateBriefing,
  searchHistory,
  logAnalytics,
  getGlobalStats,
  triggerBackgroundBriefing,
  getUserCredentials,
  saveUserCredentials
};

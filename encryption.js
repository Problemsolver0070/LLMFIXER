const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;        // GCM standard
const PREFIX = 'gcm:v1:';     // versioned so we can rotate the algo cleanly later

let masterKey = null;

/**
 * Loads the BYOK master key from Azure Key Vault (or local env in dev) into memory.
 * Must be awaited before any encrypt/decrypt call.
 */
async function init() {
    if (masterKey) return;

    const kvUri = process.env.AZURE_KEY_VAULT_URI;
    const secretName = process.env.BYOK_MASTER_KEY_SECRET_NAME || 'byok-master-key';

    let keyB64;
    if (kvUri) {
        const { SecretClient } = require('@azure/keyvault-secrets');
        const { DefaultAzureCredential } = require('@azure/identity');
        const client = new SecretClient(kvUri, new DefaultAzureCredential());
        const secret = await client.getSecret(secretName);
        keyB64 = secret.value;
        console.log(`[CRYPTO] Loaded BYOK master key from Key Vault (${kvUri}).`);
    } else if (process.env.BYOK_MASTER_KEY_B64) {
        // Local dev escape hatch
        keyB64 = process.env.BYOK_MASTER_KEY_B64;
        console.log('[CRYPTO] Loaded BYOK master key from BYOK_MASTER_KEY_B64 env var.');
    } else if (process.env.NODE_ENV !== 'production') {
        // Insecure dev-only default so the app boots without setup
        console.warn('[CRYPTO] WARNING: no master key configured; using insecure dev key.');
        keyB64 = Buffer.alloc(32, 0).toString('base64');
    } else {
        throw new Error('AZURE_KEY_VAULT_URI is required in production for BYOK encryption');
    }

    masterKey = Buffer.from(keyB64, 'base64');
    if (masterKey.length !== 32) {
        throw new Error(`Invalid BYOK master key length: expected 32 bytes, got ${masterKey.length}`);
    }
}

function encrypt(plaintext) {
    if (plaintext == null || plaintext === '') return plaintext;
    if (!masterKey) throw new Error('Crypto module not initialized; call init() first');

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGO, masterKey, iv);
    const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return PREFIX + iv.toString('base64') + ':' + ciphertext.toString('base64') + ':' + authTag.toString('base64');
}

function decrypt(value) {
    if (value == null || value === '') return value;
    if (typeof value !== 'string' || !value.startsWith(PREFIX)) {
        // Legacy plaintext row (or non-string); return as-is for backward compatibility
        return value;
    }
    if (!masterKey) throw new Error('Crypto module not initialized; call init() first');

    const parts = value.slice(PREFIX.length).split(':');
    if (parts.length !== 3) throw new Error('Malformed BYOK ciphertext');

    const [iv, ct, tag] = parts.map(p => Buffer.from(p, 'base64'));
    const decipher = crypto.createDecipheriv(ALGO, masterKey, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ct, undefined, 'utf8') + decipher.final('utf8');
}

module.exports = { init, encrypt, decrypt };

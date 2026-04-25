const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const IS_PROD = process.env.NODE_ENV === 'production';
const BLOB_DIR = path.join(__dirname, 'blobs');
const CONTAINER_NAME = process.env.AZURE_BLOB_CONTAINER || 'multimodal-blobs';

let containerClient = null;

if (IS_PROD) {
    const { BlobServiceClient } = require('@azure/storage-blob');
    const { DefaultAzureCredential } = require('@azure/identity');

    const accountUrl = process.env.AZURE_STORAGE_ACCOUNT_URL;
    if (!accountUrl) {
        throw new Error("AZURE_STORAGE_ACCOUNT_URL env var is required in production (e.g. https://<account>.blob.core.windows.net)");
    }

    // DefaultAzureCredential auto-picks managed identity in Container Apps,
    // or falls back to az-cli / env-var creds locally.
    const blobServiceClient = new BlobServiceClient(accountUrl, new DefaultAzureCredential());
    containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
    console.log(`[MULTIMODAL] Initialized Azure Blob Storage: ${accountUrl}/${CONTAINER_NAME}`);
} else {
    if (!fs.existsSync(BLOB_DIR)) {
        fs.mkdirSync(BLOB_DIR, { recursive: true });
    }
    console.log(`[MULTIMODAL] Initialized local disk blobs: ${BLOB_DIR}`);
}

/**
 * Saves base64 data to disk or Azure Blob and returns a unique stub ID.
 */
async function saveBlob(base64Data, mimeType) {
    const hash = crypto.createHash('sha256').update(base64Data).digest('hex').substring(0, 12);

    let ext = '.bin';
    if (mimeType && (mimeType.includes('jpeg') || mimeType.includes('jpg'))) ext = '.jpg';
    if (mimeType && mimeType.includes('png')) ext = '.png';
    if (mimeType && mimeType.includes('gif')) ext = '.gif';
    if (mimeType && mimeType.includes('webp')) ext = '.webp';

    const filename = `img_${hash}${ext}`;
    const base64DataStr = base64Data.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(base64DataStr, 'base64');

    if (IS_PROD) {
        const blockBlob = containerClient.getBlockBlobClient(filename);
        const exists = await blockBlob.exists();
        if (!exists) {
            await blockBlob.uploadData(buffer, {
                blobHTTPHeaders: { blobContentType: mimeType || 'application/octet-stream' }
            });
        }
    } else {
        const filepath = path.join(BLOB_DIR, filename);
        if (!fs.existsSync(filepath)) {
            fs.writeFileSync(filepath, buffer);
        }
    }

    return filename;
}

/**
 * Retrieves base64 data from a stub ID.
 */
async function getBlob(filename) {
    let mimeType = 'image/jpeg';
    if (filename.endsWith('.png')) mimeType = 'image/png';
    if (filename.endsWith('.gif')) mimeType = 'image/gif';
    if (filename.endsWith('.webp')) mimeType = 'image/webp';

    if (IS_PROD) {
        const blockBlob = containerClient.getBlockBlobClient(filename);
        const exists = await blockBlob.exists();
        if (!exists) return null;

        const buffer = await blockBlob.downloadToBuffer();
        return `data:${mimeType};base64,${buffer.toString('base64')}`;
    } else {
        const filepath = path.join(BLOB_DIR, filename);
        if (!fs.existsSync(filepath)) return null;

        const base64Data = fs.readFileSync(filepath, 'base64');
        return `data:${mimeType};base64,${base64Data}`;
    }
}

/**
 * Recursively scans a messages array, extracts massive base64 images,
 * saves them to disk/Azure Blob, and returns a NEW message array where
 * those massive blocks are replaced by lightweight text stubs.
 */
async function extractAndStubMessages(messages) {
    const stubbedMessages = JSON.parse(JSON.stringify(messages));

    for (const msg of stubbedMessages) {
        if (!msg.content) continue;

        if (Array.isArray(msg.content)) {
            for (let i = 0; i < msg.content.length; i++) {
                const block = msg.content[i];

                if (block.type === 'image_url' && block.image_url && block.image_url.url && block.image_url.url.startsWith('data:image')) {
                    const mimeMatch = block.image_url.url.match(/^data:(image\/[\w+]+);/);
                    const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
                    const stubId = await saveBlob(block.image_url.url, mime);
                    msg.content[i] = { type: 'text', text: `[IMAGE_STUB: ${stubId}]` };
                }

                if (block.type === 'image' && block.source && block.source.type === 'base64') {
                    const stubId = await saveBlob(block.source.data, block.source.media_type);
                    msg.content[i] = { type: 'text', text: `[IMAGE_STUB: ${stubId}]` };
                }
            }
        }
    }

    return stubbedMessages;
}

module.exports = {
    saveBlob,
    getBlob,
    extractAndStubMessages
};

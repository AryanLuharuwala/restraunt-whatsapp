const fs = require('fs');
const path = require('path');

function saveMedia(media, savePath) {
    const buffer = Buffer.from(media.data, 'base64');
    const dir = path.dirname(savePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(savePath, buffer);
}

const LOG_DIR = path.join(__dirname, 'logs');

function log(source, entry) {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const logFile = path.join(LOG_DIR, `${source}_${date}.log`);
    const line = JSON.stringify({
        timestamp: new Date().toISOString(),
        ...entry
    });
    fs.appendFileSync(logFile, line + '\n');
}

/**
 * Get the chat ID where a message was sent.
 * In groups, msg.id.remote can return the sender's LID instead of the group ID
 * for non-owner messages. This resolves it properly via getChat().
 */
async function getChatId(msg) {
    // If it already looks like a group ID, trust it
    if (msg.id.remote.endsWith('@g.us')) return msg.id.remote;
    // For DMs from owner, msg.id.remote is correct
    if (msg.fromMe) return msg.id.remote;
    // Otherwise resolve via getChat() to get the real chat ID
    try {
        const chat = await msg.getChat();
        return chat.id._serialized;
    } catch {
        return msg.id.remote;
    }
}

module.exports = { saveMedia, log, getChatId };
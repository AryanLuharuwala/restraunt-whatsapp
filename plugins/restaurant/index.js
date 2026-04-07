/**
 * Restaurant ordering plugin for WhatsApp.
 */

const db = require('./db');
const { logger } = db;
const ordering = require('./ordering');
const payment = require('./payment');
const { startAdminServer } = require('./admin/server');

let adminStarted = false;

const TRIGGERS = [
    { match: /^(hi|hello|hey|start|menu|order|food)\b/i, handler: ordering.handleGreeting },
    { match: /^(cart|my order|basket|bag)\b/i, handler: ordering.handleCart },
    { match: /^(done|checkout|confirm|pay|place order)\b/i, handler: ordering.handleCheckout },
    { match: /^(cancel|clear|reset)\b/i, handler: ordering.handleCancel },
    { match: /^(status|token|where|track)\b/i, handler: payment.handleStatus },
    // Admin
    { match: /^all\s*orders?\b/i, handler: ordering.handleAdminAllOrders, adminOnly: true },
    { match: /^payments?\b/i, handler: ordering.handleAdminPayments, adminOnly: true },
    { match: /^stats?\b/i, handler: ordering.handleAdminStats, adminOnly: true },
    { match: /^(admin|orders|queue)\b/i, handler: ordering.handleAdminQueue, adminOnly: true },
    { match: /^paid\s+(\d+)/i, handler: ordering.handleAdminPaid, adminOnly: true },
    { match: /^ready\s+(\d+)/i, handler: ordering.handleMarkReady, adminOnly: true },
];

function init(bot) {
    if (!adminStarted) {
        adminStarted = true;
        startAdminServer(bot).catch(err => logger.error('admin server error', err.message));
    }

    const bindVotes = () => {
        bot.client.on('vote_update', async (vote) => {
            try { await ordering.handleVote(vote, bot); }
            catch (err) { logger.error('vote handler error', err.message); }
        });
    };

    if (bot.client) {
        bindVotes();
        logger.info('vote_update bound immediately');
    } else {
        const check = setInterval(() => {
            if (bot.client) {
                clearInterval(check);
                bindVotes();
                logger.info('vote_update bound (deferred)');
            }
        }, 500);
    }
}

module.exports = {
    name: 'restaurant',
    init,
    handler: async (logEntry, msg, bot) => {
        if (msg.fromMe) return false;
        const chat = await msg.getChat();
        if (chat.isGroup) return false;

        let phone = logEntry.phoneNumber;
        if (msg.from.endsWith('@lid') || !/^\d{10,15}$/.test(phone)) {
            try {
                const contact = await msg.getContact();
                if (contact?.number) phone = contact.number.replace(/\D/g, '');
            } catch {}
        }
        const chatId = msg.from;
        const send = (content) => bot.client.sendMessage(chatId, content);

        if (msg.type === 'payment') {
            const cfg = db.getConfig();
            if (cfg.debugMode && !db.isAdmin(phone) && !(cfg.allowedChats || []).includes(chatId)) return false;
            await payment.handlePaymentReceived({ phone, chatId, msg, send, bot });
            return true;
        }

        const text = (msg.body || '').trim();
        if (!text) return false;

        const isAdminUser = db.isAdmin(phone);

        // /known — admin whitelists this chat for debug mode
        if (isAdminUser && /^\/known$/i.test(text)) {
            const config = db.getConfig();
            if (!config.allowedChats) config.allowedChats = [];
            if (!config.allowedChats.includes(chatId)) {
                config.allowedChats.push(chatId);
                db.saveConfig(config);
                await send('✅ This chat is now whitelisted for ordering.');
                logger.info('chat whitelisted', { chatId, by: phone });
            } else {
                await send('This chat is already whitelisted.');
            }
            return true;
        }

        // /unknown — admin removes this chat from whitelist
        if (isAdminUser && /^\/unknown$/i.test(text)) {
            const config = db.getConfig();
            config.allowedChats = (config.allowedChats || []).filter(c => c !== chatId);
            db.saveConfig(config);
            await send('❌ This chat removed from whitelist.');
            logger.info('chat removed from whitelist', { chatId, by: phone });
            return true;
        }

        // /debug — admin toggles debug mode on/off
        if (isAdminUser && /^\/debug$/i.test(text)) {
            const config = db.getConfig();
            config.debugMode = !config.debugMode;
            db.saveConfig(config);
            await send(`Debug mode: *${config.debugMode ? 'ON' : 'OFF'}*\n${config.debugMode ? 'Only /known chats can order.' : 'Bot is live for everyone.'}`);
            logger.info('debug mode toggled', { debugMode: config.debugMode, by: phone });
            return true;
        }

        // Debug mode gate — block non-whitelisted, non-admin chats
        const config = db.getConfig();
        if (config.debugMode && !isAdminUser && !(config.allowedChats || []).includes(chatId)) {
            return false;
        }

        // Admin replying "paid" to an order notification
        if (isAdminUser && /^paid$/i.test(text) && msg.hasQuotedMsg) {
            const handled = await ordering.handleAdminPaidReply({ phone, chatId, send, bot, msg });
            if (handled) return true;
        }

        for (const trigger of TRIGGERS) {
            const m = text.match(trigger.match);
            if (!m) continue;
            if (trigger.adminOnly && !isAdminUser) continue;
            await trigger.handler({ phone, chatId, text, send, msg, bot, match: m });
            return true;
        }

        return false;
    }
};

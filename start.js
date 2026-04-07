const { WhatsAppBot } = require('./index');

const bot = new WhatsAppBot({ clientId: 'main', deferInit: true });

bot.loadPlugins();

let heartbeatTimer = null;
const HEARTBEAT_INTERVAL = 60_000;  // check every 60s
const HEARTBEAT_TIMEOUT = 15_000;   // 15s to respond before considered stalled
let consecutiveFails = 0;

function startHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);

    heartbeatTimer = setInterval(async () => {
        if (!bot.client) return;

        try {
            // getState() pings the browser/WhatsApp — if it hangs, the connection is dead
            const statePromise = bot.client.getState();
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('heartbeat timeout')), HEARTBEAT_TIMEOUT)
            );
            const state = await Promise.race([statePromise, timeoutPromise]);

            if (state === 'CONNECTED') {
                consecutiveFails = 0;
            } else {
                consecutiveFails++;
                const db = require('./plugins/restaurant/db');
                db.logger.warn('heartbeat: unexpected state', { state, fails: consecutiveFails });
            }
        } catch (err) {
            consecutiveFails++;
            const db = require('./plugins/restaurant/db');
            db.logger.error('heartbeat failed', { error: err.message, fails: consecutiveFails });

            if (consecutiveFails >= 3) {
                db.logger.warn('heartbeat: 3 consecutive failures, restarting client');
                consecutiveFails = 0;
                try {
                    await bot.client.destroy();
                } catch {}
                bot.init();
            }
        }
    }, HEARTBEAT_INTERVAL);
}

bot.on('onReady', async () => {
    const db = require('./plugins/restaurant/db');
    const { logger } = db;
    logger.info('restaurant bot is live');

    const info = bot.client.info;
    if (info && info.wid) {
        const selfNumber = info.wid.user;
        const config = db.getConfig();
        if (!config.adminNumbers.includes(selfNumber)) {
            config.adminNumbers.push(selfNumber);
            if (!config.roles) config.roles = {};
            config.roles[selfNumber] = 'owner';
            db.saveConfig(config);
            logger.info('self number set as admin (owner)', { number: selfNumber });
        }
    }

    startHeartbeat();
});

// Catch unhandled rejections so the process doesn't crash
process.on('unhandledRejection', (err) => {
    try {
        const db = require('./plugins/restaurant/db');
        db.logger.error('unhandled rejection', { error: err?.message || String(err) });
    } catch {}
});

process.on('uncaughtException', (err) => {
    try {
        const db = require('./plugins/restaurant/db');
        db.logger.error('uncaught exception', { error: err?.message || String(err) });
    } catch {}
    // Don't exit — let the heartbeat recover
});

bot.init();

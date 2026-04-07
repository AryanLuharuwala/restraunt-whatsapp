const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const MessageQueue = require('./messageQueue');

class WhatsAppBot {
    constructor({ clientId, chromiumPath = '/usr/bin/chromium-browser', logPath, deferInit = false }) {
        this.clientId = clientId;
        this.chromiumPath = chromiumPath;
        this.logPath = logPath || path.join(__dirname, 'logs', `${clientId}.log`);
        this.events = {}; // Custom user events
        this.queue = new MessageQueue(this); // Async message queue
        this.handlers = []; // Registered message handlers (plugins)
        if (!deferInit) this.init();
    }

    init() {
        this.client = new Client({
            authStrategy: new LocalAuth({ clientId: this.clientId }),
            puppeteer: {
                executablePath: this.chromiumPath,
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            }
        });

        // QR code trigger
        this.client.on('qr', (qr) => {
            qrcode.generate(qr, { small: true });
            if (this.events.onQR) this.events.onQR(qr);
        });

        // Bot ready
        this.client.on('ready', () => {
            console.log(`✅ Bot ${this.clientId} ready!`);
            if (this.events.onReady) this.events.onReady();
        });

        // Handle disconnects — re-init after a short delay
        this.client.on('disconnected', (reason) => {
            console.log(`⚠️ Bot ${this.clientId} disconnected: ${reason}`);
            if (this.events.onDisconnected) this.events.onDisconnected(reason);
            setTimeout(() => this.init(), 5000);
        });

        // Auth failure — clear stale session so next init shows a fresh QR
        this.client.on('auth_failure', (msg) => {
            console.log(`❌ Auth failure for ${this.clientId}: ${msg}`);
            const sessionDir = path.join(__dirname, '.wwebjs_auth', `session-${this.clientId}`);
            fs.rmSync(sessionDir, { recursive: true, force: true });
            console.log(`🗑️ Cleared stale session, restarting for fresh QR...`);
            setTimeout(() => this.init(), 3000);
        });

        // Capture all messages (incoming & outgoing)
        this.client.on('message_create', async (msg) => {
            const contact = await msg.getContact().catch(() => ({}));
            const chat = await msg.getChat().catch(() => ({}));
            const logEntry = {
                id: msg.id._serialized,
                text: msg.body,
                fromMe: msg.fromMe,
                senderName: contact?.pushname || contact?.verifiedName || msg.from.split('@')[0],
                phoneNumber: msg.from.split('@')[0],
                groupName: chat?.isGroup ? chat?.name : null,
                replyTo: msg.hasQuotedMsg ? msg._data?.quotedMsg?.id?.id : null,
                mediaType: msg.hasMedia ? msg.type : null,
                timestamp: new Date().toISOString()
            };

            this._logMessage(logEntry);

            // Run registered handlers in order; stop if one handles it
            for (const handler of this.handlers) {
                try {
                    const handled = await handler.fn(logEntry, msg, this);
                    if (handled) return;
                } catch (err) {
                    console.error(`Handler error (${handler.name}): ${err.message}`);
                }
            }

            // Trigger user-defined message handler
            if (this.events.onMessage) this.events.onMessage(logEntry, msg);
        });

        this.client.initialize();
    }

    // Send text or media asynchronously via queue
    async sendMessage(to, content, options = {}) {
        return this.queue.add({ to, content, options });
    }

    // Register events: onMessage, onQR, onReady, onError
    on(event, callback) {
        this.events[event] = callback;
    }

    /**
     * Register a message handler (plugin).
     * Handler signature: async (logEntry, msg, bot) => boolean
     * Return true to stop further processing, false to pass through.
     */
    use(handler, name) {
        this.handlers.push({ fn: handler, name: name || `handler_${this.handlers.length}`, isPlugin: false });
    }

    /**
     * Load all plugins from the plugins/ directory.
     * Each plugin is a .js file that exports a handler function:
     *   module.exports = async (logEntry, msg, bot) => { ... return true/false }
     * Or exports { handler, name }
     */
    loadPlugins() {
        const pluginDir = path.join(__dirname, 'plugins');
        if (!fs.existsSync(pluginDir)) return;

        // Remove old plugins
        this.handlers = this.handlers.filter(h => !h.isPlugin);

        const entries = fs.readdirSync(pluginDir).sort();
        for (const entry of entries) {
            const fullPath = path.join(pluginDir, entry);
            const stat = fs.statSync(fullPath);

            // Support both single .js files and directories with index.js
            let modulePath = null;
            if (stat.isFile() && entry.endsWith('.js')) {
                modulePath = fullPath;
            } else if (stat.isDirectory() && fs.existsSync(path.join(fullPath, 'index.js'))) {
                modulePath = fullPath;
            }
            if (!modulePath) continue;

            try {
                // Clear require cache so changes are picked up
                delete require.cache[require.resolve(modulePath)];
                const plugin = require(modulePath);
                const fn = typeof plugin === 'function' ? plugin : plugin.handler;
                const name = plugin.name || entry.replace('.js', '');
                if (typeof fn === 'function') {
                    // Pass bot reference for plugins that need events (e.g. vote_update)
                    if (typeof plugin.init === 'function') plugin.init(this);
                    this.handlers.push({ fn, name, isPlugin: true });
                    console.log(`  📦 Plugin loaded: ${name}`);
                }
            } catch (err) {
                console.error(`  ❌ Plugin error (${entry}): ${err.message}`);
            }
        }
    }

    /**
     * Reload all plugins without restarting the bot.
     */
    reloadPlugins() {
        console.log('🔄 Reloading plugins...');
        this.loadPlugins();
        console.log(`✅ ${this.handlers.filter(h => h.isPlugin).length} plugins loaded`);
    }

    // Internal logging
    _logMessage(logEntry) {
        const logDir = path.dirname(this.logPath);
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        fs.appendFileSync(this.logPath, JSON.stringify(logEntry) + '\n');
    }
}

module.exports = WhatsAppBot;
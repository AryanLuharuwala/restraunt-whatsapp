/**
 * Restaurant admin panel — Express server.
 * Mobile-friendly dashboard + REST API for menu, orders, config.
 * Runs on port 3457 by default.
 */

const express = require('express');
const path = require('path');
const db = require('../db');
const { logger } = db;

function startAdminServer(bot, opts = {}) {
    const port = opts.port || 3457;
    const app = express();

    app.use(express.json());
    app.use(express.static(path.join(__dirname, 'public')));

    function route(method, basePath, handler) {
        app[method](basePath, handler);
        app[method](basePath + '/:branch', handler);
    }
    function getBranch(req) { return req.params.branch || 'main'; }

    // ── Config ──────────────────────────────────────────

    app.get('/api/config', (req, res) => res.json(db.getConfig()));

    app.put('/api/config', (req, res) => {
        const config = db.getConfig();
        Object.assign(config, req.body);
        db.saveConfig(config);
        res.json(config);
    });

    // ── Menu ────────────────────────────────────────────

    route('get', '/api/menu', (req, res) => res.json(db.getMenu(getBranch(req))));

    route('put', '/api/menu', (req, res) => {
        db.saveMenu(req.body, getBranch(req));
        res.json({ ok: true });
    });

    app.post('/api/menu/:branch/category', (req, res) => {
        const branch = req.params.branch || 'main';
        const menu = db.getMenu(branch);
        const id = req.body.name.toLowerCase().replace(/\s+/g, '-') + '-' + Date.now();
        menu.categories.push({ id, name: req.body.name, items: [] });
        db.saveMenu(menu, branch);
        logger.info('category added', { branch, name: req.body.name });
        res.json(menu);
    });

    app.delete('/api/menu/:branch/category/:catId', (req, res) => {
        const branch = req.params.branch || 'main';
        const menu = db.getMenu(branch);
        menu.categories = menu.categories.filter(c => c.id !== req.params.catId);
        db.saveMenu(menu, branch);
        res.json(menu);
    });

    app.post('/api/menu/:branch/category/:catId/item', (req, res) => {
        const branch = req.params.branch || 'main';
        const menu = db.getMenu(branch);
        const cat = menu.categories.find(c => c.id === req.params.catId);
        if (!cat) return res.status(404).json({ error: 'Category not found' });

        const item = {
            id: req.body.name.toLowerCase().replace(/\s+/g, '-') + '-' + Date.now(),
            name: req.body.name,
            price: Number(req.body.price) || 0,
            desc: req.body.desc || '',
            available: req.body.available !== false,
        };
        cat.items.push(item);
        db.saveMenu(menu, branch);
        logger.info('item added', { branch, category: cat.name, item: item.name, price: item.price });
        res.json(menu);
    });

    app.put('/api/menu/:branch/category/:catId/item/:itemId', (req, res) => {
        const branch = req.params.branch || 'main';
        const menu = db.getMenu(branch);
        const cat = menu.categories.find(c => c.id === req.params.catId);
        if (!cat) return res.status(404).json({ error: 'Category not found' });
        const item = cat.items.find(i => i.id === req.params.itemId);
        if (!item) return res.status(404).json({ error: 'Item not found' });

        if (req.body.name !== undefined) item.name = req.body.name;
        if (req.body.price !== undefined) item.price = Number(req.body.price);
        if (req.body.desc !== undefined) item.desc = req.body.desc;
        if (req.body.available !== undefined) item.available = req.body.available;

        db.saveMenu(menu, branch);
        logger.info('item updated', { branch, item: item.name });
        res.json(menu);
    });

    app.delete('/api/menu/:branch/category/:catId/item/:itemId', (req, res) => {
        const branch = req.params.branch || 'main';
        const menu = db.getMenu(branch);
        const cat = menu.categories.find(c => c.id === req.params.catId);
        if (!cat) return res.status(404).json({ error: 'Category not found' });
        cat.items = cat.items.filter(i => i.id !== req.params.itemId);
        db.saveMenu(menu, branch);
        res.json(menu);
    });

    // ── Orders ──────────────────────────────────────────

    route('get', '/api/orders', (req, res) => {
        const branch = getBranch(req);
        const status = req.query.status;
        let orders = db.getOrders(branch);
        if (status) orders = orders.filter(o => o.status === status);
        res.json(orders.reverse());
    });

    app.put('/api/orders/:branch/:orderId', async (req, res) => {
        const branch = req.params.branch || 'main';
        const order = db.updateOrder(req.params.orderId, req.body, branch);
        if (!order) return res.status(404).json({ error: 'Order not found' });

        // Notify customer on status change via WhatsApp
        if (bot?.client && order.status !== 'pending_payment') {
            const customerChat = order.chatId || `${order.phone?.replace(/\\D/g, '')}@c.us`;
            const messages = {
                preparing: `👨‍🍳 *Order #${order.token} update*\n\nYour order is now being prepared!`,
                ready: `🔔 *Your order #${order.token} is ready for pickup!*\n\nPlease come to the counter with your token number.`,
                picked_up: `📦 *Order #${order.token} picked up!*\n\nThank you! Say *menu* to order again.`,
            };
            if (messages[req.body.status]) {
                try { await bot.client.sendMessage(customerChat, messages[req.body.status]); }
                catch (err) { logger.error('notify customer from dashboard failed', err.message); }
            }
        }

        logger.info('order updated via dashboard', { orderId: order.id, status: order.status });
        res.json(order);
    });

    // ── Payment confirmation from dashboard ─────────────

    app.post('/api/orders/:branch/:orderId/confirm-payment', async (req, res) => {
        const branch = req.params.branch || 'main';
        const order = db.updateOrder(req.params.orderId, {
            status: 'paid',
            paidAt: new Date().toISOString(),
            paymentAmount: 0,
            paidVia: 'dashboard',
            paidBy: 'admin_dashboard',
        }, branch);
        if (!order) return res.status(404).json({ error: 'Order not found' });

        logger.info('payment confirmed via dashboard', { token: order.token });

        // Notify customer
        if (bot?.client) {
            const customerChat = order.chatId || (order.phone ? `${order.phone.replace(/\D/g, '')}@c.us` : null);
            if (customerChat) {
                try {
                    await bot.client.sendMessage(customerChat,
                        `✅ *Payment confirmed for Order #${order.token}!*\n\nYour token: *#${order.token}*\nWe're preparing your order now.\nSay *status* to check anytime.`
                    );
                } catch (err) { logger.error('notify customer failed', err.message); }
            }
        }

        res.json(order);
    });

    // ── Stats ───────────────────────────────────────────

    route('get', '/api/stats', (req, res) => {
        const branch = getBranch(req);
        const config = db.getConfig();
        const today = new Date().toISOString().slice(0, 10);
        const allOrders = db.getOrders(branch);
        const todayOrders = allOrders.filter(o => o.createdAt?.startsWith(today));
        const paid = todayOrders.filter(o => !['pending_payment', 'cancelled'].includes(o.status));

        res.json({
            today: {
                total: todayOrders.length,
                paid: paid.length,
                revenue: paid.reduce((s, o) => s + o.total, 0),
                cancelled: todayOrders.filter(o => o.status === 'cancelled').length,
            },
            allTime: {
                total: allOrders.length,
                revenue: allOrders.filter(o => !['pending_payment', 'cancelled'].includes(o.status)).reduce((s, o) => s + o.total, 0),
            },
            currency: config.currency,
        });
    });

    // ── Logs ────────────────────────────────────────────

    app.get('/api/logs', (req, res) => {
        const fs = require('fs');
        const logPath = path.join(__dirname, '..', 'data', 'bot.log');
        if (!fs.existsSync(logPath)) return res.json({ lines: [] });
        const content = fs.readFileSync(logPath, 'utf8');
        const lines = content.trim().split('\n').slice(-100).reverse();
        res.json({ lines });
    });

    // ── Branches ────────────────────────────────────────

    app.get('/api/branches', (req, res) => {
        const config = db.getConfig();
        res.json(config.branches || ['main']);
    });

    app.post('/api/branches', (req, res) => {
        const config = db.getConfig();
        const name = (req.body.name || '').toLowerCase().replace(/\s+/g, '-');
        if (!name) return res.status(400).json({ error: 'Name required' });
        if (!config.branches) config.branches = ['main'];
        if (config.branches.includes(name)) return res.status(409).json({ error: 'Branch exists' });
        config.branches.push(name);
        db.saveConfig(config);
        db.saveMenu({ categories: [] }, name);
        res.json(config.branches);
    });

    app.delete('/api/branches/:name', (req, res) => {
        const config = db.getConfig();
        if (req.params.name === 'main') return res.status(400).json({ error: 'Cannot delete main branch' });
        config.branches = (config.branches || []).filter(b => b !== req.params.name);
        db.saveConfig(config);
        res.json(config.branches);
    });

    // ── Start ───────────────────────────────────────────

    return new Promise(resolve => {
        const server = app.listen(port, () => {
            logger.info(`admin panel started on port ${port}`);
            resolve({ app, server });
        });
    });
}

module.exports = { startAdminServer };

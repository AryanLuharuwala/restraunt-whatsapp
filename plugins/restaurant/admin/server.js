/**
 * Restaurant admin panel — Express server.
 * Mobile-friendly dashboard + REST API for menu, orders, config.
 * Runs on port 3457 by default.
 *
 * Security:
 *   - Password-based login (SHA-256, stored in auth.json)
 *   - IP allowlist (stored in auth.json, enforced on every request)
 *   - Master password to update dashboard password + IP list
 *   - Session tokens stored in signed cookies (crypto, no extra deps)
 */

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const db = require('../db');
const { logger } = db;

// ── Auth helpers ───────────────────────────────────────

const AUTH_FILE = path.join(__dirname, '..', 'data', 'auth.json');

function loadAuth() {
    if (!fs.existsSync(AUTH_FILE)) return null;
    try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); } catch { return null; }
}

function saveAuth(data) {
    fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2));
}

function sha256(str) {
    return crypto.createHash('sha256').update(str).digest('hex');
}

/** In-memory session store: token → { ip, expiresAt } */
const sessions = new Map();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

function createSession(ip) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { ip, expiresAt: Date.now() + SESSION_TTL_MS });
    return token;
}

function getSession(token) {
    if (!token) return null;
    const s = sessions.get(token);
    if (!s) return null;
    if (Date.now() > s.expiresAt) { sessions.delete(token); return null; }
    return s;
}

function parseCookies(header) {
    const cookies = {};
    if (!header) return cookies;
    for (const part of header.split(';')) {
        const [k, ...v] = part.trim().split('=');
        if (k) cookies[k.trim()] = decodeURIComponent(v.join('='));
    }
    return cookies;
}

function getRequestIp(req) {
    // Respect X-Forwarded-For if behind a proxy/ngrok
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
    return req.socket?.remoteAddress || req.connection?.remoteAddress || '';
}

function normaliseIp(ip) {
    // Map IPv4-mapped IPv6 (::ffff:x.x.x.x) → plain IPv4
    return ip.replace(/^::ffff:/, '');
}

// ── Auth middleware ────────────────────────────────────

function requireAuth(req, res, next) {
    const auth = loadAuth();

    // If auth not configured yet, allow through (first-run setup)
    if (!auth) { return next(); }

    const clientIp = normaliseIp(getRequestIp(req));

    // IP allowlist check (skip if list is empty — open to any IP)
    const allowedIps = auth.allowedIps || [];
    if (allowedIps.length > 0 && !allowedIps.includes(clientIp)) {
        logger.warn('admin: blocked IP', { clientIp, allowedIps });
        return res.status(403).send('Forbidden: your IP is not allowed.');
    }

    // Session check
    const cookies = parseCookies(req.headers.cookie);
    const session = getSession(cookies.admin_token);
    if (!session) {
        // Return 401 JSON for API routes, redirect for page routes
        if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
        return res.redirect('/login');
    }

    next();
}

// ── Server factory ─────────────────────────────────────

function startAdminServer(bot, opts = {}) {
    const port = opts.port || 3457;
    const app = express();

    app.use(express.json());

    function route(method, basePath, handler) {
        app[method](basePath, handler);
        app[method](basePath + '/:branch', handler);
    }
    function getBranch(req) { return req.params.branch || 'main'; }

    // ── Public: Login page ──────────────────────────────

    app.get('/login', (req, res) => {
        const auth = loadAuth();
        res.setHeader('Content-Type', 'text/html');
        res.send(`<!DOCTYPE html><html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Admin Login</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f0f2f5;display:flex;align-items:center;justify-content:center;min-height:100vh;}
.card{background:#fff;border-radius:12px;padding:32px 24px;width:100%;max-width:360px;box-shadow:0 4px 16px rgba(0,0,0,.12);}
h1{color:#075e54;font-size:22px;margin-bottom:4px;text-align:center;}
p{color:#888;font-size:13px;text-align:center;margin-bottom:24px;}
label{display:block;font-size:13px;font-weight:500;margin-bottom:4px;color:#333;}
input{width:100%;padding:10px 12px;border:1px solid #ddd;border-radius:8px;font-size:15px;margin-bottom:16px;outline:none;}
input:focus{border-color:#075e54;}
button{width:100%;padding:12px;background:#075e54;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;}
button:active{background:#054d44;}
.err{color:#dc3545;font-size:13px;margin-bottom:12px;text-align:center;}
${!auth ? '.setup{background:#fff8e1;border:1px solid #ffe082;border-radius:8px;padding:12px;font-size:13px;margin-bottom:16px;color:#795548;}' : ''}
</style>
</head>
<body>
<div class="card">
  <h1>🍽️ Admin Panel</h1>
  <p>Restaurant Dashboard</p>
  ${!auth ? '<div class="setup"><b>First-time setup:</b> Set a password and (optionally) your current IP will be added to the allowlist.</div>' : ''}
  ${req.query.err === '1' ? '<div class="err">Incorrect password. Try again.</div>' : ''}
  ${req.query.err === 'ip' ? '<div class="err">Your IP address is not allowed.</div>' : ''}
  <form method="POST" action="/login">
    <label>Password</label>
    <input type="password" name="password" autofocus required>
    ${!auth ? '<label>Confirm Password</label><input type="password" name="confirm" required>' : ''}
    <button type="submit">${!auth ? 'Set Password & Enter' : 'Log In'}</button>
  </form>
</div>
</body></html>`);
    });

    app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
        const { password, confirm } = req.body;
        const clientIp = normaliseIp(getRequestIp(req));
        let auth = loadAuth();

        // First-time setup
        if (!auth) {
            if (!password || password.length < 6) return res.redirect('/login?err=1');
            if (password !== confirm) return res.redirect('/login?err=1');
            auth = {
                passwordHash: sha256(password),
                masterHash: sha256('master:' + password), // master = "master:" + chosen password initially
                allowedIps: [],
            };
            saveAuth(auth);
            logger.info('admin auth configured', { firstIp: clientIp });
        }

        // IP check
        if ((auth.allowedIps || []).length > 0 && !auth.allowedIps.includes(clientIp)) {
            logger.warn('admin: login blocked (IP)', { clientIp });
            return res.redirect('/login?err=ip');
        }

        // Password check
        if (sha256(password) !== auth.passwordHash) {
            logger.warn('admin: wrong password', { clientIp });
            return res.redirect('/login?err=1');
        }

        const token = createSession(clientIp);
        res.setHeader('Set-Cookie', `admin_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
        logger.info('admin: login', { clientIp });
        res.redirect('/');
    });

    app.post('/logout', (req, res) => {
        const cookies = parseCookies(req.headers.cookie);
        if (cookies.admin_token) sessions.delete(cookies.admin_token);
        res.setHeader('Set-Cookie', 'admin_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        res.redirect('/login');
    });

    // ── Auth guard for everything below ─────────────────

    app.use(requireAuth);

    // ── Static (protected) ──────────────────────────────

    app.use(express.static(path.join(__dirname, 'public')));

    // ── Security API ────────────────────────────────────

    /** GET /api/security — returns current IP list + current IP (never exposes passwords) */
    app.get('/api/security', (req, res) => {
        const auth = loadAuth() || {};
        const clientIp = normaliseIp(getRequestIp(req));
        res.json({ allowedIps: auth.allowedIps || [], currentIp: clientIp });
    });

    /**
     * POST /api/security — update password or IP list.
     * Requires masterPassword in the request body.
     * Body: { masterPassword, newPassword?, allowedIps? }
     */
    app.post('/api/security', (req, res) => {
        const auth = loadAuth();
        if (!auth) return res.status(400).json({ error: 'Auth not configured' });

        const { masterPassword, newPassword, allowedIps } = req.body;
        if (!masterPassword) return res.status(400).json({ error: 'masterPassword required' });

        if (sha256(masterPassword) !== auth.masterHash) {
            logger.warn('admin: bad master password attempt', { ip: normaliseIp(getRequestIp(req)) });
            return res.status(403).json({ error: 'Incorrect master password' });
        }

        if (newPassword !== undefined) {
            if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Password too short (min 6 chars)' });
            auth.passwordHash = sha256(newPassword);
            // Invalidate all sessions after password change
            sessions.clear();
            logger.info('admin: password changed');
        }

        if (allowedIps !== undefined) {
            if (!Array.isArray(allowedIps)) return res.status(400).json({ error: 'allowedIps must be an array' });
            auth.allowedIps = allowedIps.map(ip => normaliseIp(ip.trim())).filter(Boolean);
            logger.info('admin: IP allowlist updated', { ips: auth.allowedIps });
        }

        saveAuth(auth);
        res.json({ ok: true, allowedIps: auth.allowedIps });
    });

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

        if (bot?.client && order.status !== 'pending_payment') {
            const customerChat = order.chatId || `${order.phone?.replace(/\D/g, '')}@c.us`;
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

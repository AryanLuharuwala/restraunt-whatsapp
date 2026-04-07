/**
 * Restaurant plugin — lightweight JSON-file database.
 * Stores menu, orders, branches, config, and credits in data/*.json.
 * Multi-branch aware: each branch has its own menu & order queue.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const LOG_FILE = path.join(DATA_DIR, 'bot.log');

function log(level, ...args) {
    const ts = new Date().toISOString();
    const line = `[${ts}] [${level}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`;
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.appendFileSync(LOG_FILE, line);
    } catch {}
}

const logger = {
    info: (...args) => log('INFO', ...args),
    warn: (...args) => log('WARN', ...args),
    error: (...args) => log('ERROR', ...args),
};

function ensureDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load(file) {
    ensureDir();
    const p = path.join(DATA_DIR, file);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function save(file, data) {
    ensureDir();
    fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

// ── Config (restaurant-level) ──────────────────────────

function getConfig() {
    return load('config.json') || {
        name: 'My Restaurant',
        currency: '₹',
        branches: ['main'],
        defaultBranch: 'main',
        adminNumbers: [],
        // Role-based access: { "919xxx": "owner", "918xxx": "cook", "917xxx": "cashier" }
        // owner = everything, cook = order prep polls, cashier = payment + new order polls
        // If roles is empty, all adminNumbers are treated as owner
        roles: {},
        paymentNote: 'Please send payment via WhatsApp Pay to confirm your order.',
        greetingImage: null,
        greetingText: null,
        debugMode: true,      // when true, only allowedChats can use the bot
        allowedChats: [],     // chatIds whitelisted via /known command
    };
}

/** Get admin numbers filtered by role. Returns all admins if no roles configured. */
function getAdminsByRole(...roleList) {
    const config = getConfig();
    const roles = config.roles || {};
    const hasRoles = Object.keys(roles).length > 0;

    if (!hasRoles) return config.adminNumbers || [];

    return (config.adminNumbers || []).filter(num => {
        const cleanNum = num.replace(/\D/g, '');
        const role = roles[num] || roles[cleanNum] || 'owner';
        return roleList.includes(role) || roleList.includes('all');
    });
}

/** Check if a phone number has admin access (any role) */
function isAdmin(phone) {
    const config = getConfig();
    const clean = phone.replace(/\D/g, '');
    return (config.adminNumbers || []).some(n => n.replace(/\D/g, '') === clean);
}

/** Get the role of an admin number */
function getRole(phone) {
    const config = getConfig();
    const roles = config.roles || {};
    const clean = phone.replace(/\D/g, '');
    return roles[phone] || roles[clean] || 'owner';
}

function saveConfig(config) {
    save('config.json', config);
}

// ── Menu (per-branch) ──────────────────────────────────

function getMenu(branch = 'main') {
    return load(`menu-${branch}.json`) || { categories: [] };
}

function saveMenu(menu, branch = 'main') {
    save(`menu-${branch}.json`, menu);
}

function findItem(branch, itemId) {
    const menu = getMenu(branch);
    for (const cat of menu.categories) {
        const item = cat.items.find(i => i.id === itemId);
        if (item) return { ...item, category: cat.name };
    }
    return null;
}

// ── Orders ─────────────────────────────────────────────

function getOrders(branch = 'main') {
    return load(`orders-${branch}.json`) || [];
}

function saveOrders(orders, branch = 'main') {
    save(`orders-${branch}.json`, orders);
}

function nextToken(branch = 'main') {
    const today = new Date().toISOString().slice(0, 10);
    const meta = load(`meta-${branch}.json`) || { date: today, lastToken: 0 };
    if (meta.date !== today) {
        meta.date = today;
        meta.lastToken = 0;
    }
    meta.lastToken += 1;
    save(`meta-${branch}.json`, meta);
    return meta.lastToken;
}

function addOrder(order, branch = 'main') {
    const orders = getOrders(branch);
    order.token = nextToken(branch);
    order.id = `${branch}-${Date.now()}-${order.token}`;
    order.status = 'pending_payment';
    order.createdAt = new Date().toISOString();
    orders.push(order);
    saveOrders(orders, branch);
    return order;
}

function updateOrder(orderId, updates, branch = 'main') {
    const orders = getOrders(branch);
    const idx = orders.findIndex(o => o.id === orderId);
    if (idx === -1) return null;
    Object.assign(orders[idx], updates);
    saveOrders(orders, branch);
    return orders[idx];
}

function findOrderByToken(token, branch = 'main') {
    const orders = getOrders(branch);
    return orders.find(o => o.token === Number(token) && o.status !== 'cancelled');
}

function findPendingByPhone(phone, branch = 'main') {
    const orders = getOrders(branch);
    return orders.find(o => o.phone === phone && o.status === 'pending_payment');
}

function findPendingByChatId(chatId, branch = 'main') {
    const orders = getOrders(branch);
    return orders.find(o => o.chatId === chatId && o.status === 'pending_payment');
}

// ── Credits (store credit from cancelled orders) ──────
// { phone: { amount: number, history: [{amount, reason, date}] } }

function getCredits() {
    return load('credits.json') || {};
}

function saveCredits(credits) {
    save('credits.json', credits);
}

function getCredit(phone) {
    const credits = getCredits();
    return credits[phone]?.amount || 0;
}

function addCredit(phone, amount, reason) {
    const credits = getCredits();
    if (!credits[phone]) credits[phone] = { amount: 0, history: [] };
    credits[phone].amount += amount;
    credits[phone].history.push({ amount, reason, date: new Date().toISOString() });
    saveCredits(credits);
    return credits[phone].amount;
}

function useCredit(phone, amount) {
    const credits = getCredits();
    if (!credits[phone] || credits[phone].amount < amount) return false;
    credits[phone].amount -= amount;
    credits[phone].history.push({ amount: -amount, reason: 'Applied to order', date: new Date().toISOString() });
    saveCredits(credits);
    return true;
}

// ── Sessions (user cart state) ─────────────────────────

const sessions = new Map();

function getSession(chatId) {
    if (!sessions.has(chatId)) {
        const config = getConfig();
        sessions.set(chatId, {
            chatId,
            branch: config.defaultBranch,
            cart: [],
            step: 'idle',
        });
    }
    return sessions.get(chatId);
}

function clearSession(chatId) {
    sessions.delete(chatId);
}

module.exports = {
    logger,
    getConfig, saveConfig, getAdminsByRole, isAdmin, getRole,
    getMenu, saveMenu, findItem,
    getOrders, saveOrders, addOrder, updateOrder, findOrderByToken, findPendingByPhone, findPendingByChatId,
    nextToken,
    getCredits, saveCredits, getCredit, addCredit, useCredit,
    getSession, clearSession,
};

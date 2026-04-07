/**
 * Ordering flow using WhatsApp polls.
 */

const { Poll, MessageMedia } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { logger } = db;
const { statusLabel } = require('./payment');

const pollMap = new Map();
const orderMsgMap = new Map();
const greetingCooldown = new Map();
const COOLDOWN_MS = 5000;

// ── Customer Handlers ──────────────────────────────────

async function handleGreeting({ phone, chatId, send, bot }) {
    const now = Date.now();
    if (greetingCooldown.has(chatId) && now - greetingCooldown.get(chatId) < COOLDOWN_MS) return;
    greetingCooldown.set(chatId, now);

    const session = db.getSession(chatId);
    const config = db.getConfig();
    const menu = db.getMenu(session.branch);

    if (!menu.categories.length) {
        await send('Welcome! Our menu is being updated — please check back soon.');
        return;
    }

    session.cart = [];
    session.step = 'polling';

    if (config.greetingImage) {
        try {
            let media;
            if (config.greetingImage.startsWith('http')) {
                media = await MessageMedia.fromUrl(config.greetingImage);
            } else {
                const imgPath = path.isAbsolute(config.greetingImage)
                    ? config.greetingImage
                    : path.join(__dirname, 'data', config.greetingImage);
                if (fs.existsSync(imgPath)) media = MessageMedia.fromFilePath(imgPath);
            }
            if (media) await bot.client.sendMessage(chatId, media, { caption: config.greetingText || '' });
        } catch (err) {
            logger.error('greeting image failed', err.message);
        }
    }

    const credit = db.getCredit(phone);
    let welcomeMsg = `Welcome to *${config.name}*! 👋\n\n`;
    if (config.greetingText && !config.greetingImage) welcomeMsg += `${config.greetingText}\n\n`;
    welcomeMsg += `Here's our menu — *tap to select items* from each category.\nWhen you're done, just say *done* to place your order.`;
    if (credit > 0) welcomeMsg += `\n\n💰 You have *${config.currency}${credit}* store credit!`;
    await send(welcomeMsg);

    for (const cat of menu.categories) {
        const available = cat.items.filter(it => it.available !== false);
        if (!available.length) continue;
        const options = available.map(it => `${it.name} — ${config.currency}${it.price}`);
        if (options.length > 12) options.length = 12;
        const poll = new Poll(cat.name, options, { allowMultipleAnswers: true });
        const sent = await bot.client.sendMessage(chatId, poll);
        pollMap.set(sent.id.id, { branch: session.branch, catId: cat.id, chatId, phone, items: available.slice(0, 12) });
    }
    logger.info('greeting sent', { chatId, phone, categories: menu.categories.length });
}

async function handleVote(vote, bot) {
    const shortId = vote.parentMsgKey?.id;
    if (!shortId) return;
    const pollInfo = pollMap.get(shortId);
    if (!pollInfo) return;

    if (pollInfo.type === 'admin_order') {
        await handleAdminOrderVote(vote, pollInfo, bot);
        return;
    }

    if (pollInfo.type === 'quantity') {
        const selected = vote.selectedOptions || [];
        if (selected.length > 0) {
            const qty = parseInt(selected[selected.length - 1].name, 10) || 1;
            const session = db.getSession(pollInfo.chatId);
            const cartItem = session.cart.find(c => c.id === pollInfo.itemId);
            if (cartItem) {
                cartItem.qty = qty;
                logger.info('qty set', { item: cartItem.name, qty });
            }
        }
        return;
    }

    // Menu poll vote
    const { chatId: pollChatId, phone } = pollInfo;
    const session = db.getSession(pollChatId);
    const selected = vote.selectedOptions || [];

    session.cart = session.cart.filter(c => c.catId !== pollInfo.catId);
    const newItems = [];
    for (const opt of selected) {
        const item = pollInfo.items[opt.localId];
        if (!item) continue;
        session.cart.push({ id: item.id, catId: pollInfo.catId, name: item.name, qty: 1, price: item.price });
        newItems.push(item);
    }
    logger.info('cart updated', { chatId: pollChatId, cart: session.cart.map(c => `${c.name}×${c.qty}`) });
    session.step = 'polling';

    const config = db.getConfig();
    for (const item of newItems) {
        const poll = new Poll(`How many ${item.name}? (${config.currency}${item.price} each)`, ['1', '2', '3', '4', '5'], { allowMultipleAnswers: false });
        const sent = await bot.client.sendMessage(pollChatId, poll);
        pollMap.set(sent.id.id, { type: 'quantity', chatId: pollChatId, phone, itemId: item.id });
    }
}

// ── Admin Order Vote Handler ───────────────────────────

async function handleAdminOrderVote(vote, pollInfo, bot) {
    const selected = vote.selectedOptions || [];
    if (!selected.length) return;

    const choice = selected[selected.length - 1].name;
    const { orderId, branch, token, customerChatId, customerPhone } = pollInfo;
    const config = db.getConfig();
    const voterChatId = pollInfo.adminChatId;

    const notifyCustomer = async (text) => {
        const chat = customerChatId || (customerPhone ? `${customerPhone.replace(/\D/g, '')}@c.us` : null);
        if (!chat) return;
        try { await bot.client.sendMessage(chat, text); }
        catch (err) { logger.error('notify customer failed', err.message); }
    };

    if (choice === '💰 Confirm Payment') {
        const order = db.updateOrder(orderId, {
            status: 'paid', paidAt: new Date().toISOString(),
            paymentAmount: 0, paidVia: 'manual_poll', paidBy: voterChatId,
        }, branch);
        logger.info('payment confirmed via poll', { token, by: voterChatId });

        try { await bot.client.sendMessage(voterChatId, `💰 Order #${token} payment confirmed.`); } catch {}
        await notifyCustomer(`✅ *Payment confirmed for Order #${token}!*\n\nYour token: *#${token}*\nWe're preparing your order now.\nSay *status* to check anytime.`);

        if (order) {
            const actionPoll = new Poll(`Order #${token} — ${config.currency}${order.total} (PAID)`,
                ['👨‍🍳 Cooking', '✅ Ready', '📦 Picked Up', '❌ Cancel + Refund'], { allowMultipleAnswers: false });
            const sent = await bot.client.sendMessage(voterChatId, actionPoll);
            pollMap.set(sent.id.id, { type: 'admin_order', orderId, token, branch, adminChatId: voterChatId, customerChatId, customerPhone });
        }
        return;
    }

    if (choice === '❌ Cancel') {
        // Pending payment — customer never paid cash, but may have used store credit at checkout
        const order = db.findOrderByToken(token, branch);
        db.updateOrder(orderId, { status: 'cancelled', cancelledAt: new Date().toISOString(), cancelReason: 'admin' }, branch);
        if (order?.creditApplied > 0) {
            const creditPhone = customerPhone?.replace(/\D/g, '') || 'unknown';
            const newBalance = db.addCredit(creditPhone, order.creditApplied, `Refund of store credit for cancelled order #${token}`);
            logger.info('order cancelled (unpaid), credit refunded', { token, creditRefunded: order.creditApplied, balance: newBalance });
            try { await bot.client.sendMessage(voterChatId, `❌ Order #${token} cancelled. No payment received. ${config.currency}${order.creditApplied} store credit returned (balance: ${config.currency}${newBalance}).`); } catch {}
            await notifyCustomer(`⚠️ *Order #${token} has been cancelled.*\n\nYour ${config.currency}${order.creditApplied} store credit has been returned.\nYour balance: *${config.currency}${newBalance}*`);
        } else {
            logger.info('order cancelled (unpaid)', { token });
            try { await bot.client.sendMessage(voterChatId, `❌ Order #${token} cancelled. No payment received.`); } catch {}
            await notifyCustomer(`⚠️ *Order #${token} has been cancelled.*\n\nNo payment was received. Say *menu* to place a new order.`);
        }
        return;
    }

    if (choice === '👨‍🍳 Cooking') {
        db.updateOrder(orderId, { status: 'preparing' }, branch);
        logger.info('order cooking', { token });
        try { await bot.client.sendMessage(voterChatId, `👨‍🍳 Order #${token} marked as *cooking*.`); } catch {}
        await notifyCustomer(`👨‍🍳 *Order #${token} update*\n\nYour order is now being prepared! We'll let you know when it's ready.\nSay *status* to check anytime.`);
    } else if (choice === '✅ Ready') {
        db.updateOrder(orderId, { status: 'ready', readyAt: new Date().toISOString() }, branch);
        logger.info('order ready', { token });
        try { await bot.client.sendMessage(voterChatId, `✅ Order #${token} marked as *ready*.`); } catch {}
        await notifyCustomer(`🔔 *Your order #${token} is ready for pickup!*\n\nPlease come to the counter with your token number.`);
    } else if (choice === '📦 Picked Up') {
        db.updateOrder(orderId, { status: 'picked_up', pickedUpAt: new Date().toISOString() }, branch);
        logger.info('order picked up', { token });
        try { await bot.client.sendMessage(voterChatId, `📦 Order #${token} marked as *picked up*.`); } catch {}
        await notifyCustomer(`📦 *Order #${token} picked up!*\n\nThank you for your order! We hope you enjoy your meal. 🙏\nSay *menu* to order again anytime.`);
    } else if (choice === '❌ Cancel + Refund') {
        const order = db.updateOrder(orderId, { status: 'cancelled', cancelledAt: new Date().toISOString(), cancelReason: 'admin' }, branch);
        if (order && order.total > 0) {
            const creditPhone = customerPhone?.replace(/\D/g, '') || 'unknown';
            const newBalance = db.addCredit(creditPhone, order.total, `Refund for cancelled order #${token}`);
            logger.info('order cancelled + refunded', { token, credited: order.total, balance: newBalance });
            try { await bot.client.sendMessage(voterChatId, `❌ Order #${token} cancelled. ${config.currency}${order.total} credited (balance: ${config.currency}${newBalance}).`); } catch {}
            await notifyCustomer(`⚠️ *Order #${token} has been cancelled by the restaurant.*\n\n${config.currency}${order.total} has been added as store credit.\nYour balance: *${config.currency}${newBalance}*\n\nThis credit will be applied to your next order automatically.`);
        }
    }
}

// ── Cart & Checkout ────────────────────────────────────

async function handleCart({ chatId, send }) {
    const session = db.getSession(chatId);
    const config = db.getConfig();
    if (!session.cart.length) { await send('Your cart is empty. Say *menu* to see what we have!'); return; }
    await send(formatCart(session.cart, config));
}

async function handleCheckout({ phone, chatId, send, bot }) {
    const session = db.getSession(chatId);
    const config = db.getConfig();

    if (!session.cart.length) { await send('Your cart is empty. Say *menu* to browse our menu!'); return; }

    const existing = db.findPendingByChatId(chatId, session.branch);
    if (existing) {
        await send(`You already have a pending order *#${existing.token}* (${config.currency}${existing.total}).\n\n💳 ${config.paymentNote}\n\nSay *cancel* to cancel it, or send payment to confirm.`);
        return;
    }

    let total = session.cart.reduce((s, c) => s + c.qty * c.price, 0);
    const credit = db.getCredit(phone);
    let creditApplied = 0;
    if (credit > 0) { creditApplied = Math.min(credit, total); db.useCredit(phone, creditApplied); }
    const amountDue = total - creditApplied;

    const order = db.addOrder({
        branch: session.branch, phone, chatId,
        items: session.cart.map(c => ({ id: c.id, name: c.name, qty: c.qty, price: c.price })),
        total, creditApplied, amountDue,
    }, session.branch);

    let msg = `🎫 *Order #${order.token} Created*\n\n`;
    for (const item of order.items) msg += `• ${item.name} × ${item.qty} — ${config.currency}${item.qty * item.price}\n`;
    msg += `\n*Total: ${config.currency}${total}*`;
    if (creditApplied > 0) msg += `\n💰 Credit applied: -${config.currency}${creditApplied}\n*Amount due: ${config.currency}${amountDue}*`;

    if (amountDue > 0) {
        msg += `\n\n💳 ${config.paymentNote}\n\nOnce we receive your payment, we'll start preparing your order.`;
    } else {
        msg += `\n\n✅ Fully paid with store credit!\nYour order is being prepared. Say *status* to check.`;
        db.updateOrder(order.id, { status: 'paid', paidAt: new Date().toISOString(), paymentAmount: 0, paidVia: 'credit' }, session.branch);
    }
    msg += `\nSay *status* anytime to check, or *cancel* to cancel.`;
    await send(msg);

    session.cart = [];
    session.step = amountDue > 0 ? 'paying' : 'idle';

    logger.info('order created', { token: order.token, total, amountDue, phone, chatId });
    await sendAdminOrderPoll(order, session.branch, bot);
}

async function handleCancel({ phone, chatId, send }) {
    const session = db.getSession(chatId);
    const pending = db.findPendingByChatId(chatId, session.branch);
    if (pending) {
        db.updateOrder(pending.id, { status: 'cancelled', cancelledAt: new Date().toISOString(), cancelReason: 'customer' }, session.branch);
        // Refund any credit that was applied at checkout
        if (pending.creditApplied > 0) {
            db.addCredit(phone, pending.creditApplied, `Refund for cancelled order #${pending.token}`);
        }
        logger.info('order cancelled by customer', { token: pending.token, creditRefunded: pending.creditApplied || 0 });
    }
    session.cart = [];
    session.step = 'idle';
    await send('Order cancelled. Say *menu* whenever you\'d like to order again.');
}

// ── Admin Notification Polls ───────────────────────────

/**
 * Send admin order notification with role-based routing.
 *
 * Roles:
 *   owner   — receives ALL notifications (new orders, payment, cooking, ready)
 *   cashier — receives new orders + payment confirmation polls
 *   cook    — receives cooking/ready/pickup polls after payment confirmed
 *
 * If no roles configured, all adminNumbers get everything (backward compat).
 */
async function sendAdminOrderPoll(order, branch, bot) {
    const config = db.getConfig();
    if (!config.adminNumbers.length) return;

    const isPending = order.status === 'pending_payment';

    // Build the text summary
    let text = isPending
        ? `🆕 *New Order #${order.token}* — awaiting payment\n\n`
        : `🔔 *Order #${order.token} PAID*\n\n`;
    order.items.forEach(item => { text += `• ${item.name} × ${item.qty}\n`; });
    text += `\nTotal: ${config.currency}${order.total}`;
    if (order.amountDue && order.amountDue !== order.total) text += ` (due: ${config.currency}${order.amountDue})`;
    if (order.creditApplied > 0) text += ` (credit: -${config.currency}${order.creditApplied})`;
    text += `\nPhone: ${order.phone || 'N/A'}`;

    // Determine who gets what
    // pending_payment → cashier + owner get payment confirmation poll
    // paid            → cook + owner get cooking/ready poll
    const targetAdmins = isPending
        ? db.getAdminsByRole('owner', 'cashier')
        : db.getAdminsByRole('owner', 'cook');

    const pollOptions = isPending
        ? ['💰 Confirm Payment', '❌ Cancel']
        : ['👨‍🍳 Cooking', '✅ Ready', '📦 Picked Up', '❌ Cancel + Refund'];
    const pollTitle = isPending
        ? `Order #${order.token} — ${config.currency}${order.amountDue || order.total} (UNPAID)`
        : `Order #${order.token} — ${config.currency}${order.total} (PAID)`;
    const poll = new Poll(pollTitle, pollOptions, { allowMultipleAnswers: false });

    for (const admin of targetAdmins) {
        const adminChatId = `${admin.replace(/\D/g, '')}@c.us`;
        try {
            const textMsg = await bot.client.sendMessage(adminChatId, text);
            orderMsgMap.set(textMsg.id.id, { orderId: order.id, token: order.token, branch, adminChatId, customerChatId: order.chatId, customerPhone: order.phone });
            const sent = await bot.client.sendMessage(adminChatId, poll);
            pollMap.set(sent.id.id, { type: 'admin_order', orderId: order.id, token: order.token, branch, adminChatId, customerChatId: order.chatId, customerPhone: order.phone });
        } catch (err) {
            logger.error('notify admin failed', admin, err.message);
        }
    }
}

// ── Admin WhatsApp Commands ────────────────────────────

async function handleAdminQueue({ chatId, send, bot }) {
    const config = db.getConfig();
    const branch = config.defaultBranch;
    const orders = db.getOrders(branch).filter(o => ['paid', 'preparing', 'ready', 'pending_payment'].includes(o.status));

    if (!orders.length) { await send('No active orders in the queue.'); return; }

    let text = `📋 *Active Orders* (${branch})\n\n`;
    for (const o of orders) {
        const items = o.items.map(i => `${i.name}×${i.qty}`).join(', ');
        text += `*#${o.token}* ${statusLabel(o.status)}\n  ${items}\n  ${config.currency}${o.total}`;
        if (o.phone) text += ` | ${o.phone}`;
        text += `\n\n`;
    }
    text += `_Commands: "all orders", "payments", "stats"_`;
    await send(text);

    const actionable = orders.filter(o => ['paid', 'preparing'].includes(o.status));
    for (const order of actionable) {
        const poll = new Poll(`Order #${order.token} — ${config.currency}${order.total}`,
            ['👨‍🍳 Cooking', '✅ Ready', '📦 Picked Up', '❌ Cancel + Refund'], { allowMultipleAnswers: false });
        const sent = await bot.client.sendMessage(chatId, poll);
        pollMap.set(sent.id.id, { type: 'admin_order', orderId: order.id, token: order.token, branch, adminChatId: chatId, customerChatId: order.chatId, customerPhone: order.phone });
    }

    const pendingPayment = orders.filter(o => o.status === 'pending_payment');
    for (const order of pendingPayment) {
        const poll = new Poll(`Order #${order.token} — ${config.currency}${order.amountDue || order.total} (UNPAID)`,
            ['💰 Confirm Payment', '❌ Cancel'], { allowMultipleAnswers: false });
        const sent = await bot.client.sendMessage(chatId, poll);
        pollMap.set(sent.id.id, { type: 'admin_order', orderId: order.id, token: order.token, branch, adminChatId: chatId, customerChatId: order.chatId, customerPhone: order.phone });
    }
}

async function handleAdminAllOrders({ send }) {
    const config = db.getConfig();
    const orders = db.getOrders(config.defaultBranch);
    if (!orders.length) { await send('No orders yet.'); return; }

    const recent = orders.slice(-20).reverse();
    let text = `📋 *All Orders* (last 20)\n\n`;
    for (const o of recent) {
        const items = o.items.map(i => `${i.name}×${i.qty}`).join(', ');
        const date = o.createdAt ? new Date(o.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '';
        text += `*#${o.token}* ${statusLabel(o.status)}`;
        if (o.paidVia) text += ` [${o.paidVia}]`;
        text += `\n  ${items}\n  ${config.currency}${o.total}`;
        if (o.phone) text += ` | ${o.phone}`;
        text += `\n  ${date}\n\n`;
    }
    text += `Total orders: ${orders.length}`;
    await send(text);
}

async function handleAdminPayments({ send }) {
    const config = db.getConfig();
    const orders = db.getOrders(config.defaultBranch).filter(o => o.paidAt).slice(-20).reverse();
    if (!orders.length) { await send('No payments received yet.'); return; }

    let text = `💳 *Payment History* (last 20)\n\n`;
    let totalReceived = 0;
    for (const o of orders) {
        const date = new Date(o.paidAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
        text += `*#${o.token}* — ${config.currency}${o.paymentAmount || o.total}`;
        text += ` [${o.paidVia || 'unknown'}]`;
        if (o.creditApplied > 0) text += ` (+${config.currency}${o.creditApplied} credit)`;
        text += ` — ${statusLabel(o.status)}\n`;
        text += `  ${o.phone || 'N/A'} | ${date}\n\n`;
        totalReceived += (o.paymentAmount || o.total);
    }
    text += `*Total received: ${config.currency}${totalReceived}*`;
    await send(text);
}

async function handleAdminStats({ send }) {
    const config = db.getConfig();
    const branch = config.defaultBranch;
    const today = new Date().toISOString().slice(0, 10);
    const allOrders = db.getOrders(branch);
    const todayOrders = allOrders.filter(o => o.createdAt?.startsWith(today));
    const todayPaid = todayOrders.filter(o => !['pending_payment', 'cancelled'].includes(o.status));
    const todayCancelled = todayOrders.filter(o => o.status === 'cancelled');
    const allPaid = allOrders.filter(o => !['pending_payment', 'cancelled'].includes(o.status));

    const credits = db.getCredits();
    let totalCreditOutstanding = 0;
    for (const p of Object.keys(credits)) totalCreditOutstanding += credits[p].amount || 0;

    let text = `📊 *Restaurant Stats*\n\n`;
    text += `*Today (${today})*\n  Orders: ${todayOrders.length} (${todayPaid.length} paid, ${todayCancelled.length} cancelled)\n  Revenue: ${config.currency}${todayPaid.reduce((s, o) => s + o.total, 0)}\n\n`;
    text += `*All Time*\n  Orders: ${allOrders.length}\n  Revenue: ${config.currency}${allPaid.reduce((s, o) => s + o.total, 0)}\n  Outstanding credits: ${config.currency}${totalCreditOutstanding}\n\n`;
    text += `_Commands: "orders", "all orders", "payments"_`;
    await send(text);
}

async function handleAdminPaidReply({ chatId, send, bot, msg }) {
    const quotedMsg = await msg.getQuotedMessage();
    if (!quotedMsg) return false;
    const orderInfo = orderMsgMap.get(quotedMsg.id?.id);
    if (!orderInfo) return false;

    const { orderId, token, branch, customerChatId, customerPhone } = orderInfo;
    const config = db.getConfig();
    const order = db.findOrderByToken(token, branch);
    if (!order) { await send(`Order #${token} not found.`); return true; }
    if (order.status !== 'pending_payment') { await send(`Order #${token} is already *${statusLabel(order.status)}*.`); return true; }

    db.updateOrder(orderId, { status: 'paid', paidAt: new Date().toISOString(), paymentAmount: 0, paidVia: 'manual_reply', paidBy: chatId }, branch);
    logger.info('payment confirmed via reply', { token, by: chatId });
    await send(`💰 Order #${token} payment confirmed.`);

    const notifyChat = customerChatId || (customerPhone ? `${customerPhone.replace(/\D/g, '')}@c.us` : null);
    if (notifyChat) {
        try { await bot.client.sendMessage(notifyChat, `✅ *Payment confirmed for Order #${token}!*\n\nYour token: *#${token}*\nWe're preparing your order now.\nSay *status* to check anytime.`); }
        catch (err) { logger.error('notify customer failed', err.message); }
    }

    const actionPoll = new Poll(`Order #${token} — ${config.currency}${order.total} (PAID)`,
        ['👨‍🍳 Cooking', '✅ Ready', '📦 Picked Up', '❌ Cancel + Refund'], { allowMultipleAnswers: false });
    const sent = await bot.client.sendMessage(chatId, actionPoll);
    pollMap.set(sent.id.id, { type: 'admin_order', orderId, token, branch, adminChatId: chatId, customerChatId, customerPhone });
    return true;
}

async function handleAdminPaid({ chatId, send, bot, match }) {
    const config = db.getConfig();
    const token = parseInt(match[1], 10);
    const branch = config.defaultBranch;
    const order = db.findOrderByToken(token, branch);
    if (!order) { await send(`Order #${token} not found.`); return; }
    if (order.status !== 'pending_payment') { await send(`Order #${token} is already *${statusLabel(order.status)}*.`); return; }

    db.updateOrder(order.id, { status: 'paid', paidAt: new Date().toISOString(), paymentAmount: 0, paidVia: 'manual_text', paidBy: chatId }, branch);
    logger.info('payment confirmed via text cmd', { token, by: chatId });
    await send(`💰 Order #${token} payment confirmed.`);

    const notifyChat = order.chatId || (order.phone ? `${order.phone.replace(/\D/g, '')}@c.us` : null);
    if (notifyChat) {
        try { await bot.client.sendMessage(notifyChat, `✅ *Payment confirmed for Order #${token}!*\n\nYour token: *#${token}*\nWe're preparing your order now.\nSay *status* to check anytime.`); }
        catch (err) { logger.error('notify customer failed', err.message); }
    }

    const actionPoll = new Poll(`Order #${token} — ${config.currency}${order.total} (PAID)`,
        ['👨‍🍳 Cooking', '✅ Ready', '📦 Picked Up', '❌ Cancel + Refund'], { allowMultipleAnswers: false });
    const sent = await bot.client.sendMessage(chatId, actionPoll);
    pollMap.set(sent.id.id, { type: 'admin_order', orderId: order.id, token: order.token, branch, adminChatId: chatId, customerChatId: order.chatId, customerPhone: order.phone });
}

async function handleMarkReady({ send, bot, match }) {
    const config = db.getConfig();
    const token = parseInt(match[1], 10);
    const branch = config.defaultBranch;
    const order = db.findOrderByToken(token, branch);
    if (!order) { await send(`Order #${token} not found.`); return; }

    db.updateOrder(order.id, { status: 'ready', readyAt: new Date().toISOString() }, branch);
    await send(`✅ Order #${token} marked as ready.`);
    const customerChat = order.chatId || `${order.phone?.replace(/\D/g, '')}@c.us`;
    try { await bot.client.sendMessage(customerChat, `🔔 *Your order #${token} is ready for pickup!*\n\nPlease come to the counter with your token number.`); }
    catch (err) { logger.error('notify customer failed', err.message); }
}

// ── Helpers ────────────────────────────────────────────

function formatCart(cart, config) {
    let text = '🛒 *Your Cart*\n\n';
    let total = 0;
    for (const item of cart) { const sub = item.qty * item.price; total += sub; text += `• ${item.name} × ${item.qty} — ${config.currency}${sub}\n`; }
    text += `\n*Total: ${config.currency}${total}*\n\nSay *done* to place your order, or *menu* to start over.`;
    return text;
}

module.exports = {
    handleGreeting, handleVote, handleCart, handleCheckout,
    handleCancel, handleAdminQueue, handleAdminAllOrders,
    handleAdminPayments, handleAdminStats, handleAdminPaid,
    handleAdminPaidReply, handleMarkReady, sendAdminOrderPoll,
    pollMap, orderMsgMap,
};

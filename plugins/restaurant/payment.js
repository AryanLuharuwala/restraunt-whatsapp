/**
 * Payment handling & token status checks.
 */

const db = require('./db');
const { logger } = db;

const PAYMENT_STATUS = {
    0: 'UNKNOWN', 1: 'PROCESSING', 2: 'SENT', 3: 'NEED_TO_ACCEPT',
    4: 'COMPLETE', 5: 'COULD_NOT_COMPLETE', 6: 'REFUNDED', 7: 'EXPIRED',
    8: 'REJECTED', 9: 'CANCELLED', 10: 'WAITING_FOR_PAYER', 11: 'WAITING',
};

async function handlePaymentReceived({ phone, chatId, msg, send, bot }) {
    const config = db.getConfig();

    let payment;
    try { payment = await msg.getPayment(); }
    catch (err) { logger.error('getPayment failed', err.message); }

    if (!payment) {
        payment = {
            paymentAmount1000: msg._data?.paymentAmount1000 || 0,
            paymentStatus: msg._data?.paymentStatus,
            paymentCurrency: msg._data?.paymentCurrency,
            paymentNote: msg._data?.paymentNoteMsg?.body,
        };
    }

    const statusCode = payment.paymentStatus;
    const statusName = PAYMENT_STATUS[statusCode] || `UNKNOWN(${statusCode})`;
    const amountRaw = payment.paymentAmount1000 || 0;
    const amount = Math.round(amountRaw / 1000);

    logger.info('payment received', { phone, chatId, amount, status: statusName, raw: amountRaw });

    const session = db.getSession(chatId);
    let order = db.findPendingByChatId(chatId, session.branch);
    if (!order) order = db.findPendingByPhone(phone, session.branch);

    if (!order) {
        await send('Payment received, but no pending order found. Please contact the restaurant if this is an error.');
        return;
    }

    const isRejected = [5, 6, 7, 8, 9].includes(statusCode);
    if (isRejected) {
        await send(`⚠️ Payment for Order #${order.token} was ${statusName.toLowerCase()}.\nPlease try again or contact the restaurant.`);
        return;
    }

    const amountDue = order.amountDue || order.total;
    if (amount > 0 && amount < amountDue) {
        await send(`⚠️ Payment of ${config.currency}${amount} received for Order #${order.token}, but the amount due is ${config.currency}${amountDue}.\n\nPlease send the remaining ${config.currency}${amountDue - amount}.`);
        return;
    }

    const updated = db.updateOrder(order.id, {
        status: 'paid', paidAt: new Date().toISOString(),
        paymentAmount: amount, paidVia: 'whatsapp_pay', paidBy: chatId,
    }, session.branch);

    logger.info('payment confirmed via WhatsApp Pay', { token: order.token, amount, chatId });

    await send(
        `✅ *Payment received!*\n\n` +
        `Order #${order.token} — ${config.currency}${order.total}\n` +
        `Status: *Paid — Preparing your order*\n\n` +
        `Your token: *#${order.token}*\n` +
        `We'll notify you when it's ready for pickup.\n\n` +
        `Say *status* to check your order anytime.`
    );

    const { sendAdminOrderPoll } = require('./ordering');
    await sendAdminOrderPoll(updated || order, session.branch, bot);
    db.clearSession(chatId);
}

async function handleStatus({ phone, chatId, text, send }) {
    const session = db.getSession(chatId);
    const config = db.getConfig();

    const tokenMatch = text.match(/\d+/);
    if (tokenMatch) {
        const token = parseInt(tokenMatch[0], 10);
        const order = db.findOrderByToken(token, session.branch);
        if (!order) { await send(`No active order found with token #${token}.`); return; }

        let msg = `🎫 *Order #${order.token}*\n\n`;
        order.items.forEach(item => { msg += `• ${item.name} × ${item.qty} — ${config.currency}${item.qty * item.price}\n`; });
        msg += `\n*Total: ${config.currency}${order.total}*`;
        if (order.creditApplied > 0) msg += `\n💰 Credit applied: -${config.currency}${order.creditApplied}`;
        msg += `\nStatus: *${statusLabel(order.status)}*\n`;
        if (order.status === 'ready') msg += `\n🔔 Your order is *ready for pickup!*`;
        await send(msg);
        return;
    }

    const orders = db.getOrders(session.branch)
        .filter(o => (o.chatId === chatId || o.phone === phone) && !['cancelled', 'picked_up'].includes(o.status))
        .slice(-5);

    if (!orders.length) { await send('No active orders. Say *menu* to place an order.'); return; }

    let msg = '📋 *Your Orders*\n\n';
    for (const o of orders) msg += `*#${o.token}* — ${config.currency}${o.total} — ${statusLabel(o.status)}\n`;

    const credit = db.getCredit(phone);
    if (credit > 0) msg += `\n💰 Store credit: *${config.currency}${credit}*`;
    await send(msg);
}

function statusLabel(status) {
    const labels = {
        pending_payment: '⏳ Awaiting Payment',
        paid: '👨‍🍳 Preparing',
        preparing: '👨‍🍳 Preparing',
        ready: '✅ Ready for Pickup',
        picked_up: '📦 Picked Up',
        cancelled: '❌ Cancelled',
    };
    return labels[status] || status;
}

module.exports = { handlePaymentReceived, handleStatus, statusLabel };

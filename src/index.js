// chat-animation-bot — Cloudflare Worker entrypoint
// Telegram Business Chat Automation + Cloudflare Workers AI
// Behavior: only the configured owner's Business connection is served;
// owner messages trigger replies only when they contain a command.

import { generateAssistantReply } from './robot-ai.js';

const TELEGRAM_API = 'https://api.telegram.org/bot';
const MAX_TELEGRAM_TEXT = 4096;
const BOT_DISPLAY_NAME = '4 0 4 \\ 2.0 [🇲🇲]';
const startedAt = Date.now();
const metrics = { received: 0, replied: 0, skipped: 0, errors: 0 };
const connections = new Map();

const PRODUCT_RICH_MESSAGE = {
    markdown: [
        '# Available Products ✅',
        '---',
        '## Digital Ocean Accounts',
        '| Package | Price | Details |',
        '| --- | ---: | --- |',
        '| 3 Droplets | 35,000 Ks | 5$ trial account, card-made check, secure-login warranty |',
        '| 10 Droplets | 40,000 Ks | 5$ trial account, card-made check, secure-login warranty |',
        '| 3 Droplets | 50,000 Ks | 5$ PayPal paid check, secure-login warranty |',
        '',
        '## All SIM / WiFi Data Packages',
        '| Data volume | Price | Availability |',
        '| --- | ---: | --- |',
        '| 150 GB | 4,000 Ks | All SIM, WiFi & Starlink ✅ |',
        '| 250 GB | 5,500 Ks | All SIM, WiFi & Starlink ✅ |',
        '| 500 GB | 8,500 Ks | All SIM, WiFi & Starlink ✅ |',
        '',
        '## VPS Prices',
        '| CPU | Memory | Disk | Price | Traffic | Location |',
        '| --- | --- | --- | ---: | --- | --- |',
        '| 2 Core | 3 GB | 30 GB | 35,000 Ks | Unlimited ✅ | Thailand 🇹🇭 |',
        '| 4 Core | 6 GB | 60 GB | 70,000 Ks | Unlimited ✅ | Thailand 🇹🇭 |',
        '| 6 Core | 12 GB | 100 GB | 100,000 Ks | Unlimited ✅ | Thailand 🇹🇭 |',
        '| 2 Core | 4 GB | 100 GB | 50,000 Ks | Unlimited ✅ | Thailand 🇹🇭 |',
        '| 3 Core | 8 GB | 200 GB | 100,000 Ks | Unlimited ✅ | Thailand 🇹🇭 |',
        '| 1 Core | 1 GB | 30 GB | 35,000 Ks | 5 TB ✅ | Singapore 🇸🇬 |',
        '| 2 Core | 2 GB | 60 GB | 50,000 Ks | 10 TB ✅ | Singapore 🇸🇬 |',
        '| 2 Core | 4 GB | 120 GB | 80,000 Ks | 15 TB ✅ | Singapore 🇸🇬 |',
        '',
        '📩 For more information and to purchase, contact [@nkka404](https://t.me/nkka404).',
    ].join('\n'),
};

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8' },
    });
}

function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function truncate(value, max = MAX_TELEGRAM_TEXT) {
    const input = text(value);
    return input.length <= max ? input : `${input.slice(0, max - 1)}…`;
}

function getToken(env) {
    return text(env.TELEGRAM_BOT_TOKEN);
}

function formatUptime(milliseconds) {
    let seconds = Math.max(0, Math.floor(milliseconds / 1000));
    const days = Math.floor(seconds / 86400);
    seconds %= 86400;
    const hours = Math.floor(seconds / 3600);
    seconds %= 3600;
    const minutes = Math.floor(seconds / 60);
    seconds %= 60;
    return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

function ownerIds(env) {
    return [text(env.OWNER_TELEGRAM_ID), ...text(env.STAT_OWNER_IDS).split(',')]
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isSafeInteger(value) && value > 0);
}

function statisticsText() {
    return [
        `📊 ${BOT_DISPLAY_NAME}`,
        '',
        `⏱ Uptime: ${formatUptime(Date.now() - startedAt)}`,
        `📩 User messages: ${metrics.received}`,
        `✅ AI replies: ${metrics.replied}`,
        `⏭ Skipped: ${metrics.skipped}`,
        `❌ Errors: ${metrics.errors}`,
    ].join('\n');
}

async function telegram(env, method, payload) {
    const token = getToken(env);
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured.');

    const response = await fetch(`${TELEGRAM_API}${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
        throw new Error(`Telegram ${method} failed: ${data.description || response.status}`);
    }
    return data;
}

function replyPayload(message) {
    return message.message_id ? { reply_parameters: { message_id: message.message_id } } : {};
}

async function sendBusinessMessage(env, message, replyText) {
    return telegram(env, 'sendMessage', {
        chat_id: message.chat.id,
        text: truncate(replyText),
        disable_web_page_preview: true,
        business_connection_id: message.business_connection_id,
        ...replyPayload(message),
    });
}

async function sendBusinessRichMessage(env, message) {
    const payload = {
        chat_id: message.chat.id,
        rich_message: PRODUCT_RICH_MESSAGE,
        business_connection_id: message.business_connection_id,
        disable_web_page_preview: true,
        reply_markup: {
            inline_keyboard: [[{ text: '📩 Contact @nkka404', url: 'https://t.me/nkka404' }]],
        },
        ...replyPayload(message),
    };

    try {
        return await telegram(env, 'sendRichMessage', payload);
    } catch (error) {
        console.warn('Rich message unavailable; using plain-text fallback:', error.message);
        return sendBusinessMessage(env, message, productFallbackText());
    }
}

async function sendTyping(env, message) {
    return telegram(env, 'sendChatAction', {
        chat_id: message.chat.id,
        action: 'typing',
        business_connection_id: message.business_connection_id,
    });
}

function messageText(message) {
    return text(message?.text || message?.caption);
}

function isSupportedBusinessMessage(message) {
    return Boolean(
        message?.business_connection_id
        && message?.chat?.id
        && message?.from?.id
        && !message?.from?.is_bot
        && !message?.sender_business_bot
        && messageText(message),
    );
}

function canReplyToBusinessMessage(message) {
    const rights = connections.get(message?.business_connection_id)?.rights;
    return rights?.can_reply !== false;
}

function isCommand(value) {
    return /^\/\w+(?:@\w+)?(?:\s|$)/.test(text(value));
}

function isProductCommand(value) {
    return /^\/(?:products?|price|catalog|digital)(?:@\w+)?(?:\s|$)/i.test(text(value));
}

function productFallbackText() {
    return [
        'Available Products ✅',
        '',
        'Digital Ocean: 3 Droplets 35,000 Ks | 10 Droplets 40,000 Ks | PayPal package 50,000 Ks',
        'SIM / WiFi: 150 GB 4,000 Ks | 250 GB 5,500 Ks | 500 GB 8,500 Ks',
        'VPS: from 35,000 Ks to 100,000 Ks, Thailand 🇹🇭 / Singapore 🇸🇬',
        '',
        '📩 For more information and to purchase: @nkka404',
    ].join('\n');
}

function isOwnerConnection(message, env) {
    const connectionOwnerId = connections.get(message?.business_connection_id)?.user?.id;
    const allowedOwners = ownerIds(env);
    return allowedOwners.length > 0 && allowedOwners.includes(Number(connectionOwnerId));
}

function isOwnerSender(message, env) {
    return ownerIds(env).includes(Number(message?.from?.id));
}

async function handleBusinessMessage(update, env) {
    const message = update.business_message;
    if (!isSupportedBusinessMessage(message)) {
        metrics.skipped += 1;
        return { ignored: true, reason: 'unsupported' };
    }
    metrics.received += 1;

    if (!canReplyToBusinessMessage(message)) {
        metrics.skipped += 1;
        console.warn('Business connection does not have can_reply:', message.business_connection_id);
        return { ignored: true, reason: 'can_reply_missing' };
    }

    // Fail closed: only the configured owner's Business account is served.
    if (!isOwnerConnection(message, env)) {
        metrics.skipped += 1;
        console.warn('Skipped an unconfigured Business connection. Set OWNER_TELEGRAM_ID.');
        return { ignored: true, reason: 'owner_connection_only' };
    }

    const prompt = messageText(message);

    // Owner messages are administrative only. Ordinary owner text is ignored.
    if (isOwnerSender(message, env) && !isCommand(prompt)) {
        metrics.skipped += 1;
        return { ignored: true, reason: 'owner_non_command' };
    }

    if (isProductCommand(prompt)) {
        await sendBusinessRichMessage(env, message);
        metrics.replied += 1;
        return { ok: true, command: 'products' };
    }

    if (/^\/stat(?:@\w+)?(?:\s|$)/i.test(prompt)) {
        if (isOwnerSender(message, env)) {
            await sendBusinessMessage(env, message, statisticsText());
            metrics.replied += 1;
        } else {
            metrics.skipped += 1;
        }
        return { ok: true, command: 'stat' };
    }

    if (prompt.startsWith('/disable_ai') || prompt.startsWith('/stop')) {
        await sendBusinessMessage(env, message, 'AI chat automation is connected. To disable it, open Telegram Business Settings → Chatbots and remove this bot.');
        metrics.replied += 1;
        return { ok: true, command: 'disable_info' };
    }

    if (prompt.startsWith('/help')) {
        await sendBusinessMessage(env, message, 'I am 4 0 4 \\ 2.0 [🇲🇲]. Send a customer message and I will reply on your behalf. Use /products to show the digital product catalog.');
        metrics.replied += 1;
        return { ok: true, command: 'help' };
    }

    await sendTyping(env, message).catch((error) => console.warn('Typing action failed:', error.message));
    const reply = await generateAssistantReply(prompt, env, {
        senderName: [message.from.first_name, message.from.last_name].filter(Boolean).join(' '),
        chatType: message.chat.type,
    });
    await sendBusinessMessage(env, message, reply);
    metrics.replied += 1;
    return { ok: true, command: 'ai_reply' };
}

async function verifyWebhook(request, env) {
    const expected = text(env.TELEGRAM_WEBHOOK_SECRET);
    if (!expected) return true;
    return request.headers.get('X-Telegram-Bot-Api-Secret-Token') === expected;
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (request.method === 'GET' && url.pathname === '/') {
            return json({ ok: true, service: 'chat-animation-bot', bot: BOT_DISPLAY_NAME, mode: 'owner-only-user-reply' });
        }

        if (request.method !== 'POST' || url.pathname !== '/webhook') {
            return json({ ok: false, error: 'Not found' }, 404);
        }

        if (!(await verifyWebhook(request, env))) return json({ ok: false, error: 'Unauthorized' }, 401);

        let update;
        try {
            update = await request.json();
        } catch {
            return json({ ok: false, error: 'Invalid JSON' }, 400);
        }

        const task = (async () => {
            try {
                if (update.business_message) {
                    await handleBusinessMessage(update, env);
                } else if (update.edited_business_message) {
                    console.log('Ignored edited_business_message', update.update_id);
                } else if (update.business_connection) {
                    const connection = update.business_connection;
                    connections.set(connection.id, {
                        user: connection.user,
                        rights: connection.rights || {},
                        enabled: connection.is_enabled,
                    });
                    console.log('Business connection:', JSON.stringify({
                        id: connection.id,
                        user_id: connection.user?.id,
                        can_reply: connection.rights?.can_reply,
                        enabled: connection.is_enabled,
                    }));
                }
            } catch (error) {
                metrics.errors += 1;
                console.error('Business update failed:', error);
            }
        })();

        if (ctx?.waitUntil) ctx.waitUntil(task);
        else await task;
        return json({ ok: true });
    },
};

export { handleBusinessMessage, sendBusinessMessage, sendBusinessRichMessage, telegram, statisticsText };

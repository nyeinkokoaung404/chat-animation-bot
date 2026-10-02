// chat-animation-bot — Cloudflare Worker entrypoint
// Telegram Business Chat Automation + Cloudflare Workers AI

import { generateAssistantReply } from './robot-ai.js';

const TELEGRAM_API = 'https://api.telegram.org/bot';
const MAX_TELEGRAM_TEXT = 4096;
const BOT_DISPLAY_NAME = '4 0 4 \\ 2.0 [🇲🇲]';
const startedAt = Date.now();
const metrics = {
    received: 0,
    replied: 0,
    skipped: 0,
    errors: 0,
};
const connections = new Map();

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

function getConfiguredOwnerIds(env) {
    return text(env.STAT_OWNER_IDS)
        .split(',')
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isSafeInteger(value) && value > 0);
}

function isOwnerMessage(message, env) {
    const connection = connections.get(message?.business_connection_id);
    const connectedOwnerId = connection?.user?.id;
    const configuredOwnerIds = getConfiguredOwnerIds(env);
    return Number(message?.from?.id) === Number(connectedOwnerId)
        || configuredOwnerIds.includes(Number(message?.from?.id));
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

async function sendBusinessMessage(env, message, replyText) {
    const payload = {
        chat_id: message.chat.id,
        text: truncate(replyText),
        disable_web_page_preview: true,
        business_connection_id: message.business_connection_id,
    };

    // Keep the reply in the same conversation when Telegram provides a
    // message identifier. Telegram Business bots must include the connection ID.
    if (message.message_id) {
        payload.reply_parameters = { message_id: message.message_id };
    }
    return telegram(env, 'sendMessage', payload);
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
    // If no connection update has reached this Worker instance yet, let
    // Telegram decide. Once rights are known, enforce can_reply explicitly.
    return rights?.can_reply !== false;
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

    const prompt = messageText(message);
    if (/^\/stat(?:@\w+)?(?:\s|$)/i.test(prompt)) {
        if (isOwnerMessage(message, env)) {
            await sendBusinessMessage(env, message, statisticsText());
            metrics.replied += 1;
        } else {
            metrics.skipped += 1;
        }
        return { ok: true, command: 'stat' };
    }
    if (prompt.startsWith('/disable_ai') || prompt.startsWith('/stop')) {
        await sendBusinessMessage(env, message, 'AI chat automation is still connected. To disable it, open Telegram Business Settings → Chatbots and remove this bot.');
        return { ok: true, command: 'disable_info' };
    }

    if (prompt.startsWith('/help')) {
        await sendBusinessMessage(env, message, 'I am your chat automation assistant. Send a message and I will reply on your behalf.\n\nUse /stop for instructions to disconnect the chatbot.');
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
            return json({ ok: true, service: 'chat-animation-bot', bot: BOT_DISPLAY_NAME, mode: 'user-reply-only' });
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

        // Telegram retries failed webhooks. Return quickly and finish AI work in
        // waitUntil so Cloudflare can keep the webhook response under the limit.
        const task = (async () => {
            try {
                if (update.business_message) await handleBusinessMessage(update, env);
                else if (update.edited_business_message) {
                    // Avoid duplicate responses to edited messages by default.
                    console.log('Ignored edited_business_message', update.update_id);
                } else if (update.business_connection) {
                    const connection = update.business_connection;
                    connections.set(connection.id, {
                        user: connection.user,
                        rights: connection.rights || {},
                        enabled: connection.is_enabled,
                    });
                    console.log('Business connection update', JSON.stringify({
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

export { handleBusinessMessage, sendBusinessMessage, telegram, statisticsText };

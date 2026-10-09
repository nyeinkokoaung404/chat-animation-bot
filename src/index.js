// chat-animation-bot — Cloudflare Worker entrypoint
// Telegram Business Chat Automation + Cloudflare Workers AI
//
// Behavior:
// - Business chats: the AI answers customer messages ONLY while the admin
//   (owner) is offline — i.e. the owner has not sent a message in that chat
//   within ADMIN_ACTIVE_WINDOW_MINUTES (default 5). The admin can also flip
//   the master switch with /ai_on and /ai_off in the bot's private chat.
// - Commands (/start, /help, /stat, /products, /ai_on, /ai_off, /ai_status)
//   work ONLY in the bot's private chat (a normal update.message whose
//   chat.type is "private"). Commands sent anywhere else are ignored.
// - AI replies are delivered as Telegram Rich Messages (Bot API 10.1+,
//   https://core.telegram.org/bots/api-changelog#june-11-2026 and the
//   August 24, 2026 update) via sendRichMessage, with a plain-text
//   sendMessage fallback.

import { generateAssistantReply, toRichMessage, stripMarkdown } from './robot-ai.js';

const TELEGRAM_API = 'https://api.telegram.org/bot';
const MAX_TELEGRAM_TEXT = 4096;
const BOT_DISPLAY_NAME = '4 0 4 \\ 2.0 [🇲🇲]';
const startedAt = Date.now();
const metrics = { received: 0, replied: 0, skipped: 0, errors: 0 };
const connections = new Map();

// Admin presence tracking: business chat id -> timestamp (ms) of the owner's
// last message in that chat. While the admin is "online" the AI stays quiet.
// NOTE: Workers isolates are ephemeral, so this map resets when the isolate
// is recycled. The /ai_on|/ai_off master switch is the durable control.
const ownerLastSeenAt = new Map();
let aiGloballyEnabled = true;

const CONTACT_RICH_MESSAGE = {
    // NOTE: InputRichMessage.markdown is a String (not an array).
    markdown: [
        '# Contact Us 📞',
        '---',
        'Have a question or need help? Reach us directly:',
        '',
        '## Viber',
        '📱 `09260879757`',
        '',
        '## Facebook',
        '🔗 [www.nyeinkokoaung.2015](https://www.facebook.com/www.nyeinkokoaung.2015)',
        '',
        'We usually reply as soon as possible. 🤖',
    ].join('\n'),
};

const CONTACT_BUTTON = {
    inline_keyboard: [[{ text: '🔗 Facebook', url: 'https://www.facebook.com/www.nyeinkokoaung.2015' }]],
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

// ---- Admin presence -------------------------------------------------------

function adminActiveWindowMs(env) {
    const minutes = Number(text(env.ADMIN_ACTIVE_WINDOW_MINUTES));
    const safe = Number.isFinite(minutes) && minutes > 0 ? minutes : 5;
    return safe * 60 * 1000;
}

function markAdminSeen(chatId) {
    ownerLastSeenAt.set(chatId, Date.now());
}

function isAdminOnline(chatId, env) {
    const last = ownerLastSeenAt.get(chatId);
    return typeof last === 'number' && Date.now() - last < adminActiveWindowMs(env);
}

// ---- Text builders --------------------------------------------------------

function statisticsText(env) {
    return [
        `📊 ${BOT_DISPLAY_NAME}`,
        '',
        `⏱ Uptime: ${formatUptime(Date.now() - startedAt)}`,
        `📩 User messages: ${metrics.received}`,
        `✅ AI replies: ${metrics.replied}`,
        `⏭ Skipped: ${metrics.skipped}`,
        `❌ Errors: ${metrics.errors}`,
        '',
        `🤖 AI auto-reply: ${aiGloballyEnabled ? 'ON ✅' : 'OFF ⛔'}`,
        `🟢 Admin active window: ${adminActiveWindowMs(env) / 60000} min`,
    ].join('\n');
}

function aiStatusText(env) {
    const lines = [
        `🤖 AI auto-reply: ${aiGloballyEnabled ? 'ON ✅' : 'OFF ⛔'}`,
        `🟢 Admin counts as online for ${adminActiveWindowMs(env) / 60000} min after their last message in a chat.`,
        '',
        'Admin presence by business chat:',
    ];
    if (ownerLastSeenAt.size === 0) {
        lines.push('(no business chat activity seen yet)');
    }
    for (const [chatId, seenAt] of ownerLastSeenAt) {
        const mins = Math.floor((Date.now() - seenAt) / 60000);
        lines.push(`• ${chatId}: last seen ${mins}m ago — ${isAdminOnline(chatId, env) ? 'online 🟢' : 'offline ⚪'}`);
    }
    return lines.join('\n');
}

function helpText() {
    return [
        `🤖 ${BOT_DISPLAY_NAME}`,
        '',
        'I answer your business chats with AI while you are offline.',
        '',
        'Commands (private chat only):',
        '/contact — contact info (Viber, Facebook)',
        '/ai_on — enable AI auto-replies',
        '/ai_off — disable AI auto-replies',
        '/ai_status — AI status and admin presence',
        '/stat — runtime statistics (owner only)',
        '/help — this message',
    ].join('\n');
}

function contactFallbackText() {
    return [
        'Contact Us 📞',
        '',
        'Viber: 09260879757',
        'Facebook: https://www.facebook.com/www.nyeinkokoaung.2015',
        '',
        'We usually reply as soon as possible.',
    ].join('\n');
}

// ---- Telegram API ---------------------------------------------------------

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

// Generic Rich Message sender for business chats (Bot API 10.1+,
// https://core.telegram.org/bots/api#sendrichmessage). Falls back to plain
// text when the rich format is rejected.
async function sendBusinessRichMessage(env, message, richMessage, fallbackText, replyMarkup) {
    const payload = {
        chat_id: message.chat.id,
        rich_message: richMessage,
        business_connection_id: message.business_connection_id,
        ...replyPayload(message),
    };
    if (replyMarkup) payload.reply_markup = replyMarkup;

    try {
        return await telegram(env, 'sendRichMessage', payload);
    } catch (error) {
        console.warn('Rich message unavailable; using plain-text fallback:', error.message);
        return sendBusinessMessage(env, message, fallbackText);
    }
}

// AI replies go out as Telegram Rich Messages (Bot API 10.1+, extended
// August 24, 2026). The payload shape is built by robot-ai.js so the AI layer
// owns rich-message formatting. If rich sending fails, the fallback strips
// Markdown so the user sees clean text instead of raw markup.
async function sendBusinessAIReply(env, message, replyText) {
    return sendBusinessRichMessage(env, message, toRichMessage(replyText), stripMarkdown(replyText));
}

async function sendPrivateMessage(env, chatId, replyText) {
    return telegram(env, 'sendMessage', {
        chat_id: chatId,
        text: truncate(replyText),
        disable_web_page_preview: true,
    });
}

async function sendPrivateRichMessage(env, chatId, richMessage, fallbackText, replyMarkup) {
    const payload = {
        chat_id: chatId,
        rich_message: richMessage,
    };
    if (replyMarkup) payload.reply_markup = replyMarkup;

    try {
        return await telegram(env, 'sendRichMessage', payload);
    } catch (error) {
        console.warn('Rich message unavailable; using plain-text fallback:', error.message);
        return sendPrivateMessage(env, chatId, fallbackText);
    }
}

async function sendTyping(env, message) {
    return telegram(env, 'sendChatAction', {
        chat_id: message.chat.id,
        action: 'typing',
        business_connection_id: message.business_connection_id,
    });
}

// ---- Message helpers ------------------------------------------------------

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

function isContactCommand(value) {
    return /^\/(?:contact|products?|price|catalog|digital)(?:@\w+)?(?:\s|$)/i.test(text(value));
}

function isOwnerConnection(message, env) {
    const allowedConnectionId = text(env.BUSINESS_CONNECTION_ID);
    const currentConnectionId = text(message?.business_connection_id);

    // A Worker isolate may receive business_message without first receiving
    // business_connection, so do not depend on the in-memory Map here.
    // If an explicit connection ID is configured, enforce it strictly.
    if (allowedConnectionId) return currentConnectionId === allowedConnectionId;

    // This bot is dedicated to the owner's single Business account. The
    // required OWNER_TELEGRAM_ID prevents an accidentally unconfigured bot
    // from replying to arbitrary connections.
    return ownerIds(env).length > 0;
}

function isOwnerSender(message, env) {
    return ownerIds(env).includes(Number(message?.from?.id));
}

// ---- Business chat handler: AI replies only while the admin is offline -----

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

    // Any owner message marks the admin as online/active in this chat and
    // never receives an AI reply.
    if (isOwnerSender(message, env)) {
        markAdminSeen(message.chat.id);
        metrics.skipped += 1;
        return { ignored: true, reason: 'owner_message' };
    }

    // Commands only work in the bot's private chat.
    if (isCommand(prompt)) {
        metrics.skipped += 1;
        return { ignored: true, reason: 'command_private_only' };
    }

    // Master switch (controlled from the private chat).
    if (!aiGloballyEnabled) {
        metrics.skipped += 1;
        return { ignored: true, reason: 'ai_disabled' };
    }

    // Stay quiet while the admin is handling the chat themselves.
    if (isAdminOnline(message.chat.id, env)) {
        metrics.skipped += 1;
        return { ignored: true, reason: 'admin_online' };
    }

    await sendTyping(env, message).catch((error) => console.warn('Typing action failed:', error.message));
    const reply = await generateAssistantReply(prompt, env, {
        senderName: [message.from.first_name, message.from.last_name].filter(Boolean).join(' '),
        chatType: message.chat.type,
    });
    await sendBusinessAIReply(env, message, reply);
    metrics.replied += 1;
    return { ok: true, command: 'ai_reply' };
}

// ---- Private chat handler: commands live here only ------------------------

async function handlePrivateMessage(update, env) {
    const message = update.message;
    if (!message?.chat?.id) {
        return { ignored: true, reason: 'unsupported' };
    }

    // Commands are only usable in the bot's private chat.
    if (message.chat.type !== 'private') {
        metrics.skipped += 1;
        return { ignored: true, reason: 'non_private_chat' };
    }

    const prompt = messageText(message);
    if (!prompt) {
        metrics.skipped += 1;
        return { ignored: true, reason: 'no_text' };
    }
    metrics.received += 1;

    const chatId = message.chat.id;
    const owner = isOwnerSender(message, env);

    if (/^\/(?:start|help)(?:@\w+)?(?:\s|$)/i.test(prompt)) {
        await sendPrivateMessage(env, chatId, helpText());
        metrics.replied += 1;
        return { ok: true, command: 'help' };
    }

    if (isContactCommand(prompt)) {
        await sendPrivateRichMessage(env, chatId, CONTACT_RICH_MESSAGE, contactFallbackText(), CONTACT_BUTTON);
        metrics.replied += 1;
        return { ok: true, command: 'contact' };
    }

    if (/^\/stat(?:@\w+)?(?:\s|$)/i.test(prompt)) {
        if (!owner) {
            await sendPrivateMessage(env, chatId, '⛔ This command is for the bot owner only.');
            metrics.skipped += 1;
            return { ignored: true, reason: 'not_owner' };
        }
        await sendPrivateMessage(env, chatId, statisticsText(env));
        metrics.replied += 1;
        return { ok: true, command: 'stat' };
    }

    if (/^\/ai_on(?:@\w+)?(?:\s|$)/i.test(prompt)) {
        if (!owner) {
            await sendPrivateMessage(env, chatId, '⛔ This command is for the bot owner only.');
            metrics.skipped += 1;
            return { ignored: true, reason: 'not_owner' };
        }
        aiGloballyEnabled = true;
        await sendPrivateMessage(env, chatId, '🤖 AI auto-replies are now ON. I will answer business chats while you are offline.');
        metrics.replied += 1;
        return { ok: true, command: 'ai_on' };
    }

    if (/^\/ai_off(?:@\w+)?(?:\s|$)/i.test(prompt)) {
        if (!owner) {
            await sendPrivateMessage(env, chatId, '⛔ This command is for the bot owner only.');
            metrics.skipped += 1;
            return { ignored: true, reason: 'not_owner' };
        }
        aiGloballyEnabled = false;
        await sendPrivateMessage(env, chatId, '🤖 AI auto-replies are now OFF. Business chats will not receive AI answers until you run /ai_on.');
        metrics.replied += 1;
        return { ok: true, command: 'ai_off' };
    }

    if (/^\/ai_status(?:@\w+)?(?:\s|$)/i.test(prompt)) {
        if (!owner) {
            await sendPrivateMessage(env, chatId, '⛔ This command is for the bot owner only.');
            metrics.skipped += 1;
            return { ignored: true, reason: 'not_owner' };
        }
        await sendPrivateMessage(env, chatId, aiStatusText(env));
        metrics.replied += 1;
        return { ok: true, command: 'ai_status' };
    }

    await sendPrivateMessage(env, chatId, 'I only take commands here. Send /help to see what I can do. 🤖');
    metrics.replied += 1;
    return { ok: true, command: 'hint' };
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
            return json({ ok: true, service: 'chat-animation-bot', bot: BOT_DISPLAY_NAME, mode: 'admin-offline-ai-rich' });
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
                } else if (update.message) {
                    await handlePrivateMessage(update, env);
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

export { handleBusinessMessage, handlePrivateMessage, sendBusinessMessage, sendBusinessRichMessage, sendBusinessAIReply, sendPrivateMessage, sendPrivateRichMessage, telegram, statisticsText, aiStatusText };

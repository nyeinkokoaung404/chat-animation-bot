# chat-animation-bot

Cloudflare Worker Telegram Business Chat Automation bot. It receives `business_message` updates and answers on behalf of a Telegram Business account using Cloudflare Workers AI.

The assistant prompt and Cloudflare AI request flow are adapted from `Smart-Tool-Bot/functions/modules/robot_handlers.js`.

## Important Telegram limitation

This is not a normal bot chat auto-replier. It uses Telegram's **Business Chatbots** feature. The account owner must have Telegram Business and connect this bot from:

```text
Telegram Settings → Telegram Business → Chatbots → Add Bot
```

The bot must have permission to read and reply to the selected chats. The bot receives updates containing `business_connection_id` and replies with that same ID.

This repository is configured for **owner-only Business connection + AI replies only while the admin is offline**. It serves the dedicated Business account connected to this bot. Customer messages in the owner's selected chats receive an AI reply only when the admin (owner) has not recently sent a message in that chat — while the admin is actively chatting, the AI stays quiet. Owner messages never receive AI replies; any owner message marks the admin as online in that chat.

Commands (`/start`, `/help`, `/stat`, `/products`, `/ai_on`, `/ai_off`, `/ai_status`) work **only in the bot's private chat** — open a direct chat with the bot and use them there. Commands sent in business chats or groups are ignored. The bot does not send proactive messages, does not answer edited messages, and skips messages sent by another business bot.

The Worker does not require a previous in-memory `business_connection` update before answering. This is important because Cloudflare may route a later `business_message` to a fresh isolate. `BUSINESS_CONNECTION_ID` can be set for a strict connection-ID allow-list, but it is optional for a dedicated bot.

Telegram may show `This bot doesn't support Secretary Mode yet` while adding the bot. That is a BotFather capability setting, not a Cloudflare error. Open `@BotFather → Bot Settings → Business Mode` and enable **Secretary Mode**, then reconnect the bot from Telegram Business settings. The code still remains reply-only; enabling Secretary Mode only allows Telegram to establish the Business connection.

## 1. Create the Cloudflare Worker

Install and authenticate Wrangler:

```bash
npm install -g wrangler
wrangler login
wrangler deploy
```

## 2. Set secrets

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET
wrangler secret put OWNER_TELEGRAM_ID
# Optional strict connection allow-list:
# wrangler secret put BUSINESS_CONNECTION_ID
# Optional: minutes the admin counts as "online" after their last message
# in a business chat (default 5):
# wrangler secret put ADMIN_ACTIVE_WINDOW_MINUTES
```

`TELEGRAM_WEBHOOK_SECRET` is optional but recommended. Use a long random value, for example:

```bash
openssl rand -hex 32
```

The Worker uses the native Workers AI binding from `wrangler.toml`. No Cloudflare AI REST token is needed for the normal path.

Set `OWNER_TELEGRAM_ID` to the numeric Telegram ID of the Business account owner. This is required; the Worker fails closed and does not answer any Business connection when it is missing. You may also set `STAT_OWNER_IDS` for additional owner/admin IDs allowed to use `/stat`.

Optional owner allow-list for `/stat`:

```bash
wrangler secret put STAT_OWNER_IDS
```

Use comma-separated Telegram user IDs. The connected Business account owner is also recognized after the Worker receives its `business_connection` update.

## 3. Set the webhook

After deployment, replace the values and run:

```bash
curl -sS -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \\
  -H 'content-type: application/json' \\
  -d '{
    "url": "https://chat-animation-bot.<YOUR_SUBDOMAIN>.workers.dev/webhook",
    "secret_token": "<THE_SAME_WEBHOOK_SECRET>",
    "allowed_updates": [
      "message",
      "business_connection",
      "business_message",
      "edited_business_message",
      "deleted_business_messages"
    ],
    "drop_pending_updates": true
  }'
```

Check it:

```bash
curl -sS "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

## 4. Connect it to Chat Automation

In Telegram, open the business account that should answer messages:

```text
Settings → Telegram Business → Chatbots → Add Bot
```

Select this bot and choose which chats it can access. The bot cannot automatically access all personal chats unless the account owner grants that access through Telegram Business settings.

## 5. Local check

```bash
npx wrangler dev
curl http://localhost:8787/
```

The response should be JSON with `service: chat-animation-bot`.

## Environment variables

| Variable | Type | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Secret | BotFather token |
| `TELEGRAM_WEBHOOK_SECRET` | Secret | Webhook request verification |
| `OWNER_TELEGRAM_ID` | Secret | Numeric Telegram ID of the Business account owner; required for owner-only mode |
| `BUSINESS_CONNECTION_ID` | Optional secret | Strict Telegram Business connection ID allow-list |
| `ADMIN_ACTIVE_WINDOW_MINUTES` | Optional variable | Minutes the admin counts as online after their last message in a business chat; AI stays quiet during this window (default `5`) |
| `STAT_OWNER_IDS` | Optional secret | Comma-separated IDs allowed to use `/stat` |
| `AI_MODEL` | Variable | Defaults to the model used by Smart-Tool-Bot robot handler |
| `CLOUDFLARE_ACCOUNT_ID` | Optional secret | Only for REST fallback |
| `CLOUDFLARE_API_TOKEN` | Optional secret | Only for REST fallback |

## Behavior

- `business_message` with text/caption from a customer → AI reply **only while the admin is offline** (no owner message in that chat within `ADMIN_ACTIVE_WINDOW_MINUTES`, and AI not disabled via `/ai_off`); the reply is sent as a Telegram Rich Message (`sendRichMessage`, Bot API 10.1+ / August 24, 2026 changelog) with a plain-text fallback
- `business_message` from the owner → marks the admin as online in that chat, never gets an AI reply
- Commands in business chats → ignored (commands work only in the bot's private chat)
- Private chat with the bot (`message`, `chat.type: private`):
  - `/start`, `/help` → help text
  - `/products`, `/product`, `/price`, `/catalog` → product catalog as a rich message with a contact button
  - `/ai_on`, `/ai_off` → enable/disable AI auto-replies (owner only)
  - `/ai_status` → AI status and per-chat admin presence (owner only)
  - `/stat` → runtime statistics (owner only)
- Commands in groups or other non-private chats → ignored
- `edited_business_message` → ignored by default to prevent duplicate replies
- `business_connection` → logged without exposing secrets
- Webhook secret is checked when configured
- Webhook returns quickly and runs AI work through `waitUntil`
- root `GET /` reports `mode: admin-offline-ai-rich` and the identity `4 0 4 \\ 2.0 [🇲🇲]`

## Security

Do not commit bot tokens, webhook secrets, Cloudflare API tokens, or private user messages. Review Worker logs carefully because business messages may contain private customer data.

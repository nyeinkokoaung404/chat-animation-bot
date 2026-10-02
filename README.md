# chat-animation-bot

Cloudflare Worker Telegram Business Chat Automation bot. It receives `business_message` updates and answers on behalf of a Telegram Business account using Cloudflare Workers AI.

The assistant prompt and Cloudflare AI request flow are adapted from `Smart-Tool-Bot/functions/modules/robot_handlers.js`.

## Important Telegram limitation

This is not a normal bot chat auto-replier. It uses Telegram's **Business Chatbots** feature. The account owner must have Telegram Business and connect this bot from:

```text
Telegram Settings → Telegram Business → Chatbots → Add Bot
```

The bot must have permission to read and reply to the selected chats. The bot receives updates containing `business_connection_id` and replies with that same ID.

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
```

`TELEGRAM_WEBHOOK_SECRET` is optional but recommended. Use a long random value, for example:

```bash
openssl rand -hex 32
```

The Worker uses the native Workers AI binding from `wrangler.toml`. No Cloudflare AI REST token is needed for the normal path.

## 3. Set the webhook

After deployment, replace the values and run:

```bash
curl -sS -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \\
  -H 'content-type: application/json' \\
  -d '{
    "url": "https://chat-animation-bot.<YOUR_SUBDOMAIN>.workers.dev/webhook",
    "secret_token": "<THE_SAME_WEBHOOK_SECRET>",
    "allowed_updates": [
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
| `AI_MODEL` | Variable | Defaults to the model used by Smart-Tool-Bot robot handler |
| `CLOUDFLARE_ACCOUNT_ID` | Optional secret | Only for REST fallback |
| `CLOUDFLARE_API_TOKEN` | Optional secret | Only for REST fallback |

## Behavior

- `business_message` with text/caption → AI reply
- `/help` → short setup help
- `/stop` or `/disable_ai` → explains how to disconnect from Telegram Business settings
- `edited_business_message` → ignored by default to prevent duplicate replies
- `business_connection` → logged without exposing secrets
- Webhook secret is checked when configured
- Webhook returns quickly and runs AI work through `waitUntil`

## Security

Do not commit bot tokens, webhook secrets, Cloudflare API tokens, or private user messages. Review Worker logs carefully because business messages may contain private customer data.

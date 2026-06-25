# tg-council

Talk to **Claude, GPT, and Gemini in one Telegram chat**, on Cloudflare Workers.

A model replies **only when you address it by name in the second person** —
`gemini, your turn` · `claude, thoughts?` · `go ahead gpt`. Just *mentioning* a
name (`what did gemini say?`) does **not** trigger it. Address several in one
message → each replies once, in order. Everyone shares one transcript (in KV);
when a model is called, the others fold into `user` turns prefixed with a name.

All models go through **one provider — OpenRouter** (one key, OpenAI-compatible).

---

## Setup (one-time)

Run from this folder. Uses Node 22 (`export PATH="$HOME/.local/node-v22.12.0/bin:$PATH"`).

```bash
npm install
```

**1. Telegram bot** — message **@BotFather** → `/newbot` → grab the token.

**2. Cloudflare KV** — create the namespace and paste its id into `wrangler.toml`:
```bash
npx wrangler kv namespace create TRANSCRIPTS
```

**3. Secrets** (never in code):
```bash
npx wrangler secret put TELEGRAM_TOKEN     # paste BotFather token
npx wrangler secret put OPENROUTER_KEY     # paste sk-or-v1-...
```

**4. Deploy:**
```bash
npx wrangler deploy
```
Note the deployed URL, e.g. `https://tg-council.<subdomain>.workers.dev`.

**5. Point Telegram at the Worker** (webhook):
```bash
curl "https://api.telegram.org/bot<TELEGRAM_TOKEN>/setWebhook?url=https://tg-council.<subdomain>.workers.dev"
```

Open the bot in Telegram and say: `claude, say hi`.

---

## Tuning

- **Models / personas** — edit `PERSONAS` in `src/index.ts`. Slugs are OpenRouter
  ids; browse/verify at <https://openrouter.ai/models>. For **near-$0**, some
  models have `:free` variants (e.g. `google/gemini-2.0-flash-exp:free`).
- **Cost control** — `HISTORY_CAP` = how many recent messages each model sees.
- **Trigger logic** — `detectAddressed()` (regex now; swap a classifier in later).
- **Groups** — add the bot to a group and (in BotFather) disable privacy mode so
  it sees all messages.

## Cost

OpenRouter is pay-as-you-go. On the cheap tiers a reply is ~fractions of a cent;
a few dollars of credit lasts a long time for personal use. `:free` model
variants cost nothing (rate-limited).

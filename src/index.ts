// tg-council — talk to Claude / GPT / Gemini in one Telegram chat.
//
// A model replies ONLY when you address it by name in the second person
// ("gemini, your turn" / "claude, thoughts?"). Merely mentioning a name
// ("what did gemini say?") must NOT trigger it. Models never trigger each
// other — only your messages hand out the floor. The whole conversation is a
// single shared transcript (in Workers KV); when a model is called, everyone
// else folds into `user` turns prefixed with their name.
//
// All models go through ONE provider: OpenRouter (one key, OpenAI-compatible).

export interface Env {
  TRANSCRIPTS: KVNamespace;
  TELEGRAM_TOKEN: string;
  OPENROUTER_KEY: string;
}

interface Persona {
  key: string;            // internal id + KV role tag
  name: string;           // display name
  emoji: string;
  aliases: string[];      // lowercase names that can address it
  model: string;          // OpenRouter model slug — verify/adjust at openrouter.ai/models
  tier: "paid" | "free";  // group addressing: "paid" vs "free"
}

// Cheap tiers for minimum spend. Swap a slug to upgrade a persona (e.g. openai/gpt-5.5).
// For near-$0, OpenRouter also offers `:free` variants of some models.
const PERSONAS: Persona[] = [
  // paid (cheap tiers — spend OpenRouter credit, fractions of a cent)
  { key: "gemini", name: "Gemini", emoji: "✨", aliases: ["gemini"],                  model: "google/gemini-2.5-flash", tier: "paid" },
  { key: "gpt",    name: "GPT",    emoji: "🟢", aliases: ["gpt", "chatgpt", "openai"], model: "openai/gpt-5.4-mini", tier: "paid" },
  { key: "claude", name: "Claude", emoji: "🟣", aliases: ["claude"],                   model: "anthropic/claude-haiku-4.5", tier: "paid" },
  { key: "mistral", name: "Mistral", emoji: "🌫️", aliases: ["mistral"],                model: "mistralai/mistral-small-3.2-24b-instruct", tier: "paid" },
  // free (open-source via OpenRouter :free — $0; may occasionally 429 under load)
  { key: "gemma",  name: "Gemma",  emoji: "💎", aliases: ["gemma"],                    model: "google/gemma-4-31b-it:free", tier: "free" },
  { key: "oss",    name: "GPT-OSS", emoji: "🆓", aliases: ["oss", "gptoss", "gpt-oss"], model: "openai/gpt-oss-120b:free", tier: "free" },
];

const HISTORY_CAP = 24;   // how many recent messages each model sees (cost control)
const STORE_CAP = 200;    // how many messages we keep in KV per chat

interface Msg { name: string; personaKey?: string; text: string }

// ---------------------------------------------------------------------------
// Addressing: did you call a model by name, in the second person?
// Start = regex. Structured as one function so a cheap-model classifier can
// drop in later. Triggers on a vocative ("claude, …" / "claude:") OR a name
// sitting within a few words of an invitation cue. A bare mention does NOT.
// ---------------------------------------------------------------------------
const CUES = [
  "your turn", "thoughts", "thought", "go ahead", "go on", "weigh in", "your take",
  "respond", "answer", "reply", "please", "what do you think", "what's your", "whats your",
  "how about you", "you think",
  // ru
  "давай", "ответь", "ответьте", "твоя очередь", "как ты", "что думаешь", "что скажешь", "продолжай",
];

// Group addressing — a word at the start (or as a vocative) calls a whole tier:
//   all → everyone · paid → paid tier · free → free tier
const GROUPS: { aliases: string[]; pick: (p: Persona) => boolean }[] = [
  { aliases: ["all", "everyone", "everybody", "все", "всем", "народ"], pick: () => true },
  { aliases: ["paid", "pro", "premium", "платные", "платным"],         pick: (p) => p.tier === "paid" },
  { aliases: ["free", "freebies", "бесплатные", "бесплатным", "халява"], pick: (p) => p.tier === "free" },
];
function detectGroup(text: string): ((p: Persona) => boolean) | null {
  for (const g of GROUPS) {
    const hit = g.aliases.some((a) => {
      const aa = escapeRe(a);
      return new RegExp(`^\\s*${aa}\\b`, "i").test(text) || new RegExp(`(^|[\\n.!?]\\s*)${aa}\\s*[,:]`, "i").test(text);
    });
    if (hit) return g.pick;
  }
  return null;
}

function detectAddressed(text: string): Persona[] {
  const group = detectGroup(text);
  if (group) return PERSONAS.filter(group); // a whole tier replies, in order
  const hits: { p: Persona; idx: number }[] = [];
  for (const p of PERSONAS) {
    let best = -1;
    for (const alias of p.aliases) {
      const a = escapeRe(alias);
      // lead: name at the very start of the message = direct address ("gpt hi", "gemini - hi")
      const lead = new RegExp(`^\\s*${a}\\b`, "i");
      // vocative: name at a sentence boundary followed by , or :
      const vocative = new RegExp(`(^|[\\n.!?]\\s*)${a}\\s*[,:]`, "i");
      // name within ~3 words of a cue (either order)
      const near = CUES.some((c) => {
        const cc = escapeRe(c);
        const before = new RegExp(`\\b${a}\\b(\\W+\\w+){0,3}\\W+${cc}\\b`, "i");
        const after = new RegExp(`\\b${cc}\\b(\\W+\\w+){0,3}\\W+${a}\\b`, "i");
        return before.test(text) || after.test(text);
      });
      if (lead.test(text) || vocative.test(text) || near) {
        const at = text.toLowerCase().indexOf(alias);
        if (at !== -1 && (best === -1 || at < best)) best = at;
      }
    }
    if (best !== -1) hits.push({ p, idx: best });
  }
  return hits.sort((x, y) => x.idx - y.idx).map((h) => h.p); // each persona once, in order
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Flatten the shared transcript for one persona: it is `assistant`; everyone
// else (you + other bots) becomes `user` turns prefixed with their name.
// ---------------------------------------------------------------------------
interface ChatMsg { role: "user" | "assistant"; content: string }

function buildMessages(history: Msg[], me: Persona): ChatMsg[] {
  const recent = history.slice(-HISTORY_CAP);
  const out: ChatMsg[] = [];
  for (const m of recent) {
    if (m.personaKey === me.key) out.push({ role: "assistant", content: m.text });
    else out.push({ role: "user", content: `${m.name}: ${m.text}` });
  }
  // merge consecutive same-role turns and ensure it starts with a user turn
  const merged: ChatMsg[] = [];
  for (const m of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += "\n" + m.content;
    else merged.push({ ...m });
  }
  while (merged.length && merged[0].role !== "user") merged.shift();
  return merged;
}

function systemFor(p: Persona): string {
  const others = PERSONAS.filter((x) => x.key !== p.key).map((x) => x.name).join(", ");
  return [
    `You are ${p.name}, one of several AI assistants in a shared Telegram chat with a human user` +
      (others ? ` and other AIs (${others})` : "") + `.`,
    `Each message is prefixed with the speaker's name. Reply ONLY as yourself, in your own voice — do not speak for the user or the other assistants.`,
    `Be concise and conversational (this is a chat, not an essay). The user addressed you by name; answer them directly.`,
  ].join(" ");
}

// ---------------------------------------------------------------------------
// OpenRouter (one provider, OpenAI-compatible)
// ---------------------------------------------------------------------------
async function callOpenRouter(key: string, model: string, system: string, messages: ChatMsg[]): Promise<string> {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
      "X-Title": "tg-council",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: system }, ...messages],
      max_tokens: 1024,
    }),
  });
  const j: any = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || JSON.stringify(j));
  return j?.choices?.[0]?.message?.content?.trim() || "(no reply)";
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------
async function sendTelegram(token: string, chatId: number, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true }),
  });
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------
function rosterText(): string {
  const line = (p: Persona) => `${p.emoji} *${p.name}* — \`${p.aliases[0]}\``;
  const paid = PERSONAS.filter((p) => p.tier === "paid").map(line).join("\n");
  const free = PERSONAS.filter((p) => p.tier === "free").map(line).join("\n");
  return `*Paid* (cents):\n${paid}\n\n*Free* ($0):\n${free}`;
}

function helpText(): string {
  return [
    "*Council* — talk to several AIs in one chat.",
    "",
    "Address one by name (2nd person): `claude, hi` · `gpt what do you think?`",
    "Whole tiers: `all …` · `paid …` · `free …`",
    "Just *mentioning* a name (`what did gpt say?`) won't trigger it.",
    "",
    rosterText(),
    "",
    "*Commands:* /who · /reset (clear history) · /help",
  ].join("\n");
}

async function handleCommand(text: string, env: Env, chatId: number, kvKey: string): Promise<void> {
  const cmd = text.slice(1).split(/[\s@]/)[0].toLowerCase();
  if (cmd === "reset") {
    await env.TRANSCRIPTS.delete(kvKey);
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, "🧹 Conversation history cleared.");
    return;
  }
  if (cmd === "who" || cmd === "models") {
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, rosterText());
    return;
  }
  await sendTelegram(env.TELEGRAM_TOKEN, chatId, helpText()); // /start, /help, unknown
}

// ---------------------------------------------------------------------------
// Worker entrypoint — Telegram webhook POSTs land here.
// We ack immediately and do the (slow) LLM work in waitUntil so Telegram
// doesn't retry and double-post.
// ---------------------------------------------------------------------------
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") return new Response("tg-council up");
    let update: any;
    try { update = await request.json(); } catch { return new Response("ok"); }
    ctx.waitUntil(handle(update, env));
    return new Response("ok");
  },
};

async function handle(update: any, env: Env): Promise<void> {
  const msg = update?.message;
  if (!msg?.text || !msg.chat) return;
  const chatId: number = msg.chat.id;
  const kvKey = `chat:${chatId}`;

  if (msg.text.trim().startsWith("/")) { await handleCommand(msg.text.trim(), env, chatId, kvKey); return; }

  const history: Msg[] = JSON.parse((await env.TRANSCRIPTS.get(kvKey)) || "[]");
  const userName = (msg.from?.first_name || "User").replace(/:/g, "");
  history.push({ name: userName, text: msg.text });

  const addressed = detectAddressed(msg.text);
  for (const p of addressed) {
    try {
      const reply = await callOpenRouter(env.OPENROUTER_KEY, p.model, systemFor(p), buildMessages(history, p));
      history.push({ name: p.name, personaKey: p.key, text: reply });
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, `${p.emoji} *${p.name}*\n${reply}`);
    } catch (e) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, `⚠️ ${p.name} error: ${String((e as Error).message).slice(0, 300)}`);
    }
  }

  await env.TRANSCRIPTS.put(kvKey, JSON.stringify(history.slice(-STORE_CAP)));
}

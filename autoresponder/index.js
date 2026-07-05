"use strict";

const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");

// ---- Configuration (all overridable via environment variables) ----
const PORT = parseInt(process.env.PORT || "8769", 10);
const BRIDGE_URL = process.env.WHATSAPP_API_URL || "http://127.0.0.1:8080/api";
const BRIDGE_TOKEN = process.env.WHATSAPP_BRIDGE_TOKEN || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
const MAX_TOKENS = parseInt(process.env.CLAUDE_MAX_TOKENS || "500", 10);
const HISTORY_LIMIT = parseInt(process.env.HISTORY_LIMIT || "20", 10);
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  "Eres el asistente personal de WhatsApp del dueno de este numero. " +
    "Responde de forma breve, natural y en el mismo idioma del mensaje recibido. " +
    "Si no sabes algo con certeza, dilo en vez de inventar.";
// Comma-separated allowlist of chat JIDs (phone@s.whatsapp.net or group JIDs).
// Leave empty to respond to everyone who messages this number (not recommended).
const ALLOWED_CHAT_JIDS = (process.env.ALLOWED_CHAT_JIDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!ANTHROPIC_API_KEY) {
  console.error("[fatal] ANTHROPIC_API_KEY no esta configurada. Abortando.");
  process.exit(1);
}
if (!BRIDGE_TOKEN) {
  console.error("[fatal] WHATSAPP_BRIDGE_TOKEN no esta configurada. Abortando.");
  process.exit(1);
}
if (ALLOWED_CHAT_JIDS.length === 0) {
  console.warn(
    "[warn] ALLOWED_CHAT_JIDS esta vacio: el bot respondera a CUALQUIERA que le escriba. " +
      "Se recomienda configurar una lista blanca."
  );
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// In-memory conversation history per chat. Lost on restart by design (MVP) -
// swap for a real store (SQLite/Redis) if you need persistence.
const histories = new Map();

function getHistory(chatJID) {
  if (!histories.has(chatJID)) histories.set(chatJID, []);
  return histories.get(chatJID);
}

function pushToHistory(chatJID, role, content) {
  const history = getHistory(chatJID);
  history.push({ role, content });
  while (history.length > HISTORY_LIMIT) history.shift();
}

async function sendReply(recipient, message) {
  const res = await fetch(`${BRIDGE_URL}/send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${BRIDGE_TOKEN}`,
    },
    // NOTE: BRIDGE_URL must be a loopback address (127.0.0.1/localhost/::1) -
    // the bridge rejects any other Host header by design (see its auth.go).
    body: JSON.stringify({ recipient, message }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    throw new Error(
      `bridge /send failed: status=${res.status} body=${JSON.stringify(data)}`
    );
  }
  return data;
}

async function generateReply(chatJID, incomingText) {
  pushToHistory(chatJID, "user", incomingText);
  const history = getHistory(chatJID);

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: history,
  });

  const textBlock = response.content.find((block) => block.type === "text");
  const replyText = textBlock ? textBlock.text.trim() : "";

  if (replyText) pushToHistory(chatJID, "assistant", replyText);
  return replyText;
}

const app = express();
app.use(express.json({ limit: "15mb" })); // media payloads can include base64 images

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

app.post("/whatsapp/webhook", async (req, res) => {
  const payload = req.body || {};
  const { sender, content, chatJID, isFromMe, mediaType } = payload;

  if (isFromMe) {
    return res.status(200).json({ skipped: "isFromMe" });
  }

  if (!chatJID) {
    return res.status(400).json({ error: "missing chatJID" });
  }

  if (ALLOWED_CHAT_JIDS.length > 0 && !ALLOWED_CHAT_JIDS.includes(chatJID)) {
    console.log(`[skip] chat no permitido: ${chatJID} (sender=${sender})`);
    return res.status(200).json({ skipped: "not-allowlisted" });
  }

  let incomingText = (content || "").trim();
  if (!incomingText && mediaType) {
    incomingText = `[El usuario envio un archivo adjunto de tipo "${mediaType}" sin texto. Responde reconociendo que lo recibiste, pero aclara que aun no puedes leer el contenido del archivo.]`;
  }
  if (!incomingText) {
    return res.status(200).json({ skipped: "empty-content" });
  }

  try {
    console.log(`[in] ${chatJID} (${sender}): ${incomingText.slice(0, 120)}`);
    const reply = await generateReply(chatJID, incomingText);
    if (reply) {
      await sendReply(chatJID, reply);
      console.log(`[out] ${chatJID}: ${reply.slice(0, 120)}`);
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error(`[error] procesando mensaje de ${chatJID}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[autoresponder] escuchando en puerto ${PORT}`);
  console.log(`[autoresponder] modelo Claude: ${CLAUDE_MODEL}`);
  console.log(
    `[autoresponder] lista blanca: ${
      ALLOWED_CHAT_JIDS.length ? ALLOWED_CHAT_JIDS.join(", ") : "(ninguna - abierto a todos)"
    }`
  );
});

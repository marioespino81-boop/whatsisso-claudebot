"use strict";

const fs = require("fs");
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
// Numero (JID) del dueno del negocio - recibe notificaciones cuando el bot
// deriva una conversacion a un humano. Ej: 5216146826814@s.whatsapp.net
const ADMIN_CHAT_JID = process.env.ADMIN_CHAT_JID || "";

// El system prompt puede venir de un archivo (recomendado para prompts largos
// con formato, como negocio.md) o de la variable SYSTEM_PROMPT (para uno corto).
// El archivo tiene prioridad si existe.
const SYSTEM_PROMPT_FILE = process.env.SYSTEM_PROMPT_FILE || "/app/config/system-prompt.md";
let SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  "Eres el asistente personal de WhatsApp del dueno de este numero. " +
    "Responde de forma breve, natural y en el mismo idioma del mensaje recibido. " +
    "Si no sabes algo con certeza, dilo en vez de inventar.";
try {
  if (fs.existsSync(SYSTEM_PROMPT_FILE)) {
    const fileContent = fs.readFileSync(SYSTEM_PROMPT_FILE, "utf8").trim();
    if (fileContent) {
      SYSTEM_PROMPT = fileContent;
      console.log(
        `[autoresponder] system prompt cargado desde ${SYSTEM_PROMPT_FILE} (${fileContent.length} caracteres)`
      );
    }
  }
} catch (err) {
  console.warn(`[warn] no se pudo leer SYSTEM_PROMPT_FILE (${SYSTEM_PROMPT_FILE}): ${err.message}`);
}

// Comma-separated allowlist of chat JIDs (phone@s.whatsapp.net or group JIDs).
// Leave empty to respond to everyone who messages this number (not recommended).
const ALLOWED_CHAT_JIDS = (process.env.ALLOWED_CHAT_JIDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// NOTE: estas dos variables suelen faltar en el PRIMER arranque (el bridge
// todavia no genero su token, o el usuario aun no puso su API key). Antes
// esto hacia process.exit(1), lo cual mataba tambien al bridge (el
// entrypoint.sh apaga todo el contenedor si un proceso muere) justo antes de
// que alcanzara a imprimir su banner con el token y el QR - un circulo
// vicioso. Ahora solo avisamos y seguimos corriendo; las funciones que los
// necesitan (generateReply/sendReply) fallan con un error claro si se usan
// sin configurar.
if (!ANTHROPIC_API_KEY) {
  console.warn(
    "[warn] ANTHROPIC_API_KEY no esta configurada todavia - el bot no podra generar respuestas hasta que la configures y reinicies."
  );
}
if (!BRIDGE_TOKEN) {
  console.warn(
    "[warn] WHATSAPP_BRIDGE_TOKEN no esta configurada todavia - copia el token que imprime el bridge arriba en estos logs, ponlo en .env y reinicia."
  );
}
if (ALLOWED_CHAT_JIDS.length === 0) {
  console.warn(
    "[warn] ALLOWED_CHAT_JIDS esta vacio: el bot respondera a CUALQUIERA que le escriba. " +
      "Se recomienda configurar una lista blanca."
  );
}
if (!ADMIN_CHAT_JID) {
  console.warn(
    "[warn] ADMIN_CHAT_JID no esta configurado - las derivaciones a humano no se notificaran a nadie, solo se le contestara al cliente."
  );
}

const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

// Tool que el modelo puede "usar" cuando el prompt le indica derivar la
// conversacion a un humano (factura, cliente molesto, comprobante sin numero
// de pedido, etc). Al usarla, notificamos por WhatsApp al ADMIN_CHAT_JID y
// le devolvemos el resultado a Claude para que siga la conversacion y le
// conteste al cliente con el texto que corresponda segun su propio prompt.
const TOOLS = [
  {
    name: "derivarHumano",
    description:
      "Deriva la conversacion actual a un asesor humano porque el bot no puede resolverla (factura, cliente molesto, problema con un pedido, comprobante de pago sin numero de pedido, etc). Notifica al equipo humano por WhatsApp.",
    input_schema: {
      type: "object",
      properties: {
        razon: {
          type: "string",
          description: "Motivo breve y claro de por que se deriva esta conversacion a un humano.",
        },
      },
      required: ["razon"],
    },
  },
];

// In-memory conversation history per chat. Lost on restart by design (MVP) -
// swap for a real store (SQLite/Redis) if you need persistence.
const histories = new Map();

function getHistory(chatJID) {
  if (!histories.has(chatJID)) histories.set(chatJID, []);
  return histories.get(chatJID);
}

function trimHistory(chatJID) {
  const history = getHistory(chatJID);
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

async function notifyAdmin(chatJID, razon) {
  if (!ADMIN_CHAT_JID) {
    console.warn(`[warn] derivarHumano llamado pero ADMIN_CHAT_JID no esta configurado (chat=${chatJID}, razon=${razon})`);
    return;
  }
  const msg = `⚠️ Cliente necesita atencion humana\nChat: ${chatJID}\nMotivo: ${razon}`;
  try {
    await sendReply(ADMIN_CHAT_JID, msg);
    console.log(`[handoff] notificado a ${ADMIN_CHAT_JID} sobre ${chatJID}: ${razon}`);
  } catch (err) {
    console.error(`[error] no se pudo notificar al admin: ${err.message}`);
  }
}

async function generateReply(chatJID, incomingText) {
  if (!anthropic) {
    throw new Error("ANTHROPIC_API_KEY no configurada - no se puede generar respuesta");
  }
  if (!BRIDGE_TOKEN) {
    throw new Error("WHATSAPP_BRIDGE_TOKEN no configurada - no se puede enviar la respuesta");
  }

  const history = getHistory(chatJID);
  history.push({ role: "user", content: incomingText });

  let response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    tools: TOOLS,
    messages: history,
  });

  // Bucle de tool-use: si Claude decide usar derivarHumano, ejecutamos la
  // notificacion real y le devolvemos el resultado para que continue y
  // genere el texto final que se le manda al cliente. Limitamos las
  // vueltas por seguridad (no deberia necesitar mas de una en la practica).
  let rounds = 0;
  while (response.stop_reason === "tool_use" && rounds < 3) {
    rounds++;
    history.push({ role: "assistant", content: response.content });

    const toolResults = [];
    for (const block of response.content) {
      if (block.type === "tool_use" && block.name === "derivarHumano") {
        const razon = (block.input && block.input.razon) || "sin especificar";
        await notifyAdmin(chatJID, razon);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: "Notificacion enviada al equipo humano correctamente.",
        });
      }
    }
    history.push({ role: "user", content: toolResults });

    response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: history,
    });
  }

  const textBlock = response.content.find((block) => block.type === "text");
  const replyText = textBlock ? textBlock.text.trim() : "";

  if (replyText) history.push({ role: "assistant", content: replyText });
  trimHistory(chatJID);
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
    incomingText =
      mediaType === "image"
        ? "[El cliente envió una imagen de referencia]"
        : `[El cliente envio un archivo adjunto de tipo "${mediaType}" sin texto.]`;
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

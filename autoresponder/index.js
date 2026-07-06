"use strict";

const fs = require("fs");
const path = require("path");
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
// Numero (JID) autorizado para mandar comandos /actualizar, /ver, /borrar.
// Por defecto es el mismo que ADMIN_CHAT_JID, pero puede separarse.
const OWNER_CHAT_JID = process.env.OWNER_CHAT_JID || ADMIN_CHAT_JID;

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
  } else {
    console.log(
      `[autoresponder] SYSTEM_PROMPT_FILE (${SYSTEM_PROMPT_FILE}) no existe - usando SYSTEM_PROMPT / prompt por defecto`
    );
  }
} catch (err) {
  console.warn(`[warn] no se pudo leer SYSTEM_PROMPT_FILE (${SYSTEM_PROMPT_FILE}): ${err.message}`);
}

// Recordatorio de formato fijo, siempre se agrega al prompt efectivo para
// evitar que el modelo use doble asterisco (Markdown) en vez del formato
// de negritas real de WhatsApp (un solo asterisco).
const WHATSAPP_FORMAT_REMINDER =
  "\n\n---\nFormato WhatsApp: para negritas usa UN SOLO asterisco (*asi*), nunca doble asterisco (**asi**).";

// ---- Actualizaciones dinamicas (via comandos de WhatsApp del dueno) ----
// Se guardan en el volumen persistente para sobrevivir reinicios/redeploys.
const DYNAMIC_UPDATES_FILE = process.env.DYNAMIC_UPDATES_FILE || "/app/bridge/store/dynamic-updates.md";
const DYNAMIC_UPDATES_MAX_CHARS = parseInt(process.env.DYNAMIC_UPDATES_MAX_CHARS || "6000", 10);

let dynamicUpdates = "";
try {
  if (fs.existsSync(DYNAMIC_UPDATES_FILE)) {
    dynamicUpdates = fs.readFileSync(DYNAMIC_UPDATES_FILE, "utf8");
    if (dynamicUpdates.trim()) {
      console.log(`[autoresponder] actualizaciones dinamicas cargadas (${dynamicUpdates.length} caracteres)`);
    }
  }
} catch (err) {
  console.warn(`[warn] no se pudo leer DYNAMIC_UPDATES_FILE (${DYNAMIC_UPDATES_FILE}): ${err.message}`);
}

function saveDynamicUpdates() {
  try {
    fs.mkdirSync(path.dirname(DYNAMIC_UPDATES_FILE), { recursive: true });
    fs.writeFileSync(DYNAMIC_UPDATES_FILE, dynamicUpdates, "utf8");
  } catch (err) {
    console.error(`[error] no se pudo guardar DYNAMIC_UPDATES_FILE: ${err.message}`);
  }
}

function appendDynamicUpdate(text) {
  const stamp = new Date().toISOString().slice(0, 10);
  dynamicUpdates += `\n\n### Actualizacion ${stamp}\n${text.trim()}`;
  if (dynamicUpdates.length > DYNAMIC_UPDATES_MAX_CHARS) {
    // Conserva solo lo mas reciente si crece demasiado (controla costo de tokens).
    dynamicUpdates = dynamicUpdates.slice(dynamicUpdates.length - DYNAMIC_UPDATES_MAX_CHARS);
  }
  saveDynamicUpdates();
}

function clearDynamicUpdates() {
  dynamicUpdates = "";
  saveDynamicUpdates();
}

function getEffectiveSystemPrompt() {
  let prompt = SYSTEM_PROMPT;
  if (dynamicUpdates.trim()) {
    prompt += `\n\n---\n\n## Actualizaciones recientes (agregadas por el dueno via WhatsApp)\n${dynamicUpdates}`;
  }
  return prompt + WHATSAPP_FORMAT_REMINDER;
}

// Comma-separated allowlist of chat JIDs (phone@s.whatsapp.net or group JIDs).
// Leave empty to respond to everyone who messages this number (not recommended).
const ALLOWED_CHAT_JIDS = (process.env.ALLOWED_CHAT_JIDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Los chats de grupo en WhatsApp siempre tienen JID terminado en "@g.us".
// Por defecto el bot NUNCA responde en grupos (RESPOND_IN_GROUPS=false),
// para evitar que conteste dentro de grupos de clientes/familiares/equipo.
// Si en algun momento se necesita un grupo especifico, se puede poner
// RESPOND_IN_GROUPS=true y controlar el acceso con ALLOWED_CHAT_JIDS.
const RESPOND_IN_GROUPS = (process.env.RESPOND_IN_GROUPS || "false").trim().toLowerCase() === "true";
function isGroupJID(jid) {
  return typeof jid === "string" && jid.endsWith("@g.us");
}

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
if (!OWNER_CHAT_JID) {
  console.warn(
    "[warn] OWNER_CHAT_JID no esta configurado - nadie podra usar los comandos /actualizar, /ver, /borrar."
  );
}

const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

// CAUSA RAIZ del incidente de Estados publicados automaticamente: el bridge
// (whatsmeow) tambien emite como "mensaje entrante" los Estados que publican
// tus contactos (llegan con chatJID = "status@broadcast"), y sin este filtro
// el bot los trataba como si fueran un cliente escribiendole, generaba una
// respuesta con Claude, y la mandaba de vuelta a "status@broadcast" - que en
// WhatsApp/whatsmeow significa "publica esto como tu propio Estado", visible
// para todos tus contactos (por eso lo vio el dueno y sus clientes).
// Esta funcion bloquea CUALQUIER JID de difusion/estado en dos puntos:
// (1) al recibir el webhook (para no generar respuesta ni gastar tokens), y
// (2) dentro de sendReply, como ultima linea de defensa, para que ningun otro
// bug futuro pueda volver a publicar algo como Estado.
function isBroadcastJID(jid) {
  if (!jid || typeof jid !== "string") return false;
  return jid === "status@broadcast" || jid.endsWith("@broadcast") || jid.endsWith("@newsletter");
}

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
  // Ultima linea de defensa: nunca enviar nada a un JID de difusion/estado,
  // pase lo que pase mas arriba en el flujo (ver isBroadcastJID arriba).
  if (isBroadcastJID(recipient)) {
    throw new Error(
      `sendReply bloqueado: intento de enviar a JID de difusion/estado (${recipient}). Esto NO se envia nunca.`
    );
  }
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

  const systemPrompt = getEffectiveSystemPrompt();

  let response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
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
      system: systemPrompt,
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

// ---- Notificaciones de pedidos de WooCommerce ----
// Cuando un pedido cambia de estado en WooCommerce (nuevo, procesando,
// completado, cancelado, etc.) le mandamos un WhatsApp automatico al
// cliente. Esto NO pasa por Claude - son mensajes de plantilla fijos, para
// que la informacion del pedido (numero, productos, total) sea siempre
// exacta y nunca la "invente" el modelo.
const crypto = require("crypto");

// Puerto DEDICADO y SEPARADO del puerto interno 8769. Es el UNICO puerto de
// este servicio pensado para publicarse a internet (para que WooCommerce lo
// pueda llamar). El puerto 8769 (webhook del bridge de WhatsApp) NUNCA debe
// exponerse a internet - solo el bridge le habla por localhost.
const WOOCOMMERCE_PORT = parseInt(process.env.WOOCOMMERCE_PORT || "8790", 10);

// Secreto configurado en WooCommerce (Ajustes > Avanzado > Webhooks > tu
// webhook > "Secreto"). Se usa para verificar la firma HMAC de cada
// solicitud entrante y asegurarnos de que en verdad viene de WooCommerce.
const WC_WEBHOOK_SECRET = process.env.WC_WEBHOOK_SECRET || "";
if (!WC_WEBHOOK_SECRET) {
  console.warn(
    "[warn] WC_WEBHOOK_SECRET no esta configurado - las notificaciones de pedidos de WooCommerce estan DESACTIVADAS por seguridad hasta que lo configures (debe coincidir con el secreto del webhook en WooCommerce)."
  );
}

const WC_ORDER_STATUS_FILE = process.env.WC_ORDER_STATUS_FILE || "/app/bridge/store/wc-order-status.json";
let orderStatusCache = {};
try {
  if (fs.existsSync(WC_ORDER_STATUS_FILE)) {
    orderStatusCache = JSON.parse(fs.readFileSync(WC_ORDER_STATUS_FILE, "utf8"));
  }
} catch (err) {
  console.warn(`[warn] no se pudo leer WC_ORDER_STATUS_FILE: ${err.message}`);
}
function saveOrderStatusCache() {
  try {
    fs.mkdirSync(path.dirname(WC_ORDER_STATUS_FILE), { recursive: true });
    fs.writeFileSync(WC_ORDER_STATUS_FILE, JSON.stringify(orderStatusCache), "utf8");
  } catch (err) {
    console.error(`[error] no se pudo guardar WC_ORDER_STATUS_FILE: ${err.message}`);
  }
}

// Convierte un telefono de WooCommerce (formato libre: "6141385204",
// "614 138 5204", "+52 614 138 5204", etc.) al JID de WhatsApp. Especifico
// para numeros mexicanos: WhatsApp exige un "1" extra despues del "52".
function phoneToWhatsAppJID(rawPhone) {
  let digits = (rawPhone || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) {
    // Numero local de 10 digitos -> asumimos Mexico, agregamos 52 + 1.
    digits = "521" + digits;
  } else if (digits.length === 12 && digits.startsWith("52")) {
    // 52 + 10 digitos, falta el "1" que exige WhatsApp.
    digits = "521" + digits.slice(2);
  }
  // Si ya viene con 13 digitos empezando en "521", se usa tal cual.
  return `${digits}@s.whatsapp.net`;
}

function formatMoney(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n.toFixed(2) : String(value || "0");
}

function buildOrderSummary(order) {
  const items = Array.isArray(order.line_items)
    ? order.line_items.map((li) => `• ${li.quantity}x ${li.name}`).join("\n")
    : "";
  const shippingLine =
    Array.isArray(order.shipping_lines) && order.shipping_lines.length > 0
      ? order.shipping_lines[0].method_title || "Envio"
      : "Recoleccion en tienda";
  return { items, total: formatMoney(order.total), shipping: shippingLine };
}

const ORDER_STATUS_TEMPLATES = {
  pending: (o, s) =>
    `Recibimos tu pedido *#${o.number || o.id}* 💜\n${s.items}\nTotal: $${s.total} MXN\nEnvio: ${s.shipping}\nEsta pendiente de confirmacion de pago.`,
  processing: (o, s) =>
    `¡Tu pedido *#${o.number || o.id}* ya esta en preparacion! 🖨️💜\n${s.items}\nTotal: $${s.total} MXN\nEnvio: ${s.shipping}\nTe avisamos en cuanto este listo ✨`,
  "on-hold": (o, s) =>
    `Tu pedido *#${o.number || o.id}* esta en espera ⏳💜 (normalmente por confirmacion de pago). En cuanto se confirme, seguimos con tu pedido.`,
  completed: (o, s) =>
    `¡Tu pedido *#${o.number || o.id}* ya esta listo! 🎉💜\n${s.items}\nTotal: $${s.total} MXN\nEnvio: ${s.shipping}\n¡Gracias por tu compra! 🥰`,
  cancelled: (o, s) => `Tu pedido *#${o.number || o.id}* fue cancelado 💔. Si crees que es un error, escribenos.`,
  refunded: (o, s) => `Tu pedido *#${o.number || o.id}* fue reembolsado 💜. Cualquier duda, aqui andamos.`,
  failed: (o, s) =>
    `Hubo un problema con el pago de tu pedido *#${o.number || o.id}* 😕. Puedes intentar de nuevo o escribenos si necesitas ayuda.`,
};

function buildOrderMessage(order) {
  const summary = buildOrderSummary(order);
  const template = ORDER_STATUS_TEMPLATES[order.status];
  if (template) return template(order, summary);
  // Estado no reconocido (personalizado en WooCommerce) - mensaje generico.
  return `Tu pedido *#${order.number || order.id}* cambio de estado a: ${order.status} 💜`;
}

function verifyWooSignature(req) {
  if (!WC_WEBHOOK_SECRET) return false;
  const signature = req.get("x-wc-webhook-signature");
  if (!signature || !req.rawBody) return false;
  try {
    const computed = crypto.createHmac("sha256", WC_WEBHOOK_SECRET).update(req.rawBody).digest("base64");
    const a = Buffer.from(signature);
    const b = Buffer.from(computed);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (err) {
    return false;
  }
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

  // BLOQUEO DE SEGURIDAD: nunca procesar ni contestar Estados/difusiones.
  // Ver la explicacion completa junto a isBroadcastJID() mas arriba.
  if (isBroadcastJID(chatJID)) {
    console.log(`[skip] mensaje de difusion/estado ignorado: ${chatJID} (sender=${sender})`);
    return res.status(200).json({ skipped: "broadcast-or-status" });
  }

  // El bot no contesta en grupos salvo que se active explicitamente con
  // RESPOND_IN_GROUPS=true (ver definicion de isGroupJID arriba).
  if (!RESPOND_IN_GROUPS && isGroupJID(chatJID)) {
    console.log(`[skip] mensaje de grupo ignorado (IA desactivada para grupos): ${chatJID} (sender=${sender})`);
    return res.status(200).json({ skipped: "group-disabled" });
  }

  const trimmedContent = (content || "").trim();

  // ---- Comandos del dueno (solo desde OWNER_CHAT_JID) ----
  // Permiten agregar/ver/borrar informacion de negocio sin tocar codigo ni
  // servidor. Se revisan ANTES de la lista blanca de clientes, para que
  // funcionen incluso si el dueno no esta en ALLOWED_CHAT_JIDS.
  if (OWNER_CHAT_JID && chatJID === OWNER_CHAT_JID) {
    const lower = trimmedContent.toLowerCase();

    if (lower.startsWith("/actualizar")) {
      const info = trimmedContent.slice("/actualizar".length).trim();
      if (info) {
        appendDynamicUpdate(info);
        console.log(`[owner] /actualizar: ${info.slice(0, 120)}`);
        await sendReply(chatJID, "✅ Informacion agregada. El bot ya la va a usar en las conversaciones con clientes.");
      } else {
        await sendReply(chatJID, "Usa: /actualizar <texto a agregar>\nEj: /actualizar Nueva promo: envio gratis en pedidos arriba de $1000 MXN durante julio.");
      }
      return res.status(200).json({ ok: true, command: "actualizar" });
    }

    if (lower === "/ver") {
      const body = dynamicUpdates.trim() || "(sin actualizaciones todavia)";
      await sendReply(chatJID, `📋 Actualizaciones actuales:\n${body}`);
      return res.status(200).json({ ok: true, command: "ver" });
    }

    if (lower === "/borrar") {
      clearDynamicUpdates();
      console.log("[owner] /borrar: actualizaciones dinamicas borradas");
      await sendReply(chatJID, "🗑️ Actualizaciones borradas. El bot vuelve a usar solo el prompt base.");
      return res.status(200).json({ ok: true, command: "borrar" });
    }

    if (lower === "/ayuda" || lower === "/help") {
      await sendReply(
        chatJID,
        "Comandos disponibles:\n" +
          "/actualizar <texto> - agrega info nueva (promos, cambios de precio, etc)\n" +
          "/ver - muestra las actualizaciones actuales\n" +
          "/borrar - borra todas las actualizaciones"
      );
      return res.status(200).json({ ok: true, command: "ayuda" });
    }
    // Si no es un comando reconocido, sigue el flujo normal - el dueno
    // tambien puede platicar con el bot para probarlo (si su numero esta
    // en ALLOWED_CHAT_JIDS).
  }

  if (ALLOWED_CHAT_JIDS.length > 0 && !ALLOWED_CHAT_JIDS.includes(chatJID)) {
    console.log(`[skip] chat no permitido: ${chatJID} (sender=${sender})`);
    return res.status(200).json({ skipped: "not-allowlisted" });
  }

  let incomingText = trimmedContent;
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

// ---- Servidor SEPARADO para el webhook de WooCommerce ----
// A proposito usa su propio puerto/app de Express, distinto de PORT (8769).
// Asi, cuando se publique un puerto a internet para que WooCommerce pueda
// llamarlo, NUNCA se expone por accidente /whatsapp/webhook (que solo debe
// hablar con el bridge por localhost).
const wcApp = express();
wcApp.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf; // necesario para verificar la firma HMAC exacta
    },
  })
);

wcApp.post("/woocommerce/webhook", async (req, res) => {
  if (!WC_WEBHOOK_SECRET) {
    return res.status(503).json({ error: "WC_WEBHOOK_SECRET no configurado" });
  }
  if (!verifyWooSignature(req)) {
    console.warn("[wc] firma invalida - solicitud rechazada");
    return res.status(401).json({ error: "invalid signature" });
  }

  const order = req.body || {};
  if (!order.id) {
    // Probablemente el "ping" de prueba que manda WooCommerce al crear el webhook.
    return res.status(200).json({ ok: true, note: "sin id de pedido, ignorado" });
  }

  const lastStatus = orderStatusCache[order.id];
  if (lastStatus === order.status) {
    // Evita reenviar el mismo mensaje cuando WooCommerce dispara el webhook
    // por ediciones del pedido que no son un cambio de estado real.
    return res.status(200).json({ ok: true, skipped: "same-status" });
  }

  const jid = phoneToWhatsAppJID(order.billing && order.billing.phone);
  if (!jid) {
    console.warn(`[wc] pedido #${order.id} sin telefono valido - no se pudo notificar`);
    orderStatusCache[order.id] = order.status;
    saveOrderStatusCache();
    return res.status(200).json({ ok: true, skipped: "no-phone" });
  }

  try {
    const message = buildOrderMessage(order);
    await sendReply(jid, message);
    orderStatusCache[order.id] = order.status;
    saveOrderStatusCache();
    console.log(`[wc] pedido #${order.id} (${order.status}) -> notificado a ${jid}`);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error(`[wc] error notificando pedido #${order.id}: ${err.message}`);
    // No actualizamos el cache de estado para que, si WooCommerce reintenta
    // la entrega del webhook, se vuelva a intentar mandar el mensaje.
    res.status(500).json({ error: err.message });
  }
});

wcApp.listen(WOOCOMMERCE_PORT, "0.0.0.0", () => {
  console.log(`[woocommerce] webhook escuchando en puerto ${WOOCOMMERCE_PORT}`);
  console.log(`[woocommerce] secreto configurado: ${WC_WEBHOOK_SECRET ? "si" : "NO (webhook desactivado)"}`);
});

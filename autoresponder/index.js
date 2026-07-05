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
    "[warn] ADMIN_CHAT_JID no esta configurado - las derivaciones a humano

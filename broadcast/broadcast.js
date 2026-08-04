// Script de envio masivo para la Lista Morada.
// Se ejecuta a mano (no corre solo) via:
//   docker exec -it whatsapp-claude-bot node /app/broadcast/broadcast.js 120
//
// - Lee broadcast/contacts.json (lista limpia, sin duplicados)
// - Lee broadcast/mensaje.txt (usa {{nombre}} para personalizar)
// - Se salta a quien ya este en broadcast/progreso.json (ya enviado)
// - Manda hasta <cantidad> mensajes en esta corrida (default 120)
// - Pausa aleatoria entre cada envio para no verse como spam
// - Guarda progreso despues de CADA envio exitoso (si se interrumpe, no se
//   duplica nada la proxima vez que se corra)

const fs = require("fs");
const path = require("path");

const BRIDGE_URL = process.env.WHATSAPP_API_URL || "http://127.0.0.1:8080/api";
const BRIDGE_TOKEN = process.env.WHATSAPP_BRIDGE_TOKEN || "";

const DIR = __dirname;
const CONTACTS_FILE = path.join(DIR, "contacts.json");
const MESSAGE_FILE = path.join(DIR, "mensaje.txt");
const PROGRESS_FILE = path.join(DIR, "progreso.json");
const ERRORS_FILE = path.join(DIR, "errores.json");

// Pausa aleatoria entre mensajes: entre MIN y MAX segundos.
const MIN_DELAY_SEC = parseInt(process.env.BROADCAST_MIN_DELAY_SEC || "25", 10);
const MAX_DELAY_SEC = parseInt(process.env.BROADCAST_MAX_DELAY_SEC || "50", 10);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelayMs() {
  const sec = MIN_DELAY_SEC + Math.random() * (MAX_DELAY_SEC - MIN_DELAY_SEC);
  return Math.round(sec * 1000);
}

function loadJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function primerNombre(nombreCompleto) {
  const limpio = (nombreCompleto || "").trim();
  if (!limpio) return "";
  // Toma solo la primera palabra y la capitaliza bonito (evita "MARIO ESPINO PAYAN" completo en mayusculas).
  const primera = limpio.split(/\s+/)[0];
  return primera.charAt(0).toUpperCase() + primera.slice(1).toLowerCase();
}

async function sendMessage(jid, message) {
  const res = await fetch(`${BRIDGE_URL}/send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${BRIDGE_TOKEN}`,
    },
    body: JSON.stringify({ recipient: jid, message }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    throw new Error(`status=${res.status} body=${JSON.stringify(data)}`);
  }
  return data;
}

async function main() {
  const limite = parseInt(process.argv[2] || "120", 10);

  if (!BRIDGE_TOKEN) {
    console.error("[error] WHATSAPP_BRIDGE_TOKEN no esta configurada en el entorno de este contenedor.");
    process.exit(1);
  }
  if (!fs.existsSync(CONTACTS_FILE)) {
    console.error(`[error] no encuentro ${CONTACTS_FILE}`);
    process.exit(1);
  }
  if (!fs.existsSync(MESSAGE_FILE)) {
    console.error(`[error] no encuentro ${MESSAGE_FILE} - crea ese archivo con el texto a enviar (usa {{nombre}}).`);
    process.exit(1);
  }

  const contacts = loadJSON(CONTACTS_FILE, []);
  const template = fs.readFileSync(MESSAGE_FILE, "utf8");
  const progreso = loadJSON(PROGRESS_FILE, {}); // jid -> timestamp ISO de envio exitoso
  const errores = loadJSON(ERRORS_FILE, {}); // jid -> ultimo error

  const pendientes = contacts.filter((c) => !progreso[c.jid]);
  console.log(`[broadcast] total contactos: ${contacts.length}`);
  console.log(`[broadcast] ya enviados antes: ${contacts.length - pendientes.length}`);
  console.log(`[broadcast] pendientes: ${pendientes.length}`);
  console.log(`[broadcast] esta corrida mandara hasta: ${limite}`);

  const tanda = pendientes.slice(0, limite);
  let enviados = 0;
  let fallidos = 0;

  for (const contacto of tanda) {
    const mensaje = template.replace(/\{\{nombre\}\}/g, primerNombre(contacto.nombre));
    try {
      await sendMessage(contacto.jid, mensaje);
      progreso[contacto.jid] = new Date().toISOString();
      saveJSON(PROGRESS_FILE, progreso);
      delete errores[contacto.jid];
      enviados++;
      console.log(`[ok] ${contacto.nombre} (${contacto.jid}) - ${enviados}/${tanda.length}`);
    } catch (err) {
      errores[contacto.jid] = { nombre: contacto.nombre, error: err.message, fecha: new Date().toISOString() };
      saveJSON(ERRORS_FILE, errores);
      fallidos++;
      console.error(`[error] ${contacto.nombre} (${contacto.jid}): ${err.message}`);
    }

    // Pausa antes del siguiente (incluso despues del ultimo no importa, pero lo evitamos).
    if (contacto !== tanda[tanda.length - 1]) {
      const delay = randomDelayMs();
      await sleep(delay);
    }
  }

  console.log("");
  console.log(`[broadcast] listo. enviados: ${enviados}, fallidos: ${fallidos}`);
  console.log(`[broadcast] quedan pendientes: ${pendientes.length - tanda.length}`);
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});

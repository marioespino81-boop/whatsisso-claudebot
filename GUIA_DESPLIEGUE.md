# Guia de despliegue: WhatsApp + Claude en tu VPS (EasyPanel)

Este proyecto conecta tu WhatsApp personal (como dispositivo vinculado) a
Claude para que responda automaticamente a los mensajes que te lleguen.

Arquitectura: un solo contenedor con dos procesos:

- **Bridge** (Go/whatsmeow): habla con WhatsApp, guarda mensajes en SQLite,
  expone una API REST local y reenvia cada mensaje entrante a un webhook.
- **Autoresponder** (Node): recibe ese webhook, le pregunta a Claude que
  responder, y se lo manda de vuelta al bridge para que lo envie.

## 0. Requisitos

- Tu VPS con EasyPanel y **acceso SSH** (ya confirmado, puerto 22022 en tu caso).
- Una **API key de Anthropic** (console.anthropic.com/settings/keys). Esto es
  distinto de tu suscripcion Claude Pro/Max: aqui se factura por token.
- Tu numero de WhatsApp personal, libre para vincularse como dispositivo
  adicional.
- Una cuenta de GitHub (para que Actions compile la imagen por ti - tu VPS
  tiene poca RAM libre y no conviene compilar Go ahi mismo).

## 1. Agregar swap al VPS (colchon de seguridad) - YA HECHO

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

## 2. Publicar la imagen con GitHub Actions - YA HECHO

Repo: https://github.com/marioespino81-boop/whatsisso-claudebot
Imagen: ghcr.io/marioespino81-boop/whatsisso-claudebot:latest

**Visibilidad del paquete:** por defecto GHCR publica el paquete como
privado. Dos opciones:

- **Mas simple:** en GitHub ve a tu perfil > Packages > el paquete > Package
  settings > cambia visibilidad a **Public**. Asi el VPS no necesita login.
- **Mas privado:** deja el paquete privado y en el VPS haz login una vez:

```bash
  # crea un token en https://github.com/settings/tokens con scope read:packages
  echo <TU_TOKEN> | docker login ghcr.io -u marioespino81-boop --password-stdin
```

## 3. Desplegar en el VPS (solo descarga, nunca compila)

Por SSH (puerto 22022), en el VPS:

```bash
git clone https://github.com/marioespino81-boop/whatsisso-claudebot.git whatsapp-claude-bot
cd whatsapp-claude-bot
cp .env.example .env
```

Edita `.env` y como minimo rellena `ANTHROPIC_API_KEY`. Deja
`WHATSAPP_BRIDGE_TOKEN` vacio por ahora (se genera solo).

```bash
docker compose pull
docker compose up -d
```

## 4. Primer arranque: capturar el token del bridge

```bash
docker logs -f whatsapp-claude-bot
```

Copia el token del banner, pegalo como `WHATSAPP_BRIDGE_TOKEN` en tu `.env`,
y reinicia: `docker compose up -d`.

## 5. Vincular tu WhatsApp

Sigue viendo los logs. El bridge imprime un codigo QR en texto. En tu telefono:

1. WhatsApp > Configuracion > Dispositivos vinculados > Vincular un dispositivo
2. Escanea el codigo QR que aparece en la terminal

## 6. Configurar a quien responde el bot

Limita `ALLOWED_CHAT_JIDS` en tu `.env` a tu propio numero para probar:

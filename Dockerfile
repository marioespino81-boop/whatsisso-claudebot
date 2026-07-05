# ---- Stage 1: compile the Go WhatsApp bridge (whatsmeow) ----
FROM golang:1.25-bookworm AS bridge-builder

WORKDIR /src
RUN git clone --depth 1 https://github.com/verygoodplugins/whatsapp-mcp.git .
WORKDIR /src/whatsapp-bridge
# CGO is required by go-sqlite3
RUN CGO_ENABLED=1 go build -o /out/whatsapp-bridge .

# ---- Stage 2: final runtime image (bridge + Node auto-responder) ----
FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Compiled Go bridge binary
COPY --from=bridge-builder /out/whatsapp-bridge /app/bridge/whatsapp-bridge

# Node auto-responder service
COPY autoresponder/package.json /app/autoresponder/package.json
RUN cd /app/autoresponder && npm install --omit=dev

COPY autoresponder/index.js /app/autoresponder/index.js
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh /app/bridge/whatsapp-bridge

# Persistent state: WhatsApp session auth + message history (SQLite) + bridge token
VOLUME ["/app/bridge/store"]

# Nothing needs to be reachable from outside the container - bridge (8080)
# and auto-responder (8769) only talk to each other over localhost.
EXPOSE 8080 8769

ENTRYPOINT ["/app/entrypoint.sh"]

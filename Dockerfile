FROM node:20-bookworm-slim

WORKDIR /usr/src/app

# ---------------------------------------------------------------------------
# Shared-secret for the HTTP API. Prefer setting WHATSAPP_SERVICE_TOKEN as a
# Railway environment variable; this ENV line is only a fallback for platforms
# where env injection misbehaves. Override at runtime with `-e` (Docker) or
# Railway service variables (which take precedence over ENV).
# ---------------------------------------------------------------------------
ENV WHATSAPP_SERVICE_TOKEN=8vdFXlda_S0wPS_X2R7Na5CrciT4hvcxmkIcv0-al00wLbI4N9QkFRSSetO8EnTc

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /usr/src/app/.wa_auth

EXPOSE 3001

CMD ["node", "index.js"]

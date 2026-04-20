FROM node:20-bookworm-slim

WORKDIR /usr/src/app

# Install only what Baileys needs: nothing beyond Node. No Chromium, no apt pain.
# We still need ca-certificates for outbound TLS, which node:20-slim already has.

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Create auth dir for WhatsApp session
RUN mkdir -p /usr/src/app/.wa_auth

EXPOSE 3001

CMD ["node", "index.js"]

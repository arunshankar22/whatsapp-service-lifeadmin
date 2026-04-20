# Use Puppeteer's official image — Chromium + all system deps pre-installed.
# This avoids the apt-install mess that Railpack hits with whatsapp-web.js.
FROM ghcr.io/puppeteer/puppeteer:22.15.0

# The puppeteer image runs as non-root user `pptruser`. Work inside its home.
WORKDIR /usr/src/app

# Skip downloading another Chromium — the image already ships with one that
# Puppeteer auto-discovers. Do NOT set PUPPETEER_EXECUTABLE_PATH.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_SKIP_DOWNLOAD=true \
    NODE_ENV=production

# Copy manifests first for better layer caching.
COPY --chown=pptruser:pptruser package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy the rest of the code.
COPY --chown=pptruser:pptruser . .

# Railway injects PORT dynamically; this is just documentation.
EXPOSE 3001

CMD ["node", "index.js"]

FROM node:20-bookworm-slim

# Install Chromium + the libs Puppeteer needs. We use system Chromium instead of
# letting puppeteer download one, since whatsapp-web.js's nested puppeteer-core
# otherwise pins a Chrome version that mismatches the Puppeteer Docker image.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    libnss3 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libgbm1 \
    libglib2.0-0 \
    libnspr4 \
    libpango-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    wget \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Tell puppeteer to use the system chromium; don't download a separate copy.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /usr/src/app

# Install deps first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source.
COPY . .

# Create a non-root user and own the app dir (Chromium refuses to run as root).
RUN groupadd -r wa && useradd -r -g wa -G audio,video wa \
    && mkdir -p /usr/src/app/.wwebjs_auth /usr/src/app/.wwebjs_cache \
    && chown -R wa:wa /usr/src/app

USER wa

EXPOSE 3001

CMD ["node", "index.js"]

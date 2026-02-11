# Multi-stage build: Node.js orchestrator + Python inference bridge
# Designed for deployment on Phala Cloud Intel TDX CVMs.

# --- Stage 1: Build TypeScript orchestrator ---
FROM node:22-slim AS orchestrator-build

# Install build tools for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends build-essential python3 && rm -rf /var/lib/apt/lists/*

WORKDIR /build/protocol
COPY platform-protocol/package.json platform-protocol/tsconfig.json ./
COPY platform-protocol/src ./src
RUN npm install && npm run build

WORKDIR /build/orchestrator
COPY cvm-images/agent-cvm/orchestrator/package.json cvm-images/agent-cvm/orchestrator/tsconfig.json ./
# Rewrite protocol dep to point to local build
RUN node -e "const p=JSON.parse(require('fs').readFileSync('package.json','utf8'));p.dependencies['@luciaclaw/protocol']='file:/build/protocol';require('fs').writeFileSync('package.json',JSON.stringify(p,null,2))"
RUN npm install
COPY cvm-images/agent-cvm/orchestrator/src ./src
RUN npm run build

# --- Stage 2: Runtime ---
FROM node:22-slim AS runtime

# Install Python for inference bridge + build tools for native modules + Chromium system deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv build-essential \
    libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libatspi2.0-0 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2 libwayland-client0 \
    && rm -rf /var/lib/apt/lists/*

# Copy orchestrator
WORKDIR /app/orchestrator
COPY --from=orchestrator-build /build/protocol /app/protocol
COPY --from=orchestrator-build /build/orchestrator /app/orchestrator

# Install Chromium for browser automation tools
RUN cd /app/orchestrator && npx playwright-core install chromium

# Set up Python inference bridge
WORKDIR /app/inference-bridge
COPY cvm-images/agent-cvm/inference-bridge/requirements.txt .
RUN python3 -m venv /app/venv && /app/venv/bin/pip install --no-cache-dir -r requirements.txt
COPY cvm-images/agent-cvm/inference-bridge/src ./src

# Create data directory for SQLite
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

# Entry script
WORKDIR /app
COPY cvm-images/agent-cvm/entrypoint.sh .
RUN chmod +x entrypoint.sh

EXPOSE 8080 8000

ENTRYPOINT ["/app/entrypoint.sh"]

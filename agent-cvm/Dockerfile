# Multi-stage build: Node.js orchestrator + Python inference bridge
# Designed for deployment on Phala Cloud Intel TDX CVMs.

# --- Stage 1: Build TypeScript orchestrator ---
FROM node:22-slim AS orchestrator-build

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

# Install Python for inference bridge
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip python3-venv && rm -rf /var/lib/apt/lists/*

# Copy orchestrator
WORKDIR /app/orchestrator
COPY --from=orchestrator-build /build/protocol /app/protocol
COPY --from=orchestrator-build /build/orchestrator /app/orchestrator

# Set up Python inference bridge
WORKDIR /app/inference-bridge
COPY cvm-images/agent-cvm/inference-bridge/requirements.txt .
RUN python3 -m venv /app/venv && /app/venv/bin/pip install --no-cache-dir -r requirements.txt
COPY cvm-images/agent-cvm/inference-bridge/src ./src

# Entry script
WORKDIR /app
COPY cvm-images/agent-cvm/entrypoint.sh .
RUN chmod +x entrypoint.sh

EXPOSE 8080 8000

ENTRYPOINT ["/app/entrypoint.sh"]

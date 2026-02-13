#!/bin/bash
# Build and deploy Lucia Agent CVM to Phala Cloud.
# Usage: ./deploy.sh [tag]
# Example: ./deploy.sh v0.2.0

set -euo pipefail

TAG="${1:-v0.2.0}"
IMAGE="ghcr.io/luciaclaw/lucia-agent:${TAG}"
CVM_NAME="luciaclaw2"

echo "=== Lucia Agent CVM Deploy ==="
echo "Tag:   ${TAG}"
echo "Image: ${IMAGE}"
echo "CVM:   ${CVM_NAME}"
echo ""

# Build from monorepo root (need platform-protocol + cvm-images)
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

echo "[1/4] Building Docker image..."
docker build \
  -t "${IMAGE}" \
  -t "ghcr.io/luciaclaw/lucia-agent:latest" \
  -f "${REPO_ROOT}/cvm-images/agent-cvm/Dockerfile" \
  "${REPO_ROOT}"

echo "[2/4] Pushing to GHCR..."
docker push "${IMAGE}"
docker push "ghcr.io/luciaclaw/lucia-agent:latest"

echo "[3/4] Deploying to Phala Cloud..."
cd "$(dirname "$0")"
phala deploy \
  --cvm-id "${CVM_NAME}" \
  --compose docker-compose.yml \
  -e .env.production \
  --wait

echo "[4/4] Checking deployment..."
phala ps "${CVM_NAME}"
phala logs lucia-agent --cvm-id "${CVM_NAME}" --tail 20

echo ""
echo "=== Deploy complete ==="
echo "CVM endpoint: https://73d15d007beccbbaccfba1e2ff800c5f7026e432-8080.dstack-pha-prod9.phala.network"

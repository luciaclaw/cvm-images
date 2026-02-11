"""
Configuration for the LLM inference bridge.
"""

import os


# LLM backend configuration
# Default: Phala Confidential AI API (all models run in GPU TEE)
# For local dev with Ollama: set LLM_BACKEND_URL=http://localhost:11434/v1
LLM_BACKEND_URL = os.environ.get("LLM_BACKEND_URL", "https://api.redpill.ai/v1")
LLM_API_KEY = os.environ.get("LLM_API_KEY", "")
MODEL_NAME = os.environ.get("MODEL_NAME", "deepseek/deepseek-chat-v3-0324")

# Server config
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("INFERENCE_PORT", "8000"))

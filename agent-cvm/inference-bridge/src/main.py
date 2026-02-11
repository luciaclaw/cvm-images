"""
Lucia Inference Bridge — FastAPI server providing OpenAI-compatible API.

Proxies requests to the LLM backend (Ollama for dev, Phala GPU TEE for prod).
The orchestrator calls this service at http://localhost:8000/v1/chat/completions.
"""

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .inference import chat_completion, stream_chat_completion, list_models
from .config import HOST, PORT, MODEL_NAME

app = FastAPI(title="Lucia Inference Bridge", version="0.1.0")


class Message(BaseModel):
    role: str
    content: str


class ChatCompletionRequest(BaseModel):
    messages: list[Message]
    model: str | None = None
    temperature: float = 0.7
    max_tokens: int = 2048
    stream: bool = False


@app.get("/health")
async def health():
    return {"status": "ok", "service": "inference-bridge"}


@app.get("/v1/models")
async def get_models():
    """Fetch available models from the LLM backend and return them."""
    try:
        models = await list_models()
        return {"data": models, "default_model": MODEL_NAME}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to fetch models: {str(e)}")


@app.post("/v1/chat/completions")
async def create_chat_completion(request: ChatCompletionRequest):
    messages = [{"role": m.role, "content": m.content} for m in request.messages]

    try:
        if request.stream:
            return StreamingResponse(
                _stream_response(messages, request.model, request.temperature, request.max_tokens),
                media_type="text/event-stream",
            )

        result = await chat_completion(
            messages=messages,
            model=request.model,
            temperature=request.temperature,
            max_tokens=request.max_tokens,
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"LLM backend error: {str(e)}")


async def _stream_response(messages, model, temperature, max_tokens):
    async for chunk in stream_chat_completion(messages, model, temperature, max_tokens):
        yield f"data: {chunk}\n\n"
    yield "data: [DONE]\n\n"


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=HOST, port=PORT)

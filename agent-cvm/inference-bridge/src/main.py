"""
Lucia Inference Bridge — FastAPI server providing OpenAI-compatible API.

Proxies requests to the LLM backend (Ollama for dev, Phala GPU TEE for prod).
The orchestrator calls this service at http://localhost:8000/v1/chat/completions.
"""

from typing import Any, Literal, Union
import base64

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .inference import chat_completion, stream_chat_completion, list_models, audio_transcription
from . import config
from .config import HOST, PORT

app = FastAPI(title="Lucia Inference Bridge", version="0.1.0")


class ToolCallFunction(BaseModel):
    name: str
    arguments: str


class ToolCall(BaseModel):
    id: str
    type: str = "function"
    function: ToolCallFunction


class Message(BaseModel):
    role: str
    content: str
    tool_call_id: str | None = None
    tool_calls: list[ToolCall] | None = None


class ToolFunction(BaseModel):
    name: str
    description: str
    parameters: dict[str, Any] = {}


class ToolDefinition(BaseModel):
    type: str = "function"
    function: ToolFunction


class ChatCompletionRequest(BaseModel):
    messages: list[Message]
    model: str | None = None
    temperature: float = 0.7
    max_tokens: int = 2048
    stream: bool = False
    tools: list[ToolDefinition] | None = None
    tool_choice: str | None = None


# --- Vision (multimodal) models ---

class TextContent(BaseModel):
    type: Literal["text"]
    text: str


class ImageUrl(BaseModel):
    url: str


class ImageContent(BaseModel):
    type: Literal["image_url"]
    image_url: ImageUrl


class VisionMessage(BaseModel):
    role: str
    content: list[Union[TextContent, ImageContent]]


class VisionCompletionRequest(BaseModel):
    messages: list[VisionMessage]
    model: str | None = None
    temperature: float = 0.3
    max_tokens: int = 2048


@app.get("/health")
async def health():
    return {"status": "ok", "service": "inference-bridge"}


class InternalConfigUpdate(BaseModel):
    llm_api_key: str | None = None
    llm_backend_url: str | None = None
    model_name: str | None = None


@app.post("/internal/config")
async def update_config(body: InternalConfigUpdate, request: Request):
    """
    Update LLM backend configuration at runtime.

    Only reachable from localhost — the orchestrator calls this when the user
    sets llm_backend credentials via the PWA settings UI.
    """
    client_host = request.client.host if request.client else None
    if client_host not in ("127.0.0.1", "::1", "localhost"):
        raise HTTPException(status_code=403, detail="Only localhost access allowed")

    updated = []
    if body.llm_api_key is not None:
        config.LLM_API_KEY = body.llm_api_key
        updated.append("LLM_API_KEY")
    if body.llm_backend_url is not None:
        config.LLM_BACKEND_URL = body.llm_backend_url
        updated.append("LLM_BACKEND_URL")
    if body.model_name is not None:
        config.MODEL_NAME = body.model_name
        updated.append("MODEL_NAME")

    return {"status": "ok", "updated": updated}


@app.get("/v1/models")
async def get_models():
    """Fetch available models from the LLM backend and return them."""
    try:
        models = await list_models()
        return {"data": models, "default_model": config.MODEL_NAME}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to fetch models: {str(e)}")


@app.post("/v1/chat/completions")
async def create_chat_completion(request: ChatCompletionRequest):
    messages = []
    for m in request.messages:
        msg: dict[str, Any] = {"role": m.role, "content": m.content}
        if m.tool_call_id:
            msg["tool_call_id"] = m.tool_call_id
        if m.tool_calls:
            msg["tool_calls"] = [tc.model_dump() for tc in m.tool_calls]
        messages.append(msg)

    tools = None
    if request.tools:
        tools = [t.model_dump() for t in request.tools]

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
            tools=tools,
            tool_choice=request.tool_choice,
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"LLM backend error: {str(e)}")


async def _stream_response(messages, model, temperature, max_tokens):
    async for chunk in stream_chat_completion(messages, model, temperature, max_tokens):
        yield f"data: {chunk}\n\n"
    yield "data: [DONE]\n\n"


@app.post("/v1/vision/completions")
async def create_vision_completion(request: VisionCompletionRequest):
    """Multimodal vision completion — accepts text + image_url content parts."""
    messages = []
    for m in request.messages:
        parts = []
        for part in m.content:
            if part.type == "text":
                parts.append({"type": "text", "text": part.text})
            elif part.type == "image_url":
                parts.append({"type": "image_url", "image_url": {"url": part.image_url.url}})
        messages.append({"role": m.role, "content": parts})

    try:
        result = await chat_completion(
            messages=messages,
            model=request.model,
            temperature=request.temperature,
            max_tokens=request.max_tokens,
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Vision LLM backend error: {str(e)}")


@app.post("/v1/audio/transcriptions")
async def create_audio_transcription(
    file: UploadFile = File(...),
    model: str = Form(default="whisper-small-v3-turbo"),
    language: str | None = Form(default=None),
    response_format: str = Form(default="json"),
):
    """
    Transcribe audio using Whisper-compatible API.

    Accepts multipart file upload (OpenAI Whisper API format).
    Proxies to the LLM backend's audio transcription endpoint.
    """
    try:
        audio_data = await file.read()
        result = await audio_transcription(
            audio_data=audio_data,
            filename=file.filename or "audio.ogg",
            model=model,
            language=language,
            response_format=response_format,
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Transcription error: {str(e)}")


class Base64TranscriptionRequest(BaseModel):
    """Accept audio as base64-encoded data (convenient for orchestrator)."""
    audio_data: str  # base64-encoded audio
    filename: str = "audio.ogg"
    model: str | None = None
    language: str | None = None


@app.post("/v1/audio/transcriptions/base64")
async def create_audio_transcription_base64(request: Base64TranscriptionRequest):
    """
    Transcribe base64-encoded audio.

    Convenience endpoint for the orchestrator — avoids multipart form encoding.
    """
    try:
        audio_bytes = base64.b64decode(request.audio_data)
        result = await audio_transcription(
            audio_data=audio_bytes,
            filename=request.filename,
            model=request.model,
            language=request.language,
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Transcription error: {str(e)}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=HOST, port=PORT)

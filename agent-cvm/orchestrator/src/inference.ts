/**
 * Inference bridge client — calls the Python FastAPI inference service.
 *
 * Uses OpenAI-compatible chat completions API format.
 * Default backend: Phala Confidential AI API (https://api.redpill.ai/v1).
 */

const INFERENCE_URL = process.env.INFERENCE_URL || 'http://localhost:8000';

interface InferenceMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
}

interface ToolCallResponse {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: ToolCallResponse[];
    };
    finish_reason: string;
  }>;
  model?: string;
}

interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface ModelsResponse {
  data: Array<{
    id: string;
    object: string;
    created: number;
    owned_by: string;
    name?: string;
    context_length?: number;
    pricing?: {
      prompt?: string;
      completion?: string;
    };
  }>;
  default_model: string;
}

/** Current model selection (per-session, can be changed by user) */
let currentModel = process.env.MODEL_NAME || 'z-ai/glm-5';

export function getCurrentModel(): string {
  return currentModel;
}

export function setCurrentModel(model: string): void {
  currentModel = model;
}

export async function fetchModels(): Promise<ModelsResponse> {
  const response = await fetch(`${INFERENCE_URL}/v1/models`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Inference bridge returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

export interface InferenceResult {
  content: string;
  model: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  finishReason: string;
}

// --- Vision inference ---

const VISION_MODEL = 'qwen/qwen3-vl-30b-a3b-instruct';

export type VisionContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface VisionMessage {
  role: 'user' | 'system';
  content: VisionContentPart[];
}

export interface VisionResult {
  content: string;
  model: string;
}

export async function callVisionInference(
  imageSource: string,
  prompt: string,
): Promise<VisionResult> {
  const messages: VisionMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: imageSource } },
        { type: 'text', text: prompt },
      ],
    },
  ];

  const response = await fetch(`${INFERENCE_URL}/v1/vision/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      model: VISION_MODEL,
      temperature: 0.3,
      max_tokens: 2048,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    throw new Error(`Vision inference returned ${response.status}: ${await response.text()}`);
  }

  const data: ChatCompletionResponse = await response.json();
  const choice = data.choices[0];

  return {
    content: choice?.message?.content || '',
    model: data.model || VISION_MODEL,
  };
}

// --- Audio transcription (STT) ---

export interface TranscriptionResult {
  text: string;
  language?: string;
  duration?: number;
}

export async function callTranscription(
  audioData: string, // base64-encoded audio
  filename?: string,
  model?: string,
  language?: string,
): Promise<TranscriptionResult> {
  const response = await fetch(`${INFERENCE_URL}/v1/audio/transcriptions/base64`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      audio_data: audioData,
      filename: filename || 'audio.ogg',
      model: model || undefined,
      language: language || undefined,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    throw new Error(`Transcription returned ${response.status}: ${await response.text()}`);
  }

  const data = await response.json() as any;
  return {
    text: data.text || '',
    language: data.language,
    duration: data.duration,
  };
}

// --- Chat inference ---

export async function callInference(
  messages: InferenceMessage[],
  model?: string,
  tools?: ToolDefinition[],
): Promise<InferenceResult> {
  const useModel = model || currentModel;
  const body: Record<string, unknown> = {
    messages,
    model: useModel,
    temperature: 0.7,
    max_tokens: 2048,
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const response = await fetch(`${INFERENCE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    throw new Error(`Inference bridge returned ${response.status}: ${await response.text()}`);
  }

  const data: ChatCompletionResponse = await response.json();
  const choice = data.choices[0];
  const message = choice?.message;

  const result: InferenceResult = {
    content: message?.content || '',
    model: data.model || useModel,
    finishReason: choice?.finish_reason || 'stop',
  };

  if (message?.tool_calls && message.tool_calls.length > 0) {
    result.toolCalls = message.tool_calls.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments || '{}'),
    }));
  }

  return result;
}

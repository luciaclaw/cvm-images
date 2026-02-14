/**
 * Inference bridge client — calls the Python FastAPI inference service.
 *
 * Uses OpenAI-compatible chat completions API format.
 * Default backend: Phala Confidential AI API (https://api.redpill.ai/v1).
 */

import { getModelForRole } from './model-registry.js';

const INFERENCE_URL = process.env.INFERENCE_URL || 'http://localhost:8000';

interface InferenceMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCallResponse[];
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
      reasoning_content?: string | null;
      tool_calls?: ToolCallResponse[];
    };
    finish_reason: string;
  }>;
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
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
let currentModel = process.env.MODEL_NAME || 'openai/gpt-oss-120b';

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
  promptTokens?: number;
  completionTokens?: number;
  /** Raw reasoning steps from reasoning models (e.g. Kimi K2.5) */
  reasoningContent?: string;
}

// --- Vision inference ---

const VISION_MODEL = getModelForRole('vision');

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
  reasoningContent?: string;
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
  const visionContent = choice?.message?.content || choice?.message?.reasoning_content || '';
  const visionReasoning = choice?.message?.reasoning_content || undefined;

  return {
    content: visionContent,
    model: data.model || VISION_MODEL,
    reasoningContent: visionReasoning,
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

  // Some models (e.g. GLM-5) put text in reasoning_content instead of content
  const textContent = message?.content || message?.reasoning_content || '';
  const reasoningContent = message?.reasoning_content || undefined;

  const result: InferenceResult = {
    content: textContent,
    model: data.model || useModel,
    finishReason: choice?.finish_reason || 'stop',
    promptTokens: data.usage?.prompt_tokens,
    completionTokens: data.usage?.completion_tokens,
    reasoningContent,
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

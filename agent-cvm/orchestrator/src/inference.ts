/**
 * Inference bridge client — calls the Python FastAPI inference service.
 *
 * Uses OpenAI-compatible chat completions API format.
 * Default backend: Phala Confidential AI API (https://api.redpill.ai/v1).
 */

const INFERENCE_URL = process.env.INFERENCE_URL || 'http://localhost:8000';

interface InferenceMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      role: string;
      content: string;
    };
  }>;
  model?: string;
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
let currentModel = process.env.MODEL_NAME || 'moonshotai/kimi-k2.5';

export function getCurrentModel(): string {
  return currentModel;
}

export function setCurrentModel(model: string): void {
  currentModel = model;
}

export async function fetchModels(): Promise<ModelsResponse> {
  const response = await fetch(`${INFERENCE_URL}/v1/models`);
  if (!response.ok) {
    throw new Error(`Inference bridge returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

export async function callInference(
  messages: InferenceMessage[],
  model?: string,
): Promise<{ content: string; model: string }> {
  const useModel = model || currentModel;
  const response = await fetch(`${INFERENCE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      model: useModel,
      temperature: 0.7,
      max_tokens: 2048,
    }),
  });

  if (!response.ok) {
    throw new Error(`Inference bridge returned ${response.status}: ${await response.text()}`);
  }

  const data: ChatCompletionResponse = await response.json();
  return {
    content: data.choices[0]?.message?.content || '',
    model: data.model || useModel,
  };
}

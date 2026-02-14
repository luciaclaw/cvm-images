/**
 * Model registry — central configuration for all LLM models.
 *
 * Replaces scattered model constants with a single source of truth.
 * Pricing is per 1M tokens in USD.
 */

export type ModelRole = 'default' | 'reasoning' | 'uncensored' | 'coding' | 'vision';

export interface ModelConfig {
  /** Model identifier (e.g., "openai/gpt-oss-120b") */
  id: string;
  /** Role this model serves */
  role: ModelRole;
  /** Human-readable name */
  name: string;
  /** Model provider */
  provider: string;
  /** Maximum context window in tokens */
  contextLength: number;
  /** Pricing per 1M input tokens in USD */
  inputPricePerMillion: number;
  /** Pricing per 1M output tokens in USD */
  outputPricePerMillion: number;
  /** Whether the model supports tool/function calling */
  supportsTools: boolean;
  /** Whether the model runs inside a TEE */
  tee: boolean;
}

const MODEL_REGISTRY: Record<ModelRole, ModelConfig> = {
  default: {
    id: 'openai/gpt-oss-120b',
    role: 'default',
    name: 'GPT-OSS 120B',
    provider: 'openai',
    contextLength: 131072,
    inputPricePerMillion: 0.15,
    outputPricePerMillion: 0.60,
    supportsTools: true,
    tee: true,
  },
  reasoning: {
    id: 'moonshotai/kimi-k2.5',
    role: 'reasoning',
    name: 'Kimi K2.5',
    provider: 'moonshotai',
    contextLength: 131072,
    inputPricePerMillion: 0.20,
    outputPricePerMillion: 0.60,
    supportsTools: true,
    tee: true,
  },
  uncensored: {
    id: 'phala/uncensored-24b',
    role: 'uncensored',
    name: 'Uncensored 24B',
    provider: 'phala',
    contextLength: 32768,
    inputPricePerMillion: 0.10,
    outputPricePerMillion: 0.30,
    supportsTools: false,
    tee: true,
  },
  coding: {
    id: 'anthropic/claude-opus-4.6',
    role: 'coding',
    name: 'Claude Opus 4.6',
    provider: 'anthropic',
    contextLength: 200000,
    inputPricePerMillion: 15.00,
    outputPricePerMillion: 75.00,
    supportsTools: true,
    tee: false,
  },
  vision: {
    id: 'qwen/qwen3-vl-30b-a3b-instruct',
    role: 'vision',
    name: 'Qwen3 VL 30B',
    provider: 'qwen',
    contextLength: 32768,
    inputPricePerMillion: 0.20,
    outputPricePerMillion: 0.60,
    supportsTools: false,
    tee: true,
  },
};

/** Get the full configuration for a model role */
export function getModelConfig(role: ModelRole): ModelConfig {
  return MODEL_REGISTRY[role];
}

/** Get the model ID string for a role */
export function getModelForRole(role: ModelRole): string {
  return MODEL_REGISTRY[role].id;
}

/** Get all model configurations */
export function getAllModelConfigs(): ModelConfig[] {
  return Object.values(MODEL_REGISTRY);
}

/** Look up a model config by its ID string, returns undefined if not found */
export function getModelConfigById(modelId: string): ModelConfig | undefined {
  return Object.values(MODEL_REGISTRY).find((m) => m.id === modelId);
}

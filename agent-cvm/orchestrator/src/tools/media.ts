/**
 * AI media generation tools — image and music via Kie.ai API.
 *
 * Image: Nano Banana Pro (Google Gemini 3 Pro Image)
 * - Native 4K, physics-accurate lighting, multi-language text rendering
 * - ~$0.09/image (1K–2K), ~$0.12/image (4K)
 *
 * Music: Suno V5
 * - Text-to-music with vocals + instrumentals
 * - Coherent progressions, high-fidelity audio
 *
 * Both services use the same Kie.ai API key stored in the CVM secrets vault.
 */

import { registerTool } from '../tool-registry.js';
import { getServiceCredential } from '../vault.js';

const KIE_API = 'https://api.kie.ai/v1';

async function kieFetch(path: string, body: Record<string, unknown>): Promise<any> {
  const apiKey = await getServiceCredential('kie');
  if (!apiKey) throw new Error('Kie.ai not connected. Please add your API key in Settings.');

  const response = await fetch(`${KIE_API}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const data = await response.json() as any;
  if (!response.ok) {
    throw new Error(`Kie.ai API error (${response.status}): ${data.error?.message || data.message || 'Unknown error'}`);
  }

  return data;
}

async function kieGetTask(taskId: string): Promise<any> {
  const apiKey = await getServiceCredential('kie');
  if (!apiKey) throw new Error('Kie.ai not connected.');

  const response = await fetch(`${KIE_API}/tasks/${taskId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  const data = await response.json() as any;
  if (!response.ok) {
    throw new Error(`Kie.ai task error (${response.status}): ${data.error?.message || 'Unknown error'}`);
  }

  return data;
}

/**
 * Poll a Kie.ai task until completion or timeout.
 */
async function pollTask(taskId: string, maxWaitMs: number = 120_000): Promise<any> {
  const start = Date.now();
  const pollInterval = 3000;

  while (Date.now() - start < maxWaitMs) {
    const task = await kieGetTask(taskId);

    if (task.status === 'completed' || task.status === 'succeeded') {
      return task;
    }
    if (task.status === 'failed' || task.status === 'error') {
      throw new Error(`Task failed: ${task.error || 'Unknown error'}`);
    }

    await new Promise((r) => setTimeout(r, pollInterval));
  }

  throw new Error(`Task ${taskId} timed out after ${maxWaitMs}ms`);
}

export function registerMediaTools(): void {
  // ─── Image Generation ──────────────────────────────────────────

  registerTool({
    name: 'image.generate',
    description:
      'Generate an image from a text prompt using Nano Banana Pro (Gemini 3 Pro Image) via Kie.ai. ' +
      'Supports native 4K output, physics-accurate lighting, character consistency, and text rendering. ' +
      'Returns a URL to the generated image.',
    parameters: {
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: 'Detailed image description / generation prompt' },
        negative_prompt: { type: 'string', description: 'What to avoid in the image (e.g. "blurry, low quality")' },
        width: { type: 'number', description: 'Image width in pixels (default: 1024, max: 4096)' },
        height: { type: 'number', description: 'Image height in pixels (default: 1024, max: 4096)' },
        num_images: { type: 'number', description: 'Number of images to generate (1-4, default: 1)' },
        style: { type: 'string', description: 'Art style hint (e.g. "photorealistic", "anime", "oil painting", "digital art")' },
      },
    },
    requiredCredentials: ['kie'],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const { prompt, negative_prompt, width, height, num_images, style } = args as {
        prompt: string;
        negative_prompt?: string;
        width?: number;
        height?: number;
        num_images?: number;
        style?: string;
      };

      const body: Record<string, unknown> = {
        model: 'nano-banana-pro',
        prompt: style ? `${style} style: ${prompt}` : prompt,
        width: width || 1024,
        height: height || 1024,
        num_images: Math.min(num_images || 1, 4),
      };
      if (negative_prompt) body.negative_prompt = negative_prompt;

      const result = await kieFetch('/images/generate', body);

      // If async (task-based), poll for result
      if (result.task_id) {
        const task = await pollTask(result.task_id);
        return {
          images: task.output?.images || task.images || [],
          taskId: result.task_id,
        };
      }

      return {
        images: result.images || result.output?.images || [{ url: result.url }],
      };
    },
  });

  registerTool({
    name: 'image.edit',
    description:
      'Edit an existing image using AI. Provide an image URL and instructions for how to modify it. ' +
      'Supports inpainting, style transfer, background replacement, and more.',
    parameters: {
      type: 'object',
      required: ['image_url', 'prompt'],
      properties: {
        image_url: { type: 'string', description: 'URL of the image to edit' },
        prompt: { type: 'string', description: 'Instructions for how to edit the image' },
        mask_url: { type: 'string', description: 'Optional mask URL (white = edit area, for inpainting)' },
        strength: { type: 'number', description: 'Edit strength (0.0-1.0, default: 0.7). Higher = more change.' },
      },
    },
    requiredCredentials: ['kie'],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const { image_url, prompt, mask_url, strength } = args as {
        image_url: string;
        prompt: string;
        mask_url?: string;
        strength?: number;
      };

      const body: Record<string, unknown> = {
        model: 'nano-banana-pro',
        image_url,
        prompt,
        strength: strength ?? 0.7,
      };
      if (mask_url) body.mask_url = mask_url;

      const result = await kieFetch('/images/edit', body);

      if (result.task_id) {
        const task = await pollTask(result.task_id);
        return {
          images: task.output?.images || task.images || [],
          taskId: result.task_id,
        };
      }

      return {
        images: result.images || [{ url: result.url }],
      };
    },
  });

  registerTool({
    name: 'image.upscale',
    description: 'Upscale an image to higher resolution (up to 4K) using AI super-resolution.',
    parameters: {
      type: 'object',
      required: ['image_url'],
      properties: {
        image_url: { type: 'string', description: 'URL of the image to upscale' },
        scale: { type: 'number', description: 'Upscale factor (2 or 4, default: 2)' },
      },
    },
    requiredCredentials: ['kie'],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const { image_url, scale } = args as { image_url: string; scale?: number };

      const result = await kieFetch('/images/upscale', {
        image_url,
        scale: scale || 2,
      });

      if (result.task_id) {
        const task = await pollTask(result.task_id);
        return {
          image: task.output?.image || task.image,
          taskId: result.task_id,
        };
      }

      return { image: result.image || { url: result.url } };
    },
  });

  // ─── Music Generation ──────────────────────────────────────────

  registerTool({
    name: 'music.generate',
    description:
      'Generate a song or music track using Suno V5 via Kie.ai. ' +
      'Supports text-to-music with vocals and instrumentals. ' +
      'Returns a URL to the generated audio file.',
    parameters: {
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: {
          type: 'string',
          description: 'Description of the music to generate (genre, mood, tempo, instruments, etc.)',
        },
        lyrics: {
          type: 'string',
          description: 'Custom lyrics for vocal tracks. Leave empty for instrumental only.',
        },
        genre: {
          type: 'string',
          description: 'Music genre (e.g. "pop", "jazz", "electronic", "classical", "hip-hop")',
        },
        mood: {
          type: 'string',
          description: 'Mood/emotion (e.g. "upbeat", "melancholic", "energetic", "calm")',
        },
        duration_seconds: {
          type: 'number',
          description: 'Target duration in seconds (default: 30, max: 240)',
        },
        instrumental: {
          type: 'boolean',
          description: 'Generate instrumental only, no vocals (default: false)',
        },
      },
    },
    requiredCredentials: ['kie'],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const { prompt, lyrics, genre, mood, duration_seconds, instrumental } = args as {
        prompt: string;
        lyrics?: string;
        genre?: string;
        mood?: string;
        duration_seconds?: number;
        instrumental?: boolean;
      };

      const body: Record<string, unknown> = {
        model: 'suno-v5',
        prompt,
        duration_seconds: Math.min(duration_seconds || 30, 240),
        instrumental: instrumental || false,
      };
      if (lyrics) body.lyrics = lyrics;
      if (genre) body.genre = genre;
      if (mood) body.mood = mood;

      const result = await kieFetch('/music/generate', body);

      if (result.task_id) {
        const task = await pollTask(result.task_id, 180_000); // Music can take longer
        return {
          tracks: task.output?.tracks || task.tracks || [],
          taskId: result.task_id,
        };
      }

      return {
        tracks: result.tracks || [{ url: result.url, title: result.title }],
      };
    },
  });

  registerTool({
    name: 'music.extend',
    description:
      'Extend an existing music track with additional content. ' +
      'Continues the style and theme of the original.',
    parameters: {
      type: 'object',
      required: ['track_url'],
      properties: {
        track_url: { type: 'string', description: 'URL of the track to extend' },
        prompt: { type: 'string', description: 'Optional instructions for the extension' },
        additional_seconds: { type: 'number', description: 'Seconds to add (default: 30, max: 120)' },
      },
    },
    requiredCredentials: ['kie'],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const { track_url, prompt, additional_seconds } = args as {
        track_url: string;
        prompt?: string;
        additional_seconds?: number;
      };

      const body: Record<string, unknown> = {
        model: 'suno-v5',
        track_url,
        additional_seconds: Math.min(additional_seconds || 30, 120),
      };
      if (prompt) body.prompt = prompt;

      const result = await kieFetch('/music/extend', body);

      if (result.task_id) {
        const task = await pollTask(result.task_id, 180_000);
        return {
          track: task.output?.track || task.track,
          taskId: result.task_id,
        };
      }

      return { track: result.track || { url: result.url } };
    },
  });

  registerTool({
    name: 'music.remix',
    description:
      'Remix an existing track with a new style, genre, or mood. ' +
      'Transforms the original while keeping recognizable elements.',
    parameters: {
      type: 'object',
      required: ['track_url', 'prompt'],
      properties: {
        track_url: { type: 'string', description: 'URL of the track to remix' },
        prompt: { type: 'string', description: 'Instructions for the remix (target style, genre, mood)' },
        strength: { type: 'number', description: 'Remix strength (0.0-1.0, default: 0.5). Higher = more different.' },
      },
    },
    requiredCredentials: ['kie'],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const { track_url, prompt, strength } = args as {
        track_url: string;
        prompt: string;
        strength?: number;
      };

      const result = await kieFetch('/music/remix', {
        model: 'suno-v5',
        track_url,
        prompt,
        strength: strength ?? 0.5,
      });

      if (result.task_id) {
        const task = await pollTask(result.task_id, 180_000);
        return {
          track: task.output?.track || task.track,
          taskId: result.task_id,
        };
      }

      return { track: result.track || { url: result.url } };
    },
  });
}

export const _testExports = { kieFetch, kieGetTask, pollTask };

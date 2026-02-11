/**
 * Vision tool — analyze images using a multimodal LLM inside the TEE.
 *
 * Uses qwen/qwen3-vl-30b-a3b-instruct via the inference bridge.
 * No external credentials required — uses built-in TEE inference.
 */

import { registerTool } from '../tool-registry.js';
import { callVisionInference } from '../inference.js';

/** Maximum image size for base64 data URIs (10 MB) */
const MAX_DATA_URI_BYTES = 10 * 1024 * 1024;

function validateImageSource(image: string): void {
  if (image.startsWith('data:')) {
    // Validate data URI format: data:<mime>;base64,<data>
    if (!/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(image)) {
      throw new Error('Invalid data URI. Expected format: data:image/<type>;base64,<data>');
    }
    // Check approximate decoded size (base64 is ~4/3 of original)
    const base64Part = image.split(',')[1];
    if (base64Part && base64Part.length * 0.75 > MAX_DATA_URI_BYTES) {
      throw new Error('Image exceeds 10 MB size limit.');
    }
  } else if (image.startsWith('https://')) {
    // HTTPS URLs are accepted as-is
  } else if (image.startsWith('http://')) {
    throw new Error('Only HTTPS URLs are supported for security. Use https:// instead.');
  } else {
    throw new Error('Image must be an HTTPS URL or a base64 data URI (data:image/...).');
  }
}

export function registerVisionTools(): void {
  registerTool({
    name: 'vision.analyze',
    description:
      'Analyze an image using a vision model. Accepts an HTTPS image URL or base64 data URI. Returns a text description or analysis based on the prompt.',
    parameters: {
      type: 'object',
      required: ['image', 'prompt'],
      properties: {
        image: {
          type: 'string',
          description: 'Image source: HTTPS URL (e.g., https://example.com/photo.jpg) or base64 data URI (data:image/png;base64,...)',
        },
        prompt: {
          type: 'string',
          description: 'What to analyze or describe about the image',
        },
      },
    },
    requiredCredentials: [],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const { image, prompt } = args as { image: string; prompt: string };

      validateImageSource(image);

      const result = await callVisionInference(image, prompt);

      return { analysis: result.content, model: result.model };
    },
  });
}

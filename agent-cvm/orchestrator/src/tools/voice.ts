/**
 * Voice/STT tools — transcribe audio from any channel.
 *
 * Unified STT service that accepts audio from:
 * - PWA voice input (MediaRecorder API → base64)
 * - Telegram voice messages (Bot API getFile → download → transcribe)
 * - WhatsApp voice notes (Business API media download → transcribe)
 * - Discord/Slack audio clips
 *
 * Default model: Whisper Small V3 Turbo (low-latency on CPU TEE).
 */

import { registerTool } from '../tool-registry.js';
import { callTranscription } from '../inference.js';
import { getServiceCredential } from '../vault.js';

const TELEGRAM_API = 'https://api.telegram.org';

/**
 * Download a file from a URL and return base64-encoded data.
 */
async function downloadToBase64(url: string, headers?: Record<string, string>): Promise<string> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}): ${response.statusText}`);
  }
  const buffer = await response.arrayBuffer();
  return Buffer.from(buffer).toString('base64');
}

/**
 * Download a Telegram file by file_id via Bot API.
 */
export async function downloadTelegramFile(fileId: string): Promise<{ base64: string; filename: string }> {
  const token = await getServiceCredential('telegram');
  if (!token) throw new Error('Telegram not connected. Cannot download voice message.');

  // Get file path from Telegram
  const fileInfoRes = await fetch(`${TELEGRAM_API}/bot${token}/getFile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  });
  const fileInfo = await fileInfoRes.json() as any;
  if (!fileInfo.ok) {
    throw new Error(`Telegram getFile error: ${fileInfo.description}`);
  }

  const filePath = fileInfo.result.file_path;
  const downloadUrl = `${TELEGRAM_API}/file/bot${token}/${filePath}`;
  const base64 = await downloadToBase64(downloadUrl);
  const filename = filePath.split('/').pop() || 'voice.ogg';

  return { base64, filename };
}

/**
 * Download a WhatsApp media file by media_id via Cloud API.
 */
async function downloadWhatsappMedia(mediaId: string): Promise<{ base64: string; filename: string }> {
  const token = await getServiceCredential('whatsapp');
  if (!token) throw new Error('WhatsApp not connected. Cannot download voice note.');

  // Get media URL from WhatsApp Cloud API
  const mediaRes = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const mediaInfo = await mediaRes.json() as any;
  if (mediaInfo.error) {
    throw new Error(`WhatsApp media error: ${mediaInfo.error.message}`);
  }

  const base64 = await downloadToBase64(mediaInfo.url, {
    Authorization: `Bearer ${token}`,
  });
  const filename = mediaInfo.mime_type?.includes('ogg') ? 'voice.ogg' : 'voice.mp4';

  return { base64, filename };
}

export function registerVoiceTools(): void {
  registerTool({
    name: 'voice.transcribe',
    description:
      'Transcribe audio to text using Whisper STT. ' +
      'Accepts base64-encoded audio data directly, or a source reference ' +
      '(telegram_file_id, whatsapp_media_id) to download and transcribe. ' +
      'Supports formats: ogg/opus, mp3, mp4, m4a, wav, webm.',
    parameters: {
      type: 'object',
      properties: {
        audio_data: {
          type: 'string',
          description: 'Base64-encoded audio data (for direct audio input from PWA or other sources)',
        },
        source: {
          type: 'string',
          enum: ['direct', 'telegram', 'whatsapp'],
          description: 'Audio source type (default: "direct")',
        },
        file_id: {
          type: 'string',
          description: 'Platform-specific file/media ID (for telegram or whatsapp sources)',
        },
        language: {
          type: 'string',
          description: 'ISO 639-1 language code hint (e.g. "en", "de", "es"). Auto-detected if omitted.',
        },
        model: {
          type: 'string',
          description: 'Whisper model to use (default: whisper-small-v3-turbo). Use "whisper-large-v3" for higher accuracy.',
        },
        filename: {
          type: 'string',
          description: 'Original filename (helps with format detection)',
        },
      },
    },
    requiredCredentials: [],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const { audio_data, source, file_id, language, model, filename } = args as {
        audio_data?: string;
        source?: string;
        file_id?: string;
        language?: string;
        model?: string;
        filename?: string;
      };

      let base64Audio: string;
      let audioFilename: string;

      const audioSource = source || 'direct';

      if (audioSource === 'telegram') {
        if (!file_id) throw new Error('file_id is required for telegram source');
        const result = await downloadTelegramFile(file_id);
        base64Audio = result.base64;
        audioFilename = result.filename;
      } else if (audioSource === 'whatsapp') {
        if (!file_id) throw new Error('file_id is required for whatsapp source');
        const result = await downloadWhatsappMedia(file_id);
        base64Audio = result.base64;
        audioFilename = result.filename;
      } else {
        if (!audio_data) throw new Error('audio_data is required for direct source');
        base64Audio = audio_data;
        audioFilename = filename || 'audio.ogg';
      }

      const result = await callTranscription(base64Audio, audioFilename, model, language);

      return {
        text: result.text,
        language: result.language,
        duration: result.duration,
        source: audioSource,
      };
    },
  });
}

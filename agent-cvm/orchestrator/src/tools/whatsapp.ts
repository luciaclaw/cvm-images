/**
 * WhatsApp Business API tool implementations — send messages, templates, read profile.
 *
 * Uses Meta's WhatsApp Cloud API (Graph API v21.0).
 * Requires: access token via credential store, phone_number_id in env or args.
 *
 * WhatsApp Business rules:
 * - To initiate a conversation, you must send a pre-approved template message.
 * - Once a user replies, you have a 24h customer service window for free-form messages.
 * - Text messages outside the window will fail unless a template is used.
 */

import { registerTool } from '../tool-registry.js';
import { getServiceCredential } from '../vault.js';

const GRAPH_API = 'https://graph.facebook.com/v21.0';

/** Default phone number ID from env (can be overridden per-call) */
function getPhoneNumberId(): string | undefined {
  return process.env.WHATSAPP_PHONE_NUMBER_ID;
}

async function whatsappFetch(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<any> {
  const token = await getServiceCredential('whatsapp');
  if (!token) throw new Error('WhatsApp not connected. Please add your access token in Settings.');

  const response = await fetch(`${GRAPH_API}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const data = await response.json() as any;
  if (!response.ok) {
    const errMsg = data.error?.message || data.error?.error_user_msg || 'Unknown error';
    throw new Error(`WhatsApp API error (${response.status}): ${errMsg}`);
  }

  return data;
}

export function registerWhatsappTools(): void {
  registerTool({
    name: 'whatsapp.send',
    description:
      'Send a text message via WhatsApp Business API. ' +
      'Only works within the 24-hour customer service window (after user has messaged first). ' +
      'Use whatsapp.send_template to initiate a conversation. Requires user confirmation.',
    parameters: {
      type: 'object',
      required: ['to', 'text'],
      properties: {
        to: { type: 'string', description: 'Recipient phone number in international format (e.g. "14155238886")' },
        text: { type: 'string', description: 'Message text (max 4096 characters)' },
        phone_number_id: { type: 'string', description: 'Business phone number ID (uses default if omitted)' },
        preview_url: { type: 'boolean', description: 'Enable URL preview in the message (default: false)' },
      },
    },
    requiredCredentials: ['whatsapp'],
    riskLevel: 'medium',
    requiresConfirmation: true,
    async execute(args) {
      const { to, text, phone_number_id, preview_url } = args as {
        to: string;
        text: string;
        phone_number_id?: string;
        preview_url?: boolean;
      };

      if (text.length > 4096) {
        throw new Error('Message text exceeds WhatsApp 4096 character limit');
      }

      const phoneId = phone_number_id || getPhoneNumberId();
      if (!phoneId) throw new Error('No phone_number_id provided and WHATSAPP_PHONE_NUMBER_ID not set');

      const data = await whatsappFetch(`/${phoneId}/messages`, {
        method: 'POST',
        body: {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { preview_url: preview_url || false, body: text },
        },
      });

      return {
        ok: true,
        message_id: data.messages?.[0]?.id,
        contact: data.contacts?.[0],
      };
    },
  });

  registerTool({
    name: 'whatsapp.send_template',
    description:
      'Send a pre-approved template message via WhatsApp. ' +
      'Required to initiate conversations outside the 24-hour service window. ' +
      'Templates must be pre-created and approved in Meta Business Manager. ' +
      'Requires user confirmation.',
    parameters: {
      type: 'object',
      required: ['to', 'template_name'],
      properties: {
        to: { type: 'string', description: 'Recipient phone number in international format' },
        template_name: { type: 'string', description: 'Approved template name (e.g. "hello_world")' },
        language_code: { type: 'string', description: 'Template language code (default: "en_US")' },
        components: {
          type: 'array',
          description: 'Template components (header, body, button parameters)',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', description: 'Component type: header, body, button' },
              parameters: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    type: { type: 'string', description: 'Parameter type: text, currency, date_time, image, document, video' },
                    text: { type: 'string', description: 'Text value (for text parameters)' },
                  },
                },
              },
            },
          },
        },
        phone_number_id: { type: 'string', description: 'Business phone number ID (uses default if omitted)' },
      },
    },
    requiredCredentials: ['whatsapp'],
    riskLevel: 'medium',
    requiresConfirmation: true,
    async execute(args) {
      const { to, template_name, language_code, components, phone_number_id } = args as {
        to: string;
        template_name: string;
        language_code?: string;
        components?: Array<{ type: string; parameters?: Array<{ type: string; text?: string }> }>;
        phone_number_id?: string;
      };

      const phoneId = phone_number_id || getPhoneNumberId();
      if (!phoneId) throw new Error('No phone_number_id provided and WHATSAPP_PHONE_NUMBER_ID not set');

      const template: Record<string, unknown> = {
        name: template_name,
        language: { code: language_code || 'en_US' },
      };
      if (components && components.length > 0) {
        template.components = components;
      }

      const data = await whatsappFetch(`/${phoneId}/messages`, {
        method: 'POST',
        body: {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'template',
          template,
        },
      });

      return {
        ok: true,
        message_id: data.messages?.[0]?.id,
        contact: data.contacts?.[0],
      };
    },
  });

  registerTool({
    name: 'whatsapp.send_media',
    description:
      'Send an image, document, audio, or video via WhatsApp. ' +
      'Provide a publicly accessible URL for the media. Requires user confirmation.',
    parameters: {
      type: 'object',
      required: ['to', 'media_type', 'url'],
      properties: {
        to: { type: 'string', description: 'Recipient phone number in international format' },
        media_type: { type: 'string', enum: ['image', 'document', 'audio', 'video'], description: 'Type of media to send' },
        url: { type: 'string', description: 'Public URL of the media file' },
        caption: { type: 'string', description: 'Optional caption (for image, video, document)' },
        filename: { type: 'string', description: 'Filename for document type' },
        phone_number_id: { type: 'string', description: 'Business phone number ID (uses default if omitted)' },
      },
    },
    requiredCredentials: ['whatsapp'],
    riskLevel: 'medium',
    requiresConfirmation: true,
    async execute(args) {
      const { to, media_type, url, caption, filename, phone_number_id } = args as {
        to: string;
        media_type: 'image' | 'document' | 'audio' | 'video';
        url: string;
        caption?: string;
        filename?: string;
        phone_number_id?: string;
      };

      const phoneId = phone_number_id || getPhoneNumberId();
      if (!phoneId) throw new Error('No phone_number_id provided and WHATSAPP_PHONE_NUMBER_ID not set');

      const mediaPayload: Record<string, unknown> = { link: url };
      if (caption) mediaPayload.caption = caption;
      if (filename && media_type === 'document') mediaPayload.filename = filename;

      const data = await whatsappFetch(`/${phoneId}/messages`, {
        method: 'POST',
        body: {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: media_type,
          [media_type]: mediaPayload,
        },
      });

      return {
        ok: true,
        message_id: data.messages?.[0]?.id,
        contact: data.contacts?.[0],
      };
    },
  });

  registerTool({
    name: 'whatsapp.get_profile',
    description: 'Get the WhatsApp Business profile information.',
    parameters: {
      type: 'object',
      properties: {
        phone_number_id: { type: 'string', description: 'Business phone number ID (uses default if omitted)' },
      },
    },
    requiredCredentials: ['whatsapp'],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const { phone_number_id } = args as { phone_number_id?: string };

      const phoneId = phone_number_id || getPhoneNumberId();
      if (!phoneId) throw new Error('No phone_number_id provided and WHATSAPP_PHONE_NUMBER_ID not set');

      const data = await whatsappFetch(`/${phoneId}/whatsapp_business_profile?fields=about,address,description,email,profile_picture_url,websites,vertical`);

      const profile = data.data?.[0] || {};
      return {
        about: profile.about,
        address: profile.address,
        description: profile.description,
        email: profile.email,
        profilePictureUrl: profile.profile_picture_url,
        websites: profile.websites,
        vertical: profile.vertical,
      };
    },
  });

  registerTool({
    name: 'whatsapp.mark_read',
    description: 'Mark a received WhatsApp message as read (shows blue ticks to sender).',
    parameters: {
      type: 'object',
      required: ['message_id'],
      properties: {
        message_id: { type: 'string', description: 'ID of the message to mark as read' },
        phone_number_id: { type: 'string', description: 'Business phone number ID (uses default if omitted)' },
      },
    },
    requiredCredentials: ['whatsapp'],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const { message_id, phone_number_id } = args as { message_id: string; phone_number_id?: string };

      const phoneId = phone_number_id || getPhoneNumberId();
      if (!phoneId) throw new Error('No phone_number_id provided and WHATSAPP_PHONE_NUMBER_ID not set');

      await whatsappFetch(`/${phoneId}/messages`, {
        method: 'POST',
        body: {
          messaging_product: 'whatsapp',
          status: 'read',
          message_id,
        },
      });

      return { ok: true, message_id };
    },
  });
}

export const _testExports = { whatsappFetch, getPhoneNumberId };

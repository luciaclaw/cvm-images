/**
 * Google Calendar tool implementations — list, create, update, delete events.
 *
 * Uses Google Calendar API v3 REST. Shares Google OAuth with Gmail.
 */

import { registerTool } from '../tool-registry.js';
import { getAccessToken } from '../oauth.js';

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

async function calendarFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken('google');
  if (!token) throw new Error('Google not connected. Please connect Google in Settings.');

  const response = await fetch(`${CALENDAR_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Calendar API error (${response.status}): ${error}`);
  }

  return response;
}

export function registerCalendarTools(): void {
  registerTool({
    name: 'calendar.list',
    description: 'List upcoming calendar events. Returns events from the primary calendar.',
    parameters: {
      type: 'object',
      properties: {
        timeMin: { type: 'string', description: 'Start time in ISO 8601 format (default: now)' },
        timeMax: { type: 'string', description: 'End time in ISO 8601 format (default: 7 days from now)' },
        maxResults: { type: 'number', description: 'Maximum events to return (default: 10)' },
      },
    },
    requiredCredentials: ['google'],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const {
        timeMin = new Date().toISOString(),
        timeMax = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        maxResults = 10,
      } = args as { timeMin?: string; timeMax?: string; maxResults?: number };

      const params = new URLSearchParams({
        timeMin,
        timeMax,
        maxResults: String(maxResults),
        singleEvents: 'true',
        orderBy: 'startTime',
      });

      const response = await calendarFetch(`/calendars/primary/events?${params}`);
      const data = await response.json() as any;

      const events = (data.items || []).map((event: any) => ({
        id: event.id,
        summary: event.summary || 'No title',
        description: event.description,
        start: event.start?.dateTime || event.start?.date,
        end: event.end?.dateTime || event.end?.date,
        location: event.location,
        status: event.status,
        attendees: event.attendees?.map((a: any) => ({
          email: a.email,
          responseStatus: a.responseStatus,
        })),
      }));

      return { events, total: events.length };
    },
  });

  registerTool({
    name: 'calendar.create',
    description: 'Create a new calendar event. Requires user confirmation.',
    parameters: {
      type: 'object',
      required: ['summary', 'start', 'end'],
      properties: {
        summary: { type: 'string', description: 'Event title' },
        description: { type: 'string', description: 'Event description' },
        start: { type: 'string', description: 'Start time in ISO 8601 format' },
        end: { type: 'string', description: 'End time in ISO 8601 format' },
        location: { type: 'string', description: 'Event location' },
        attendees: {
          type: 'array',
          items: { type: 'string' },
          description: 'Attendee email addresses',
        },
      },
    },
    requiredCredentials: ['google'],
    riskLevel: 'medium',
    requiresConfirmation: true,
    async execute(args) {
      const { summary, description, start, end, location, attendees } = args as {
        summary: string;
        description?: string;
        start: string;
        end: string;
        location?: string;
        attendees?: string[];
      };

      const event: any = {
        summary,
        start: { dateTime: start },
        end: { dateTime: end },
      };
      if (description) event.description = description;
      if (location) event.location = location;
      if (attendees) event.attendees = attendees.map((email) => ({ email }));

      const response = await calendarFetch('/calendars/primary/events', {
        method: 'POST',
        body: JSON.stringify(event),
      });

      const data = await response.json() as any;
      return {
        id: data.id,
        summary: data.summary,
        start: data.start?.dateTime || data.start?.date,
        end: data.end?.dateTime || data.end?.date,
        htmlLink: data.htmlLink,
      };
    },
  });

  registerTool({
    name: 'calendar.update',
    description: 'Update an existing calendar event. Requires user confirmation.',
    parameters: {
      type: 'object',
      required: ['eventId'],
      properties: {
        eventId: { type: 'string', description: 'Event ID to update' },
        summary: { type: 'string', description: 'New event title' },
        description: { type: 'string', description: 'New event description' },
        start: { type: 'string', description: 'New start time in ISO 8601 format' },
        end: { type: 'string', description: 'New end time in ISO 8601 format' },
        location: { type: 'string', description: 'New location' },
      },
    },
    requiredCredentials: ['google'],
    riskLevel: 'medium',
    requiresConfirmation: true,
    async execute(args) {
      const { eventId, ...updates } = args as {
        eventId: string;
        summary?: string;
        description?: string;
        start?: string;
        end?: string;
        location?: string;
      };

      const patch: any = {};
      if (updates.summary) patch.summary = updates.summary;
      if (updates.description) patch.description = updates.description;
      if (updates.start) patch.start = { dateTime: updates.start };
      if (updates.end) patch.end = { dateTime: updates.end };
      if (updates.location) patch.location = updates.location;

      const response = await calendarFetch(`/calendars/primary/events/${eventId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });

      const data = await response.json() as any;
      return {
        id: data.id,
        summary: data.summary,
        start: data.start?.dateTime || data.start?.date,
        end: data.end?.dateTime || data.end?.date,
        updated: data.updated,
      };
    },
  });

  registerTool({
    name: 'calendar.delete',
    description: 'Delete a calendar event. Requires user confirmation.',
    parameters: {
      type: 'object',
      required: ['eventId'],
      properties: {
        eventId: { type: 'string', description: 'Event ID to delete' },
      },
    },
    requiredCredentials: ['google'],
    riskLevel: 'high',
    requiresConfirmation: true,
    async execute(args) {
      const { eventId } = args as { eventId: string };
      await calendarFetch(`/calendars/primary/events/${eventId}`, {
        method: 'DELETE',
      });
      return { deleted: true, eventId };
    },
  });
}

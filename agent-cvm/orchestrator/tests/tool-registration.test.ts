import { describe, it, expect, beforeAll } from 'vitest';
import { getAllTools } from '../src/tool-registry.js';
import { registerGmailTools } from '../src/tools/gmail.js';
import { registerCalendarTools } from '../src/tools/calendar.js';
import { registerSlackTools } from '../src/tools/slack.js';
import { registerTelegramTools } from '../src/tools/telegram.js';
import { registerVisionTools } from '../src/tools/vision.js';
import { registerWebSearchTools } from '../src/tools/web-search.js';
import { registerBrowserTools } from '../src/tools/browser.js';

describe('tool registration', () => {
  beforeAll(() => {
    registerGmailTools();
    registerCalendarTools();
    registerSlackTools();
    registerTelegramTools();
    registerVisionTools();
    registerWebSearchTools();
    registerBrowserTools();
  });

  it('registers all 19 tools', () => {
    const tools = getAllTools();
    expect(tools.length).toBe(22);
  });

  it('includes all expected tool names', () => {
    const names = getAllTools().map((t) => t.name);

    // Gmail (4)
    expect(names).toContain('gmail.send');
    expect(names).toContain('gmail.read');
    expect(names).toContain('gmail.search');
    expect(names).toContain('gmail.list');

    // Calendar (4)
    expect(names).toContain('calendar.list');
    expect(names).toContain('calendar.create');
    expect(names).toContain('calendar.update');
    expect(names).toContain('calendar.delete');

    // Slack (3)
    expect(names).toContain('slack.send');
    expect(names).toContain('slack.read');
    expect(names).toContain('slack.list_channels');

    // Telegram (3)
    expect(names).toContain('telegram.send');
    expect(names).toContain('telegram.read');
    expect(names).toContain('telegram.get_chat');

    // Vision (1)
    expect(names).toContain('vision.analyze');

    // Web search (2)
    expect(names).toContain('web.search');
    expect(names).toContain('web.fetch');

    // Browser (5)
    expect(names).toContain('browser.navigate');
    expect(names).toContain('browser.screenshot');
    expect(names).toContain('browser.click');
    expect(names).toContain('browser.type');
    expect(names).toContain('browser.extract');
  });

  it('every tool has required properties', () => {
    for (const tool of getAllTools()) {
      expect(tool).toHaveProperty('name');
      expect(tool).toHaveProperty('description');
      expect(tool).toHaveProperty('parameters');
      expect(tool).toHaveProperty('riskLevel');
      expect(typeof tool.execute).toBe('function');
    }
  });
});

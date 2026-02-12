import { describe, it, expect, beforeAll } from 'vitest';
import { registerTelegramTools } from '../src/tools/telegram.js';
import { getTool, getAllTools } from '../src/tool-registry.js';

describe('telegram tools', () => {
  beforeAll(() => {
    registerTelegramTools();
  });

  it('registers 3 telegram tools', () => {
    const names = getAllTools().map((t) => t.name);
    const telegramTools = names.filter((n) => n.startsWith('telegram.'));
    expect(telegramTools.length).toBe(3);
  });

  it('telegram.send has correct properties', () => {
    const tool = getTool('telegram.send')!;
    expect(tool).toBeDefined();
    expect(tool.riskLevel).toBe('medium');
    expect(tool.requiresConfirmation).toBe(true);
    expect(tool.requiredCredentials).toContain('telegram');
    expect(tool.parameters).toHaveProperty('required');
    expect((tool.parameters as any).required).toContain('chat_id');
    expect((tool.parameters as any).required).toContain('text');
  });

  it('telegram.read has correct properties', () => {
    const tool = getTool('telegram.read')!;
    expect(tool).toBeDefined();
    expect(tool.riskLevel).toBe('low');
    expect(tool.requiresConfirmation).toBe(false);
    expect(tool.requiredCredentials).toContain('telegram');
  });

  it('telegram.get_chat has correct properties', () => {
    const tool = getTool('telegram.get_chat')!;
    expect(tool).toBeDefined();
    expect(tool.riskLevel).toBe('low');
    expect(tool.requiresConfirmation).toBe(false);
    expect(tool.requiredCredentials).toContain('telegram');
    expect((tool.parameters as any).required).toContain('chat_id');
  });
});

describe('telegram tools — missing credential', () => {
  beforeAll(() => {
    registerTelegramTools();
  });

  it('telegram.send throws when no token stored', async () => {
    const tool = getTool('telegram.send')!;
    await expect(
      tool.execute({ chat_id: '123', text: 'hello' })
    ).rejects.toThrow(/Telegram not connected|Cannot open database/);
  });

  it('telegram.read throws when no token stored', async () => {
    const tool = getTool('telegram.read')!;
    await expect(
      tool.execute({})
    ).rejects.toThrow(/Telegram not connected|Cannot open database/);
  });

  it('telegram.get_chat throws when no token stored', async () => {
    const tool = getTool('telegram.get_chat')!;
    await expect(
      tool.execute({ chat_id: '123' })
    ).rejects.toThrow(/Telegram not connected|Cannot open database/);
  });
});

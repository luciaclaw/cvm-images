import { describe, it, expect, beforeAll } from 'vitest';
import { registerWhatsappTools } from '../src/tools/whatsapp.js';
import { getTool, getAllTools } from '../src/tool-registry.js';

describe('whatsapp tools', () => {
  beforeAll(() => {
    registerWhatsappTools();
  });

  it('registers 5 whatsapp tools', () => {
    const names = getAllTools().map((t) => t.name);
    const waTools = names.filter((n) => n.startsWith('whatsapp.'));
    expect(waTools.length).toBe(5);
  });

  it('whatsapp.send has correct properties', () => {
    const tool = getTool('whatsapp.send')!;
    expect(tool).toBeDefined();
    expect(tool.riskLevel).toBe('medium');
    expect(tool.requiresConfirmation).toBe(true);
    expect(tool.requiredCredentials).toContain('whatsapp');
    expect((tool.parameters as any).required).toContain('to');
    expect((tool.parameters as any).required).toContain('text');
  });

  it('whatsapp.send_template has correct properties', () => {
    const tool = getTool('whatsapp.send_template')!;
    expect(tool).toBeDefined();
    expect(tool.riskLevel).toBe('medium');
    expect(tool.requiresConfirmation).toBe(true);
    expect(tool.requiredCredentials).toContain('whatsapp');
    expect((tool.parameters as any).required).toContain('to');
    expect((tool.parameters as any).required).toContain('template_name');
  });

  it('whatsapp.send_media has correct properties', () => {
    const tool = getTool('whatsapp.send_media')!;
    expect(tool).toBeDefined();
    expect(tool.riskLevel).toBe('medium');
    expect(tool.requiresConfirmation).toBe(true);
    expect(tool.requiredCredentials).toContain('whatsapp');
    expect((tool.parameters as any).required).toEqual(['to', 'media_type', 'url']);
  });

  it('whatsapp.get_profile has correct properties', () => {
    const tool = getTool('whatsapp.get_profile')!;
    expect(tool).toBeDefined();
    expect(tool.riskLevel).toBe('low');
    expect(tool.requiresConfirmation).toBe(false);
    expect(tool.requiredCredentials).toContain('whatsapp');
  });

  it('whatsapp.mark_read has correct properties', () => {
    const tool = getTool('whatsapp.mark_read')!;
    expect(tool).toBeDefined();
    expect(tool.riskLevel).toBe('low');
    expect(tool.requiresConfirmation).toBe(false);
    expect(tool.requiredCredentials).toContain('whatsapp');
    expect((tool.parameters as any).required).toContain('message_id');
  });
});

describe('whatsapp tools — missing credential', () => {
  beforeAll(() => {
    registerWhatsappTools();
  });

  it('whatsapp.send throws when no phone_number_id set', async () => {
    const tool = getTool('whatsapp.send')!;
    await expect(
      tool.execute({ to: '14155238886', text: 'hello' })
    ).rejects.toThrow(/No phone_number_id|WhatsApp not connected|Cannot open database/);
  });

  it('whatsapp.send_template throws when no phone_number_id set', async () => {
    const tool = getTool('whatsapp.send_template')!;
    await expect(
      tool.execute({ to: '14155238886', template_name: 'hello_world' })
    ).rejects.toThrow(/No phone_number_id|WhatsApp not connected|Cannot open database/);
  });

  it('whatsapp.get_profile throws when no token stored', async () => {
    const tool = getTool('whatsapp.get_profile')!;
    await expect(
      tool.execute({})
    ).rejects.toThrow(/WhatsApp not connected|Cannot open database|No phone_number_id/);
  });
});

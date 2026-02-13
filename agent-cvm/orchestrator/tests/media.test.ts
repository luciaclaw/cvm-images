import { describe, it, expect, beforeAll } from 'vitest';
import { registerMediaTools } from '../src/tools/media.js';
import { getTool, getAllTools } from '../src/tool-registry.js';

describe('media tools — image generation', () => {
  beforeAll(() => {
    registerMediaTools();
  });

  it('registers 3 image tools', () => {
    const names = getAllTools().map((t) => t.name);
    const imageTools = names.filter((n) => n.startsWith('image.'));
    expect(imageTools.length).toBe(3);
    expect(imageTools).toContain('image.generate');
    expect(imageTools).toContain('image.edit');
    expect(imageTools).toContain('image.upscale');
  });

  it('image.generate has correct properties', () => {
    const tool = getTool('image.generate')!;
    expect(tool).toBeDefined();
    expect(tool.riskLevel).toBe('low');
    expect(tool.requiresConfirmation).toBe(false);
    expect(tool.requiredCredentials).toContain('kie');
    expect((tool.parameters as any).required).toContain('prompt');
  });

  it('image.edit has correct properties', () => {
    const tool = getTool('image.edit')!;
    expect(tool).toBeDefined();
    expect(tool.requiredCredentials).toContain('kie');
    expect((tool.parameters as any).required).toEqual(['image_url', 'prompt']);
  });

  it('image.upscale has correct properties', () => {
    const tool = getTool('image.upscale')!;
    expect(tool).toBeDefined();
    expect(tool.requiredCredentials).toContain('kie');
    expect((tool.parameters as any).required).toEqual(['image_url']);
  });

  it('image.generate throws when no API key stored', async () => {
    const tool = getTool('image.generate')!;
    await expect(
      tool.execute({ prompt: 'A sunset over mountains' })
    ).rejects.toThrow(/Kie\.ai not connected|Cannot open database/);
  });
});

describe('media tools — music generation', () => {
  beforeAll(() => {
    registerMediaTools();
  });

  it('registers 3 music tools', () => {
    const names = getAllTools().map((t) => t.name);
    const musicTools = names.filter((n) => n.startsWith('music.'));
    expect(musicTools.length).toBe(3);
    expect(musicTools).toContain('music.generate');
    expect(musicTools).toContain('music.extend');
    expect(musicTools).toContain('music.remix');
  });

  it('music.generate has correct properties', () => {
    const tool = getTool('music.generate')!;
    expect(tool).toBeDefined();
    expect(tool.riskLevel).toBe('low');
    expect(tool.requiresConfirmation).toBe(false);
    expect(tool.requiredCredentials).toContain('kie');
    expect((tool.parameters as any).required).toContain('prompt');
  });

  it('music.extend has correct properties', () => {
    const tool = getTool('music.extend')!;
    expect(tool).toBeDefined();
    expect(tool.requiredCredentials).toContain('kie');
    expect((tool.parameters as any).required).toContain('track_url');
  });

  it('music.remix has correct properties', () => {
    const tool = getTool('music.remix')!;
    expect(tool).toBeDefined();
    expect(tool.requiredCredentials).toContain('kie');
    expect((tool.parameters as any).required).toEqual(['track_url', 'prompt']);
  });

  it('music.generate throws when no API key stored', async () => {
    const tool = getTool('music.generate')!;
    await expect(
      tool.execute({ prompt: 'An upbeat pop song about summer' })
    ).rejects.toThrow(/Kie\.ai not connected|Cannot open database/);
  });
});

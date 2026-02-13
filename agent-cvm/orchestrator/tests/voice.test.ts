import { describe, it, expect, beforeAll, vi } from 'vitest';

// Mock inference module for transcription
vi.mock('../src/inference.js', () => ({
  callTranscription: vi.fn().mockResolvedValue({
    text: 'Hello, this is a test transcription.',
    language: 'en',
    duration: 3.5,
  }),
  callInference: vi.fn(),
  callVisionInference: vi.fn(),
}));

import { registerVoiceTools } from '../src/tools/voice.js';
import { getTool, getAllTools } from '../src/tool-registry.js';
import { callTranscription } from '../src/inference.js';

describe('voice tools', () => {
  beforeAll(() => {
    registerVoiceTools();
  });

  it('registers voice.transcribe tool', () => {
    const names = getAllTools().map((t) => t.name);
    expect(names).toContain('voice.transcribe');
  });

  it('voice.transcribe has correct properties', () => {
    const tool = getTool('voice.transcribe')!;
    expect(tool).toBeDefined();
    expect(tool.riskLevel).toBe('low');
    expect(tool.requiresConfirmation).toBe(false);
    expect(tool.requiredCredentials).toEqual([]);
  });

  it('transcribes direct audio data', async () => {
    const tool = getTool('voice.transcribe')!;
    const result = await tool.execute({
      audio_data: 'SGVsbG8gV29ybGQ=', // base64 dummy
      source: 'direct',
      language: 'en',
    }) as any;

    expect(result.text).toBe('Hello, this is a test transcription.');
    expect(result.language).toBe('en');
    expect(result.duration).toBe(3.5);
    expect(result.source).toBe('direct');

    // Verify callTranscription was called with correct args
    expect(callTranscription).toHaveBeenCalledWith(
      'SGVsbG8gV29ybGQ=',
      'audio.ogg',
      undefined,
      'en',
    );
  });

  it('defaults to direct source when source is omitted', async () => {
    const tool = getTool('voice.transcribe')!;
    const result = await tool.execute({
      audio_data: 'dGVzdA==',
    }) as any;

    expect(result.source).toBe('direct');
  });

  it('throws when audio_data missing for direct source', async () => {
    const tool = getTool('voice.transcribe')!;
    await expect(
      tool.execute({ source: 'direct' })
    ).rejects.toThrow('audio_data is required');
  });

  it('throws when file_id missing for telegram source', async () => {
    const tool = getTool('voice.transcribe')!;
    await expect(
      tool.execute({ source: 'telegram' })
    ).rejects.toThrow('file_id is required');
  });

  it('throws when file_id missing for whatsapp source', async () => {
    const tool = getTool('voice.transcribe')!;
    await expect(
      tool.execute({ source: 'whatsapp' })
    ).rejects.toThrow('file_id is required');
  });

  it('passes model override to callTranscription', async () => {
    const tool = getTool('voice.transcribe')!;
    await tool.execute({
      audio_data: 'dGVzdA==',
      model: 'whisper-large-v3',
    });

    expect(callTranscription).toHaveBeenCalledWith(
      'dGVzdA==',
      'audio.ogg',
      'whisper-large-v3',
      undefined,
    );
  });

  it('passes custom filename to callTranscription', async () => {
    const tool = getTool('voice.transcribe')!;
    await tool.execute({
      audio_data: 'dGVzdA==',
      filename: 'message.mp3',
    });

    expect(callTranscription).toHaveBeenCalledWith(
      'dGVzdA==',
      'message.mp3',
      undefined,
      undefined,
    );
  });
});

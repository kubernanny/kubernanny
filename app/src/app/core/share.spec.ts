import { describe, expect, it, vi } from 'vitest';
import { ShareApi, copyText, shareText } from './share';

const api = (over: Partial<ShareApi>): ShareApi => ({ canShare: async () => true, share: vi.fn(async () => undefined), copy: vi.fn(async () => undefined), ...over });

describe('shareText', () => {
  it('uses the share sheet where there is one', async () => {
    const a = api({});
    expect(await shareText('t', 'title', a)).toBe('shared');
    expect(a.share).toHaveBeenCalledWith('t', 'title');
    expect(a.copy).not.toHaveBeenCalled();
  });

  it('copies where there is none, or when sharing fails', async () => {
    expect(await shareText('t', 'x', api({ canShare: async () => false }))).toBe('copied');
    expect(await shareText('t', 'x', api({ share: async () => Promise.reject(new Error('not allowed')) }))).toBe('copied');
  });

  it('takes a closed share sheet as an answer, and says when nothing worked', async () => {
    const a = api({ share: async () => Promise.reject(new Error('Share canceled')) });
    expect(await shareText('t', 'x', a)).toBe('shared');
    expect(a.copy).not.toHaveBeenCalled();
    expect(await shareText('t', 'x', api({ canShare: async () => false, copy: async () => Promise.reject(new Error('no')) }))).toBe('failed');
  });
});

describe('copyText', () => {
  it('says whether the clipboard took the text', async () => {
    expect(await copyText('t', { copy: async () => undefined })).toBe(true);
    expect(await copyText('t', { copy: async () => Promise.reject(new Error('no')) })).toBe(false);
  });
});

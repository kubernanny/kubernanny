import { describe, expect, it } from 'vitest';

import { readableToastOptions, readingTime } from './readable-toasts';

describe('readable toasts', () => {
  it('replaces the colour fill with a kind class and icon', () => {
    const options = readableToastOptions(
      { message: 'Stummgeschaltet.', color: 'success', duration: 3500 },
      'Schließen',
    );
    expect(options.color).toBeUndefined();
    expect(options.cssClass).toEqual(['kn-toast', 'kn-toast-success']);
    expect(options.icon).toBe('checkmark-circle');
    expect(options.duration).toBe(3500);
    expect(options.buttons).toBeUndefined();
  });

  it('gives every error and every long toast a labelled close button', () => {
    const error = readableToastOptions({ message: 'Nope.', color: 'danger' }, 'Schließen');
    expect(error.cssClass).toEqual(['kn-toast', 'kn-toast-error']);
    expect(error.buttons).toEqual([
      expect.objectContaining({
        icon: 'close',
        role: 'cancel',
        htmlAttributes: { 'aria-label': 'Schließen' },
      }),
    ]);
    const long = readableToastOptions({ message: 'x'.repeat(120) }, 'Close');
    expect(long.cssClass).toEqual(['kn-toast', 'kn-toast-info']);
    expect(long.buttons).toHaveLength(1);
  });

  it('keeps a long message up long enough to read it, but never forever', () => {
    expect(readingTime('Kopiert.', 1500)).toBe(1980);
    expect(readingTime('x'.repeat(150), 3000)).toBe(10_500);
    expect(readingTime('x'.repeat(1000), 3000)).toBe(15_000);
    expect(
      readableToastOptions({ message: 'x'.repeat(150), duration: 3000 }, 'Close').duration,
    ).toBe(10_500);
  });

  it("keeps the caller's own classes and buttons", () => {
    const options = readableToastOptions(
      { message: 'Hi', cssClass: 'mine', color: 'warning', buttons: [{ text: 'Undo' }] },
      'Close',
    );
    expect(options.cssClass).toEqual(['kn-toast', 'kn-toast-warning', 'mine']);
    expect(options.buttons).toEqual([{ text: 'Undo' }]);
  });
});

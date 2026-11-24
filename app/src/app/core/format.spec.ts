import { describe, expect, it } from 'vitest';
import { age, bytes, clockTime, cores, dateTime, decimal, duration, formatValue, percent, relativeTime, sinceText, span, startOfDay, untilText } from './format';

const NOW = new Date('2026-11-24T12:00:00');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Intl puts a narrow no-break space before AM/PM; compare it as a plain space. */
const plain = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ');

describe('format, German', () => {
  it('writes numbers with a decimal comma and a space before %', () => {
    expect(decimal(1.5, 'de', 1)).toBe('1,5');
    expect(decimal(12345.678, 'de', 1)).toBe('12345,7');
    expect(bytes(1536 * 2 ** 20, 'de')).toBe('1,5 GiB');
    expect(bytes(512, 'de')).toBe('512 B');
    expect(bytes(null, 'de')).toBe('–');
    expect(cores(5400, 'de')).toBe('5,40');
    expect(cores(12500, 'de')).toBe('12,5');
    expect(percent(0.423, 'de')).toBe('42 %');
    expect(formatValue(0.0061, 'seconds', 'de')).toBe('6,1 ms');
    expect(formatValue(2.5, 'seconds', 'de')).toBe('2,50 s');
    expect(formatValue(4.25, 'count', 'de')).toBe('4,3');
  });

  it('says how long ago, and since when', () => {
    expect(duration(ago(30_000), NOW, 'de')).toBeNull();
    expect(relativeTime(ago(3 * MIN), NOW, 'de')).toBe('vor 3 min');
    expect(relativeTime(ago(30_000), NOW, 'de')).toBe('gerade eben');
    expect(relativeTime(null, NOW, 'de')).toBe('noch nie');
    expect(relativeTime(ago(3 * DAY), NOW, 'de')).toBe('vor 3 Tagen');
    expect(sinceText(ago(2 * HOUR), NOW, 'de')).toBe('seit 2 h');
    expect(sinceText(ago(10_000), NOW, 'de')).toBe('gerade neu');
    expect(age(ago(3 * DAY), NOW, 'de')).toBe('seit 3 Tagen');
    expect(age(ago(1.5 * DAY), NOW, 'de')).toBe('seit 1 Tag');
    expect(age(ago(HOUR), NOW, 'de')).toBe('seit heute');
    expect(age(ago(240 * DAY), NOW, 'de')).toBe('seit 8 Monaten');
    expect(age(ago(1000 * DAY), NOW, 'de')).toBe('seit 3 Jahren');
    expect(age(undefined, NOW, 'de')).toBe('–');
  });

  it('says when a silence ends, with the weekday once it is another day', () => {
    expect(untilText(new Date('2026-11-24T18:30:00').toISOString(), NOW, 'de')).toBe('stumm bis 18:30');
    // ICU versions differ on the abbreviation's dot ("Fr." or "Fr").
    expect(untilText(new Date('2026-11-27T08:00:00').toISOString(), NOW, 'de')).toMatch(/^stumm bis Fr\.?, 08:00$/);
    expect(clockTime(new Date('2026-11-24T14:05:00').getTime(), 'de')).toBe('14:05');
  });
});

describe('spans and moments', () => {
  it('says how long something lasted', () => {
    expect(span(40_000, 'de')).toBe('40 s');
    expect(span(12 * MIN, 'en')).toBe('12 min');
    expect(span(2 * HOUR + 14 * MIN, 'de')).toBe('2 h 14 min');
    expect(span(3 * HOUR, 'en')).toBe('3 h');
    expect(span(3 * DAY + 4 * HOUR, 'de')).toBe('3 Tage 4 h');
    expect(span(DAY + 30 * MIN, 'en')).toBe('1 day');
    expect(span(-5, 'en')).toBe('0 s');
  });

  it('writes a recent moment with the weekday', () => {
    expect(plain(dateTime(new Date('2026-11-23T14:05:00').toISOString(), 'de'))).toMatch(/^Mo\.?, 23\.11\.?, 14:05$/);
    expect(plain(dateTime(new Date('2026-11-23T14:05:00').toISOString(), 'en'))).toBe('Mon, 11/23, 2:05 PM');
    expect(startOfDay(new Date('2026-11-23T14:05:00').getTime())).toBe(new Date('2026-11-23T00:00:00').getTime());
  });
});

describe('format, English', () => {
  it('writes numbers with a decimal point and no space before %', () => {
    expect(decimal(1.5, 'en', 1)).toBe('1.5');
    expect(decimal(12345.678, 'en', 1)).toBe('12345.7');
    expect(bytes(1536 * 2 ** 20, 'en')).toBe('1.5 GiB');
    expect(cores(5400, 'en')).toBe('5.40');
    expect(cores(250, 'en')).toBe('250m');
    expect(percent(0.423, 'en')).toBe('42%');
    expect(percent(undefined, 'en')).toBe('–');
    expect(formatValue(0.0061, 'seconds', 'en')).toBe('6.1 ms');
    expect(formatValue(2.4e6, 'bytesPerSecond', 'en')).toBe('2.3 MiB/s');
  });

  it('says how long ago, and for how long', () => {
    expect(relativeTime(ago(3 * MIN), NOW, 'en')).toBe('3 min ago');
    expect(relativeTime(ago(30_000), NOW, 'en')).toBe('just now');
    expect(relativeTime(undefined, NOW, 'en')).toBe('never');
    expect(relativeTime(ago(3 * DAY), NOW, 'en')).toBe('3 days ago');
    expect(sinceText(ago(2 * HOUR), NOW, 'en')).toBe('for 2 h');
    expect(sinceText(ago(10_000), NOW, 'en')).toBe('just now');
    expect(age(ago(3 * DAY), NOW, 'en')).toBe('for 3 days');
    expect(age(ago(1.5 * DAY), NOW, 'en')).toBe('for 1 day');
    expect(age(ago(HOUR), NOW, 'en')).toBe('since today');
    expect(age(ago(240 * DAY), NOW, 'en')).toBe('for 8 months');
  });

  it('says when a silence ends in 12-hour time', () => {
    expect(plain(untilText(new Date('2026-11-24T18:30:00').toISOString(), NOW, 'en'))).toBe('silenced until 6:30 PM');
    expect(plain(untilText(new Date('2026-11-27T08:00:00').toISOString(), NOW, 'en'))).toBe('silenced until Fri, 8:00 AM');
    expect(plain(clockTime(new Date('2026-11-24T14:05:00').getTime(), 'en'))).toBe('2:05 PM');
  });
});

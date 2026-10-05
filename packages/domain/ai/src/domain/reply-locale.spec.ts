import { describe, expect, it } from 'vitest';
import { replyLocale } from './agents';

describe('reply language in five languages (ADR-0022)', () => {
  it('reads the script first: Arabic, Russian', () => {
    expect(replyLocale('الجو حر أوي هنا', 'en')).toBe('ar');
    expect(replyLocale('В номере очень жарко', 'en')).toBe('ru');
    expect(replyLocale('Можно полотенца в 504?', 'de')).toBe('ru');
  });

  it('tells English, Italian and German apart by common words and letters', () => {
    expect(replyLocale('It is too hot in my room', 'ar')).toBe('en');
    expect(replyLocale('Vorrei due asciugamani per la camera, grazie', 'en')).toBe('it');
    expect(replyLocale('Können wir bitte zwei Handtücher haben?', 'en')).toBe('de');
    expect(replyLocale('È possibile un late check-out?', 'en')).toBe('it');
  });

  it('falls back to the conversation language when the message does not say', () => {
    expect(replyLocale('504 ?', 'ru')).toBe('ru');
    expect(replyLocale('OK', 'de')).toBe('de');
    expect(replyLocale('OK', 'ru')).toBe('en');
    expect(replyLocale('👍', 'fr')).toBe('en');
  });
});

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  missingLocalized,
  parseLocalized,
  pickLocalized,
  type Localized,
} from './localized';

const fixture = JSON.parse(
  readFileSync(join(__dirname, 'localized.cases.json'), 'utf8'),
) as {
  localized: Localized<'name'>;
  fallback: string;
  cases: Array<{ language: string; expected: string; why: string }>;
  withoutDefault: {
    localized: Localized<'name'>;
    language: string;
    expected: string;
  };
};

describe('pickLocalized (shared cases with the client)', () => {
  it.each(fixture.cases)('$language -> $expected ($why)', (c) => {
    expect(
      pickLocalized(fixture.localized, 'name', c.language, fixture.fallback),
    ).toBe(c.expected);
  });

  it('falls back to the key when neither the language nor en-GB has text', () => {
    const w = fixture.withoutDefault;
    expect(
      pickLocalized(w.localized, 'name', w.language, fixture.fallback),
    ).toBe(w.expected);
    expect(pickLocalized(null, 'name', 'zh-CN', 'key')).toBe('key');
  });
});

describe('parseLocalized', () => {
  it('keeps only the given fields with text, per language', () => {
    expect(
      parseLocalized(
        {
          'en-GB': { name: 'Society', extra: 'x', description: '' },
          'zh-CN': { name: '社会' },
          'fr-FR': { name: '' },
          bad: 'Society',
        },
        ['name', 'description'],
      ),
    ).toEqual({ 'en-GB': { name: 'Society' }, 'zh-CN': { name: '社会' } });
  });

  it('reads anything that is not an object as empty', () => {
    expect(parseLocalized(null, ['name'])).toEqual({});
    expect(parseLocalized(['x'], ['name'])).toEqual({});
  });
});

describe('missingLocalized', () => {
  it('lists every required language and field without text, in order', () => {
    expect(
      missingLocalized(
        { 'en-GB': { headline: 'Hi', subheading: ' ' }, 'zh-CN': {} },
        ['headline', 'subheading'],
      ),
    ).toEqual([
      { language: 'en-GB', field: 'subheading' },
      { language: 'zh-CN', field: 'headline' },
      { language: 'zh-CN', field: 'subheading' },
    ]);
    expect(
      missingLocalized({ 'en-GB': { a: 'x' }, 'zh-CN': { a: 'y' } }, ['a']),
    ).toEqual([]);
  });
});

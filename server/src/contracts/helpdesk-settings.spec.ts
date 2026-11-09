import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  HELPDESK_SETTINGS,
  helpdeskSettingProblems,
  readHelpdeskSetting,
  readHelpdeskSettingStrict,
  settingParsers as p,
  type HelpdeskSettingDef,
  type SettingProblem,
} from './helpdesk-settings';

/**
 * 配置层（helpdesk-settings.ts）：一张声明表 + 一套解析器。这里按「每一种写法」锁住，而不是按变量逐个写：
 * 新变量只要用已有的解析器，就自动有这些保证。
 */

const read = <T>(def: HelpdeskSettingDef<T>, raw: string | undefined) => {
  const problems: SettingProblem[] = [];
  const value = readHelpdeskSetting(def, { [def.name]: raw }, (problem) =>
    problems.push(problem),
  );
  return { value, problems };
};

describe('parsers: every value shape is defined once', () => {
  it('never reads an empty piece as 0 (the "0.8," bug)', () => {
    const pair = p.pair(
      p.decimal({ min: 0, max: 1 }),
      p.decimal({ min: 0, max: 1 }),
    );
    for (const token of ['0.8,', ',0.05', ',', '0.8, ', ' ,0.05', '0.8,,0.05'])
      expect(pair.parse(token).ok).toBe(false);
    expect(pair.parse('0.8, 0.05')).toEqual({ ok: true, value: [0.8, 0.05] });
  });

  it('numbers: decimal notation only, inside the range', () => {
    const d = p.decimal({ min: 0, max: 1 });
    for (const ok of ['0', '1', '0.5', '.5', '0.840'])
      expect(d.parse(ok).ok).toBe(true);
    for (const bad of [
      '1e-1',
      '0x1',
      'NaN',
      'Infinity',
      '+0.5',
      '1.',
      '1.2',
      '-0.1',
      '0,5',
      '0 .5',
    ])
      expect(d.parse(bad).ok).toBe(false);
    const w = p.wholeNumber({ min: 1, max: 50 });
    for (const bad of ['0', '51', '2.5', '-2', '1e1', '07a'])
      expect(w.parse(bad).ok).toBe(false);
    expect(w.parse('07')).toEqual({ ok: true, value: 7 });
  });

  it('exclusive bounds', () => {
    const d = p.decimal({
      min: 0,
      max: 1,
      minExclusive: true,
      maxExclusive: true,
    });
    expect(d.parse('0').ok).toBe(false);
    expect(d.parse('1').ok).toBe(false);
    expect(d.parse('0.5').ok).toBe(true);
  });

  it('on / off and enums ignore letter case', () => {
    expect(p.onOff().parse('ON')).toEqual({ ok: true, value: true });
    expect(p.onOff().parse('Off')).toEqual({ ok: true, value: false });
    expect(p.onOff().parse('true').ok).toBe(false);
    expect(p.oneOf(['tree', 'all'] as const).parse('ALL')).toEqual({
      ok: true,
      value: 'all',
    });
  });

  it('model ids look like vendor/model', () => {
    for (const ok of [
      'google/gemma-4-31b-it',
      'voyageai/rerank-2.5-lite',
      'meta-llama/llama-3.1-8b-instruct:free',
    ])
      expect(p.model().parse(ok).ok).toBe(true);
    for (const bad of [
      'off',
      'gemma',
      'google/',
      '/x',
      'a b/c',
      'google/gemma 4',
    ])
      expect(p.model().parse(bad).ok).toBe(false);
  });

  it('offOr: off (any case) is null; anything else goes to the inner parser', () => {
    const keep = p.offOr(p.wholeNumber({ min: 1, max: 50 }));
    expect(keep.parse('OFF')).toEqual({ ok: true, value: null });
    expect(keep.parse('3')).toEqual({ ok: true, value: 3 });
    expect(keep.parse('of').ok).toBe(false);
  });
});

describe('every declared setting follows the same reading rules', () => {
  const defs = Object.values(
    HELPDESK_SETTINGS,
  ) as HelpdeskSettingDef<unknown>[];

  it('names are unique and all start with HELPDESK_', () => {
    const names = defs.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^HELPDESK_[A-Z0-9_]+$/);
  });

  it.each(defs.map((d) => [d.name, d] as const))(
    '%s: unset or blank -> the default, no problem; garbage -> the default and one problem',
    (_name, def) => {
      const fallback = read(def, undefined).value;
      for (const blank of ['', '   ', '\t'])
        expect(read(def, blank)).toEqual({ value: fallback, problems: [] });
      const garbage = read(def, '%%not-a-value%%');
      expect(garbage.value).toEqual(fallback);
      expect(garbage.problems).toEqual([
        {
          name: def.name,
          value: '%%not-a-value%%',
          expected: def.parser.expected,
        },
      ]);
    },
  );

  it.each(defs.map((d) => [d.name, d] as const))(
    '%s: the strict reader throws on garbage and names the right form',
    (_name, def) => {
      expect(() =>
        readHelpdeskSettingStrict(def, { [def.name]: '%%not-a-value%%' }),
      ).toThrow(`${def.name} must be ${def.parser.expected}`);
    },
  );

  it('object defaults are a fresh copy on every read', () => {
    const a = read(HELPDESK_SETTINGS.rerankDirect, undefined).value!;
    a.score = 0.1;
    expect(read(HELPDESK_SETTINGS.rerankDirect, undefined).value).toEqual({
      score: 0.84,
      margin: 0.05,
    });
  });

  it('reads the environment on every call (hot reload)', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(readHelpdeskSetting(HELPDESK_SETTINGS.multiAsk, env)).toBe(false);
    env.HELPDESK_MULTI_ASK = 'on';
    expect(readHelpdeskSetting(HELPDESK_SETTINGS.multiAsk, env)).toBe(true);
  });

  it('the old case-sensitive switch is gone: OFF switches the release model eval off', () => {
    expect(read(HELPDESK_SETTINGS.releaseModelEval, 'OFF').value).toBe(false);
    expect(
      read(HELPDESK_SETTINGS.releaseModelEval, undefined).value,
    ).toBeNull();
  });

  it('lists every problem in an environment at once (start-up check, health page)', () => {
    expect(
      helpdeskSettingProblems({
        HELPDESK_RERANK_DIRECT: '0.8,',
        HELPDESK_MULTI_ASK: 'yes',
        HELPDESK_SEARCH_SCOPE: 'all',
        OPENROUTER_API_KEY: 'not a helpdesk setting',
      }).map((problem) => problem.name),
    ).toEqual(['HELPDESK_RERANK_DIRECT', 'HELPDESK_MULTI_ASK']);
  });
});

describe('the declaration table is the only reader of HELPDESK_* settings', () => {
  const SERVER = join(__dirname, '../..');
  const ROOTS = ['src', 'eval'].map((dir) => join(SERVER, dir));
  const declared = new Set(
    Object.values(HELPDESK_SETTINGS).map((def) => def.name as string),
  );
  /** 不是 Helpdesk 运行配置的同前缀变量（测试库地址、Portal 对接的地址与令牌）。 */
  const NOT_SETTINGS = /^HELPDESK_(TEST_DATABASE_URL)$/;

  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory())
        return name === 'node_modules' ? [] : files(path);
      return /\.ts$/.test(name) && !/\.spec\.ts$/.test(name) ? [path] : [];
    });
  }

  it('no source file reads env.HELPDESK_* directly, and every name read anywhere is declared', () => {
    const direct: string[] = [];
    for (const file of ROOTS.flatMap(files)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(
        /env(?:\.|\[['"])(HELPDESK_[A-Z0-9_]+)/g,
      )) {
        if (NOT_SETTINGS.test(match[1])) continue;
        direct.push(`${relative(SERVER, file)}: ${match[1]}`);
      }
    }
    expect(direct).toEqual([]);
    for (const name of declared) expect(name).toMatch(/^HELPDESK_/);
  });
});

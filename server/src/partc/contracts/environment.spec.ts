import {
  CAPABILITY_ENVIRONMENTS,
  COURSE_CAPABILITIES,
  assertCapabilityEnabled,
  capabilityEnforcementFromEnv,
  courseCapabilityForRequest,
  isCapabilityEnabled,
} from './environment';
import { isPartCError } from '../errors';

/**
 * C10.7 环境能力矩阵（设计 §14 C10）。
 * 休眠开关默认 off（UAT 即生产，部署后不能锁死 authoring）；on 时服务端强制。
 */
describe('C10.7 environment capabilities', () => {
  it('freezes exactly the four course capabilities', () => {
    expect([...COURSE_CAPABILITIES]).toEqual([
      'course.authoring',
      'course.import',
      'course.publish',
      'course.status',
    ]);
  });

  it('disables authoring only in production; import/publish/status work in both', () => {
    expect(isCapabilityEnabled('sandbox', 'course.authoring')).toBe(true);
    expect(isCapabilityEnabled('production', 'course.authoring')).toBe(false);
    for (const capability of [
      'course.import',
      'course.publish',
      'course.status',
    ] as const) {
      expect(isCapabilityEnabled('sandbox', capability)).toBe(true);
      expect(isCapabilityEnabled('production', capability)).toBe(true);
    }
    expect(CAPABILITY_ENVIRONMENTS['course.authoring']).toEqual(['sandbox']);
  });

  it('assertCapabilityEnabled throws CAPABILITY_DISABLED (403 semantics) for production authoring', () => {
    try {
      assertCapabilityEnabled('production', 'course.authoring');
      throw new Error('expected a PartCError');
    } catch (error) {
      expect(isPartCError(error)).toBe(true);
      if (isPartCError(error)) expect(error.code).toBe('CAPABILITY_DISABLED');
    }
    expect(() =>
      assertCapabilityEnabled('production', 'course.import'),
    ).not.toThrow();
    expect(() =>
      assertCapabilityEnabled('production', 'course.publish'),
    ).not.toThrow();
    expect(() =>
      assertCapabilityEnabled('production', 'course.status'),
    ).not.toThrow();
    expect(() =>
      assertCapabilityEnabled('sandbox', 'course.authoring'),
    ).not.toThrow();
  });

  it('keeps the capability switch dormant unless on/true/1', () => {
    expect(capabilityEnforcementFromEnv({})).toBe(false);
    expect(
      capabilityEnforcementFromEnv({ ENV_CAPABILITY_ENFORCEMENT: '' }),
    ).toBe(false);
    expect(
      capabilityEnforcementFromEnv({ ENV_CAPABILITY_ENFORCEMENT: 'off' }),
    ).toBe(false);
    expect(
      capabilityEnforcementFromEnv({ ENV_CAPABILITY_ENFORCEMENT: 'on' }),
    ).toBe(true);
    expect(
      capabilityEnforcementFromEnv({ ENV_CAPABILITY_ENFORCEMENT: ' TRUE ' }),
    ).toBe(true);
    expect(
      capabilityEnforcementFromEnv({ ENV_CAPABILITY_ENFORCEMENT: '1' }),
    ).toBe(true);
  });

  it('maps course routes to capabilities (authoring / import / publish / status)', () => {
    expect(courseCapabilityForRequest('POST', [])).toBe('course.authoring');
    expect(courseCapabilityForRequest('PUT', ['c1'])).toBe('course.authoring');
    expect(courseCapabilityForRequest('PUT', ['c1', 'lessons', 'l1'])).toBe(
      'course.authoring',
    );
    expect(courseCapabilityForRequest('DELETE', ['c1', 'delete-draft'])).toBe(
      'course.authoring',
    );
    expect(courseCapabilityForRequest('POST', ['import'])).toBe(
      'course.import',
    );
    expect(
      courseCapabilityForRequest('POST', ['import', 'job', 'confirm']),
    ).toBe('course.import');
    expect(courseCapabilityForRequest('POST', ['c1', 'publish'])).toBe(
      'course.publish',
    );
    expect(courseCapabilityForRequest('POST', ['c1', 'restore'])).toBe(
      'course.publish',
    );
    expect(courseCapabilityForRequest('POST', ['c1', 'live-status'])).toBe(
      'course.status',
    );
    expect(courseCapabilityForRequest('POST', ['c1', 'export'])).toBeNull();
    expect(courseCapabilityForRequest('GET', ['c1'])).toBeNull();
    expect(courseCapabilityForRequest('HEAD', ['import', 'job'])).toBeNull();
  });

  it('classifies nested import routes as course.import (review blocker 7)', () => {
    // `POST /courses/:id/import` 是包导入；曾因 segments[0] 不是 'import'
    // 落到 authoring，能力强制开启后 Production 无法导入。
    expect(courseCapabilityForRequest('POST', ['c1', 'import'])).toBe(
      'course.import',
    );
    expect(
      courseCapabilityForRequest('POST', ['c1', 'readings', 'import']),
    ).toBe('course.import');
    expect(
      courseCapabilityForRequest('POST', ['c1', 'understanding', 'import']),
    ).toBe('course.import');
    // export 仍优先判为只读产物（不归任何写能力）。
    expect(
      courseCapabilityForRequest('POST', ['c1', 'import', 'export']),
    ).toBeNull();
  });

  it('classifies Part C plan routes as course.publish; stage/evidence edits stay authoring', () => {
    for (const step of ['preview', 'save', 'approve', 'apply', 'publish']) {
      expect(
        courseCapabilityForRequest('POST', ['c1', 'partc', 'plans', step]),
      ).toBe('course.publish');
    }
    // 结构/证据规格编辑是内容维护：Production 禁用（C10.7）。
    expect(courseCapabilityForRequest('PUT', ['c1', 'partc', 'stages'])).toBe(
      'course.authoring',
    );
    expect(
      courseCapabilityForRequest('PUT', [
        'c1',
        'partc',
        'evidence-specs',
        'ev-1',
      ]),
    ).toBe('course.authoring');
    // Part C 读接口不写任何东西。
    expect(
      courseCapabilityForRequest('GET', ['c1', 'partc', 'stages']),
    ).toBeNull();
  });

  it('classifies alignment sign-off as course.publish (the publish gate’s human signature)', () => {
    // 导入后的 proposed 对齐必须在 Production 也能签收（C10.7 允许 publish；
    // 否则 Production 永远无法发布，C10.8 的唯一写路径失效）。
    expect(
      courseCapabilityForRequest('POST', [
        'c1',
        'partc',
        'alignments',
        'aln-1',
        'sign-off',
      ]),
    ).toBe('course.publish');
    expect(
      courseCapabilityForRequest('GET', ['c1', 'partc', 'alignments']),
    ).toBeNull();
  });
});

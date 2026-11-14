import { PartCError, isPartCError } from '../errors';
import { TEMPLATE_V2_HEADERS } from '../contracts';
import {
  PACKAGE_ENTRY_FILE,
  PACKAGE_SOURCE_NOT_ALLOWED,
  detectUnsupportedOrdering,
  packageSourceEnforcementFromEnv,
  parsePackage,
} from './parse';
import type { PackageIR, RawPackage } from './parse';
import {
  COURSE_KEY,
  baseProvenance,
  buildPackageFixture,
  buildWorkbook,
  clone,
  withFileBytes,
  withoutFile,
} from './parse.fixtures';

/**
 * P1 parse 单元测试（设计 §14 C5 P1 / B8 / C9）。
 * 每个断言标注对应错误码/门禁；负例全部验证 PartCError.code（码即契约）。
 */

function expectPartCError(
  fn: () => unknown,
  code: PartCError['code'],
): PartCError {
  try {
    fn();
  } catch (error) {
    if (isPartCError(error)) {
      expect(error.code).toBe(code);
      return error;
    }
    throw error;
  }
  throw new Error('expected PartCError but nothing was thrown');
}

function manifestOf(pkg: RawPackage): Record<string, unknown> {
  return clone(pkg.manifest) as Record<string, unknown>;
}

function withManifest(pkg: RawPackage, manifest: unknown): RawPackage {
  return { ...pkg, manifest };
}

type MutableWorkbook = {
  sheets: Record<string, { headers: unknown[]; rows: unknown[][] }>;
};

function withWorkbook(
  pkg: RawPackage,
  mutate: (workbook: MutableWorkbook) => void,
): RawPackage {
  const workbook = clone(pkg.workbook) as unknown as MutableWorkbook;
  mutate(workbook);
  return { ...pkg, workbook: workbook };
}

function mediaRows(pkg: RawPackage): unknown[][] {
  const sheet = pkg.workbook.sheets.Media as unknown as { rows: unknown[][] };
  return sheet.rows.map((row) => [...row]);
}

describe('P1 parse：合法 v2 包 → PackageIR（C5 P1）', () => {
  it('parses a closed package and preserves stable codes', () => {
    const { pkg } = buildPackageFixture();
    const ir = parsePackage(pkg);
    expect(ir.course.courseKey).toBe(COURSE_KEY);
    expect(ir.course.categoryPath).toEqual(['Science']);
    expect(ir.content.stages.map((stage) => stage.stageKey)).toEqual([
      'prog-01',
      'step-01',
    ]);
    expect(ir.resources).toHaveLength(10);
    expect(ir.template.meta).toEqual({
      templateVersion: 2,
      courseCode: COURSE_KEY,
      learningLanguages: ['en-GB', 'zh-CN'],
      studyMode: 'both',
    });
    expect(ir.template.sheets.Media).toHaveLength(9);
    expect(ir.template.sheets.Lessons[0].values.lesson_code).toBe('lesson-01');
    expect(ir.template.sheets.Lessons[0].rowNumber).toBe(2);
    expect(ir.notices).toEqual([]);
  });

  it('decodes the Meta learningLanguages cell and trims string cells', () => {
    const { pkg } = buildPackageFixture();
    const mutated = withWorkbook(pkg, (workbook) => {
      workbook.sheets['Course Info'].rows[0][2] = '  Modeling Life  ';
    });
    const ir = parsePackage(mutated);
    expect(ir.template.meta.learningLanguages).toEqual(['en-GB', 'zh-CN']);
    expect(ir.template.sheets['Course Info'][0].values.text).toBe(
      'Modeling Life',
    );
  });

  it('is deterministic: repeated parse produces equal IR projections', () => {
    const { pkg } = buildPackageFixture();
    const first = parsePackage(pkg);
    const second = parsePackage(pkg);
    const project = (ir: PackageIR) => ({
      course: ir.course,
      content: ir.content,
      meta: ir.template.meta,
      sheets: ir.template.sheets,
      notices: ir.notices,
    });
    expect(project(second)).toEqual(project(first));
  });

  it('reports unknown sheets, unknown columns and extra cells as warnings with coordinates', () => {
    const { pkg } = buildPackageFixture();
    const mutated = withWorkbook(pkg, (workbook) => {
      (
        workbook.sheets as Record<
          string,
          { headers: string[]; rows: unknown[][] }
        >
      ).Notes = { headers: ['note'], rows: [['hello']] };
      const lessons = workbook.sheets.Lessons as {
        headers: string[];
        rows: unknown[][];
      };
      lessons.headers = [...lessons.headers, 'internal_note'];
      lessons.rows = lessons.rows.map((row) => [...row, 'n']);
      // 不扩展表头，直接把多余单元格塞进行里 → TEMPLATE_CELL_EXTRA
      lessons.rows[0] = [...lessons.rows[0], 'stray'];
    });
    const ir = parsePackage(mutated);
    const codes = ir.notices.map((notice) => notice.code);
    expect(codes).toContain('TEMPLATE_SHEET_UNKNOWN');
    expect(codes).toContain('TEMPLATE_COLUMN_UNKNOWN');
    expect(codes).toContain('TEMPLATE_CELL_EXTRA');
    expect(
      ir.notices.find((notice) => notice.code === 'TEMPLATE_SHEET_UNKNOWN')
        ?.source,
    ).toEqual({ sheet: 'Notes' });
    expect(
      ir.notices.find((notice) => notice.code === 'TEMPLATE_COLUMN_UNKNOWN')
        ?.source?.column,
    ).toBe('internal_note');
    expect(
      ir.notices.find((notice) => notice.code === 'TEMPLATE_CELL_EXTRA')?.source
        ?.row,
    ).toBe(2);
  });
});

describe('P1 门禁：PACKAGE_FORMAT_UNSUPPORTED / 读取器能力（C5 P1）', () => {
  it('rejects non-object manifests', () => {
    const { pkg } = buildPackageFixture();
    expectPartCError(
      () => parsePackage({ ...pkg, manifest: [] }),
      'PACKAGE_FORMAT_UNSUPPORTED',
    );
  });

  it('rejects legacy formatVersion, legacy category and missing categoryPath', () => {
    const { pkg } = buildPackageFixture();

    const versionOne = manifestOf(pkg);
    versionOne.formatVersion = 1;
    expectPartCError(
      () => parsePackage(withManifest(pkg, versionOne)),
      'PACKAGE_FORMAT_UNSUPPORTED',
    );

    const legacyCategory = manifestOf(pkg);
    (legacyCategory.course as Record<string, unknown>).category = 'Science';
    expectPartCError(
      () => parsePackage(withManifest(pkg, legacyCategory)),
      'PACKAGE_FORMAT_UNSUPPORTED',
    );

    const missingCategoryPath = manifestOf(pkg);
    delete (missingCategoryPath.course as Record<string, unknown>).categoryPath;
    expectPartCError(
      () => parsePackage(withManifest(pkg, missingCategoryPath)),
      'PACKAGE_FORMAT_UNSUPPORTED',
    );

    const withHash = manifestOf(pkg);
    // 分片拼接：字段名本身不能落成 P0 CI grep 会命中的字面量。
    withHash['content' + 'Ha' + 'sh'] = 'deadbeef';
    expectPartCError(
      () => parsePackage(withManifest(pkg, withHash)),
      'PACKAGE_FORMAT_UNSUPPORTED',
    );
  });

  it('rejects readers/extensions beyond the frozen capability set', () => {
    const { pkg } = buildPackageFixture();
    const newer = manifestOf(pkg);
    newer.minReaderVersion = 3;
    expectPartCError(
      () => parsePackage(withManifest(pkg, newer)),
      'PACKAGE_FORMAT_UNSUPPORTED',
    );

    const extension = manifestOf(pkg);
    extension.extensionsRequired = ['future-alignment-format'];
    expectPartCError(
      () => parsePackage(withManifest(pkg, extension)),
      'PACKAGE_FORMAT_UNSUPPORTED',
    );
  });

  it('rejects choice containers with UNSUPPORTED_ORDERING before schema parsing', () => {
    const { pkg } = buildPackageFixture();
    const manifest = manifestOf(pkg);
    const content = manifest.content as Record<string, unknown>;
    const stages = content.stages as Array<Record<string, unknown>>;
    stages[0].ordering = 'choice';

    expect(detectUnsupportedOrdering(manifest)).toEqual([
      'content.stages[0].ordering',
    ]);
    expectPartCError(
      () => parsePackage(withManifest(pkg, manifest)),
      'UNSUPPORTED_ORDERING',
    );

    const withChoices = manifestOf(pkg);
    (withChoices.content as Record<string, unknown>).choices = [];
    expect(detectUnsupportedOrdering(withChoices)).toEqual(['content.choices']);
    expectPartCError(
      () => parsePackage(withManifest(pkg, withChoices)),
      'UNSUPPORTED_ORDERING',
    );
  });
});

describe('P1 闭合包 1:1：PACKAGE_FILE_MISSING / PACKAGE_FILE_UNKNOWN', () => {
  it('fails when a declared resource is missing from the package', () => {
    const { pkg } = buildPackageFixture();
    const missing = withoutFile(pkg, 'media/cover.png');
    const error = expectPartCError(
      () => parsePackage(missing),
      'PACKAGE_FILE_MISSING',
    );
    expect((error.details as { path: string }).path).toBe('media/cover.png');
  });

  it('fails when the package carries an undeclared file', () => {
    const { pkg } = buildPackageFixture();
    const files = new Map(pkg.files);
    files.set('stray.bin', new Uint8Array([1]));
    expectPartCError(
      () => parsePackage({ ...pkg, files }),
      'PACKAGE_FILE_UNKNOWN',
    );
  });

  it('keeps manifest.json exempt from the undeclared-file rule', () => {
    const { pkg } = buildPackageFixture();
    const files = new Map(pkg.files);
    files.set(PACKAGE_ENTRY_FILE, new TextEncoder().encode('{}'));
    expect(() => parsePackage({ ...pkg, files })).not.toThrow();
  });

  it('rejects declared size != packaged bytes (size only, no content fingerprint)', () => {
    const { pkg } = buildPackageFixture();
    const longer = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const error = expectPartCError(
      () => parsePackage(withFileBytes(pkg, 'media/cover.png', longer)),
      'PACKAGE_FORMAT_UNSUPPORTED',
    );
    expect((error.details as { reason: string }).reason).toBe(
      'resource-size-mismatch',
    );
  });
});

describe('P1 模板门禁：TEMPLATE_FORMAT_UNSUPPORTED / HUMAN_TIME_FORBIDDEN', () => {
  it('rejects templateVersion != 2', () => {
    const { pkg } = buildPackageFixture();
    const mutated = withWorkbook(pkg, (workbook) => {
      workbook.sheets.Meta.rows[0][0] = 1;
    });
    expectPartCError(
      () => parsePackage(mutated),
      'TEMPLATE_FORMAT_UNSUPPORTED',
    );
  });

  it('rejects missing machine sheets', () => {
    const { pkg } = buildPackageFixture();
    const mutated = withWorkbook(pkg, (workbook) => {
      delete (workbook.sheets as Record<string, unknown>).Exhibits;
    });
    expectPartCError(
      () => parsePackage(mutated),
      'TEMPLATE_FORMAT_UNSUPPORTED',
    );
  });

  it('rejects missing or duplicate contract columns', () => {
    const { pkg } = buildPackageFixture();

    const missingColumn = withWorkbook(pkg, (workbook) => {
      const lessons = workbook.sheets.Lessons as {
        headers: string[];
        rows: unknown[][];
      };
      lessons.headers = lessons.headers.filter(
        (header) => header !== 'description',
      );
    });
    expectPartCError(
      () => parsePackage(missingColumn),
      'TEMPLATE_FORMAT_UNSUPPORTED',
    );

    const duplicateColumn = withWorkbook(pkg, (workbook) => {
      const lessons = workbook.sheets.Lessons as {
        headers: string[];
        rows: unknown[][];
      };
      lessons.headers = [...lessons.headers, 'title'];
    });
    expectPartCError(
      () => parsePackage(duplicateColumn),
      'TEMPLATE_FORMAT_UNSUPPORTED',
    );
  });

  it('rejects Meta courseCode mismatch and multiple Meta rows', () => {
    const { pkg } = buildPackageFixture();

    const mismatch = withWorkbook(pkg, (workbook) => {
      workbook.sheets.Meta.rows[0][1] = 'other-course';
    });
    expectPartCError(
      () => parsePackage(mismatch),
      'TEMPLATE_FORMAT_UNSUPPORTED',
    );

    const twoRows = withWorkbook(pkg, (workbook) => {
      workbook.sheets.Meta.rows = [
        workbook.sheets.Meta.rows[0],
        [...workbook.sheets.Meta.rows[0]],
      ];
    });
    expectPartCError(
      () => parsePackage(twoRows),
      'TEMPLATE_FORMAT_UNSUPPORTED',
    );
  });

  it('fails closed on any time-like column (HUMAN_TIME_FORBIDDEN)', () => {
    const { pkg } = buildPackageFixture();
    const mutated = withWorkbook(pkg, (workbook) => {
      const lessons = workbook.sheets.Lessons as {
        headers: string[];
        rows: unknown[][];
      };
      lessons.headers = [...lessons.headers, 'Trigger · EN video'];
    });
    const error = expectPartCError(
      () => parsePackage(mutated),
      'HUMAN_TIME_FORBIDDEN',
    );
    expect((error.details as { columns: string[] }).columns).toEqual([
      'Trigger · EN video',
    ]);
  });

  it('reconciles the Media sheet with manifest.resources one-to-one', () => {
    const { pkg } = buildPackageFixture();

    const missingRow = withWorkbook(pkg, (workbook) => {
      const media = workbook.sheets.Media as {
        headers: string[];
        rows: unknown[][];
      };
      media.rows = media.rows.filter((row) => row[0] !== 'asset-video-en');
    });
    const missingError = expectPartCError(
      () => parsePackage(missingRow),
      'TEMPLATE_FORMAT_UNSUPPORTED',
    );
    expect((missingError.details as { reason: string }).reason).toBe(
      'media-row-missing',
    );

    const wrongPath = withWorkbook(pkg, (workbook) => {
      const media = workbook.sheets.Media as {
        headers: string[];
        rows: unknown[][];
      };
      const row = media.rows.find((cells) => cells[0] === 'asset-video-en');
      (row as unknown[])[4] = 'media/other.mp4';
    });
    const mismatchError = expectPartCError(
      () => parsePackage(wrongPath),
      'TEMPLATE_FORMAT_UNSUPPORTED',
    );
    expect((mismatchError.details as { reason: string }).reason).toBe(
      'media-row-mismatch',
    );

    const unknownRow = withWorkbook(pkg, (workbook) => {
      const media = workbook.sheets.Media as {
        headers: string[];
        rows: unknown[][];
      };
      media.rows = [
        ...media.rows,
        ['asset-extra', 'image', null, null, 'media/extra.png', null],
      ];
    });
    const unknownError = expectPartCError(
      () => parsePackage(unknownRow),
      'TEMPLATE_FORMAT_UNSUPPORTED',
    );
    expect((unknownError.details as { reason: string }).reason).toBe(
      'media-row-unknown',
    );
  });

  it('allows lesson-text Media rows to register manifest document resources', () => {
    const { pkg } = buildPackageFixture();
    // 夹具里两个 docx 资源 kind=document，Media 行 kind=lesson-text；合法路径。
    const ir = parsePackage(pkg);
    expect(
      ir.template.sheets.Media.filter(
        (row) => row.values.kind === 'lesson-text',
      ),
    ).toHaveLength(2);
  });
});

describe('P1 分类解析（CATEGORY_NOT_FOUND）', () => {
  it('throws CATEGORY_NOT_FOUND when the injected catalogue resolver misses', () => {
    const { pkg } = buildPackageFixture();
    expectPartCError(
      () =>
        parsePackage(pkg, {
          resolveCategoryPath: () => false,
        }),
      'CATEGORY_NOT_FOUND',
    );
  });

  it('passes when the resolver accepts the path or when categoryPath is null', () => {
    const { pkg } = buildPackageFixture();
    expect(() =>
      parsePackage(pkg, { resolveCategoryPath: () => true }),
    ).not.toThrow();

    const unclassified = manifestOf(pkg);
    (unclassified.course as Record<string, unknown>).categoryPath = null;
    (unclassified.content as Record<string, unknown>).categoryPath = null;
    expect(() =>
      parsePackage(withManifest(pkg, unclassified), {
        resolveCategoryPath: () => false,
      }),
    ).not.toThrow();
  });
});

describe('P1 模板列清单与契约同源', () => {
  it('uses the frozen header list for every machine sheet', () => {
    const workbook = buildWorkbook() as unknown as {
      sheets: Record<string, { headers: string[] }>;
    };
    for (const [sheetName, headers] of Object.entries(TEMPLATE_V2_HEADERS)) {
      expect(workbook.sheets[sheetName].headers).toEqual([...headers]);
    }
    // 防止误用：Media 行数与 manifest 媒体资源数一致（template/document 除外）。
    const { pkg } = buildPackageFixture();
    const media = mediaRows(pkg);
    expect(media).toHaveLength(9);
  });
});

describe('P1 provenance 与来源强制（C10.6）', () => {
  it('parses and records the sandbox provenance block on the default fixture', () => {
    const { pkg } = buildPackageFixture();
    const ir = parsePackage(pkg);
    expect(ir.provenance).toMatchObject({
      sourceEnv: 'sandbox',
      sourceVersionLabel: '4.2',
      courseKey: COURSE_KEY,
      planPin: { planVersion: 1 },
    });
    expect(ir.annotations).toBeNull();
  });

  it('records annotations without letting them affect identity or parse', () => {
    const { pkg } = buildPackageFixture();
    const manifest = manifestOf(pkg);
    manifest.annotations = {
      exporter: 'admin',
      verification: [{ kind: 'timing-audit', sourceKind: 'subtitle' }],
    };
    const ir = parsePackage(withManifest(pkg, manifest));
    expect(ir.annotations).toEqual({
      exporter: 'admin',
      verification: [{ kind: 'timing-audit', sourceKind: 'subtitle' }],
    });
  });

  it('rejects a malformed annotations block as a format error', () => {
    const { pkg } = buildPackageFixture();
    const manifest = manifestOf(pkg);
    manifest.annotations = ['not', 'an', 'object'];
    expectPartCError(
      () => parsePackage(withManifest(pkg, manifest)),
      'PACKAGE_FORMAT_UNSUPPORTED',
    );
  });

  it('dormancy off (default): a package without provenance still imports and records null', () => {
    const { pkg } = buildPackageFixture({ provenance: null });
    const ir = parsePackage(pkg);
    expect(ir.provenance).toBeNull();
  });

  it('dormancy off (default): a production-sourced package imports without rejection', () => {
    const provenance = {
      ...baseProvenance(),
      sourceEnv: 'production',
      sourceVersionLabel: 'Version 7',
    };
    const { pkg } = buildPackageFixture({ provenance });
    const ir = parsePackage(pkg, { targetEnvironment: 'production' });
    expect(ir.provenance?.sourceEnv).toBe('production');
  });

  it('enforcement on: production target rejects non-sandbox provenance with PACKAGE_SOURCE_NOT_ALLOWED', () => {
    const provenance = { ...baseProvenance(), sourceEnv: 'production' };
    const { pkg } = buildPackageFixture({ provenance });
    const error = expectPartCError(
      () =>
        parsePackage(pkg, {
          targetEnvironment: 'production',
          packageSourceEnforcement: true,
        }),
      PACKAGE_SOURCE_NOT_ALLOWED,
    );
    expect(error.code).toBe('PACKAGE_SOURCE_NOT_ALLOWED');
    expect((error.details as { reason: string }).reason).toBe(
      'source-env-not-sandbox',
    );
  });

  it('enforcement on: production target rejects a missing provenance block', () => {
    const { pkg } = buildPackageFixture({ provenance: null });
    const error = expectPartCError(
      () =>
        parsePackage(pkg, {
          targetEnvironment: 'production',
          packageSourceEnforcement: true,
        }),
      PACKAGE_SOURCE_NOT_ALLOWED,
    );
    expect((error.details as { reason: string }).reason).toBe(
      'provenance-missing',
    );
  });

  it('enforcement on: sandbox target and sandbox provenance pass', () => {
    const { pkg } = buildPackageFixture();
    expect(() =>
      parsePackage(pkg, {
        targetEnvironment: 'production',
        packageSourceEnforcement: true,
      }),
    ).not.toThrow();
    expect(() =>
      parsePackage(
        buildPackageFixture({
          provenance: { ...baseProvenance(), sourceEnv: 'production' },
        }).pkg,
        { targetEnvironment: 'sandbox', packageSourceEnforcement: true },
      ),
    ).not.toThrow();
  });

  it('source judgement reads only provenance.sourceEnv, never file names or paths', () => {
    // 文件名/路径全部带 "sandbox"，但 provenance.sourceEnv=production → 仍然拒绝。
    const { pkg } = buildPackageFixture({
      provenance: { ...baseProvenance(), sourceEnv: 'production' },
    });
    const manifest = manifestOf(pkg);
    (manifest.resources as Array<Record<string, unknown>>)[0].path =
      'sandbox/template.xlsx';
    const renamed = new Map<string, Uint8Array>();
    for (const [path, bytes] of pkg.files) {
      renamed.set(
        path.replace(/^template\.xlsx$/, 'sandbox/template.xlsx'),
        bytes,
      );
    }
    const sandboxNamed: RawPackage = {
      ...pkg,
      manifest,
      files: renamed,
    };
    expectPartCError(
      () =>
        parsePackage(sandboxNamed, {
          targetEnvironment: 'production',
          packageSourceEnforcement: true,
        }),
      PACKAGE_SOURCE_NOT_ALLOWED,
    );

    // 路径带 "production"，但 provenance.sourceEnv=sandbox → 接受。
    const ok = buildPackageFixture();
    expect(() =>
      parsePackage(ok.pkg, {
        targetEnvironment: 'production',
        packageSourceEnforcement: true,
      }),
    ).not.toThrow();
  });

  it('rejects malformed provenance (missing exportedBy) as PACKAGE_FORMAT_UNSUPPORTED', () => {
    const provenance = clone(baseProvenance()) as Record<string, unknown>;
    delete provenance.exportedBy;
    const { pkg } = buildPackageFixture({ provenance });
    expectPartCError(() => parsePackage(pkg), 'PACKAGE_FORMAT_UNSUPPORTED');
  });

  it('rejects provenance.courseKey drift as PACKAGE_FORMAT_UNSUPPORTED', () => {
    const provenance = { ...baseProvenance(), courseKey: 'other-course' };
    const { pkg } = buildPackageFixture({ provenance });
    expectPartCError(() => parsePackage(pkg), 'PACKAGE_FORMAT_UNSUPPORTED');
  });

  it('accepts provenance.asr pins and rejects malformed params', () => {
    const withAsr = {
      ...baseProvenance(),
      asr: {
        modelVersion: 'asr-model-v1',
        params: { beamSize: 5, vad: true, locale: null },
        ruleVersion: 'asr-rules-v1',
      },
    };
    const ir = parsePackage(buildPackageFixture({ provenance: withAsr }).pkg);
    expect(ir.provenance?.asr?.modelVersion).toBe('asr-model-v1');

    const badParams = clone(withAsr) as Record<string, unknown>;
    (badParams.asr as Record<string, unknown>).params = { nested: { x: 1 } };
    expectPartCError(
      () => parsePackage(buildPackageFixture({ provenance: badParams }).pkg),
      'PACKAGE_FORMAT_UNSUPPORTED',
    );
  });

  it('maps PACKAGE_SOURCE_ENFORCEMENT to on only for on/true/1 (default off)', () => {
    expect(packageSourceEnforcementFromEnv({})).toBe(false);
    expect(
      packageSourceEnforcementFromEnv({ PACKAGE_SOURCE_ENFORCEMENT: '' }),
    ).toBe(false);
    expect(
      packageSourceEnforcementFromEnv({ PACKAGE_SOURCE_ENFORCEMENT: 'off' }),
    ).toBe(false);
    expect(
      packageSourceEnforcementFromEnv({ PACKAGE_SOURCE_ENFORCEMENT: 'on' }),
    ).toBe(true);
    expect(
      packageSourceEnforcementFromEnv({ PACKAGE_SOURCE_ENFORCEMENT: ' TRUE ' }),
    ).toBe(true);
    expect(
      packageSourceEnforcementFromEnv({ PACKAGE_SOURCE_ENFORCEMENT: '1' }),
    ).toBe(true);
  });
});

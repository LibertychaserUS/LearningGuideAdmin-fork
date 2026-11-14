import type { z } from 'zod';
import {
  COURSE_INFO_FIELDS,
  EVIDENCE_KINDS,
  TemplateApplicationTestRowSchema,
  TemplateCourseInfoRowSchema,
  TemplateExhibitRowSchema,
  TemplateKnowledgeTestRowSchema,
  TemplateLearningPointRowSchema,
  TemplateLessonRowSchema,
  TemplateMediaRowSchema,
  TemplateReadingRowSchema,
} from '../contracts';
import type {
  ContentVersionContent,
  EvidenceSpec,
  PackageManifestV2,
  Rendition,
  Stage,
  TemplateV2SheetName,
} from '../contracts';
import type {
  CompilerIssue,
  CompilerIssueCode,
  IssueSeverity,
  PackageIR,
  SourceCoordinate,
  TemplateMetaRow,
} from './parse';

export { detectUnsupportedOrdering } from './parse';

/**
 * Part C 编译器 P2：PackageIR → 全量静态校验（设计 §14 C5 P2、C4）。
 *
 * 一个语义一个检查器：本模块是导入端、导出端（生产端）共用的唯一校验器；
 * 后续阶段（deriveTiming/align/plan/apply）只消费这里产出的 ValidatedRows 与
 * issues，不再各写一套判断。
 *
 * 严重级（C5 P2）：
 * - error：整包拒绝（原子），不产生任何写入；
 * - incomplete：允许入库为草稿，阻止发布（缺语言、缺证据规格）；
 * - warning：入报告，不静默。
 *
 * 每条 issue 都带源坐标：模板行 = {sheet,row,column}（行号 1 基，表头为第 1 行）；
 * manifest.content 结构 = {path}（JSON 指针形态）。
 *
 * 覆盖：行级 schema/枚举、code 唯一、引用双向覆盖、语言完整性、course/Meta 一致性、
 * STR-1 包含森林、STR-2 交付序无环、STR-4 证据封闭/rollup 可满足、STR-5 证据绑定
 * （incomplete）、STR-7 先修、choice 拒绝（UNSUPPORTED_ORDERING，parse 边界执行，
 * 本模块导出同一检查器供报告与测试）。
 */

export type CourseInfoRow = z.infer<typeof TemplateCourseInfoRowSchema>;
export type LessonRow = z.infer<typeof TemplateLessonRowSchema>;
export type LearningPointRow = z.infer<typeof TemplateLearningPointRowSchema>;
export type ExhibitRow = z.infer<typeof TemplateExhibitRowSchema>;
export type ReadingRow = z.infer<typeof TemplateReadingRowSchema>;
export type KnowledgeTestRow = z.infer<typeof TemplateKnowledgeTestRowSchema>;
export type ApplicationTestRow = z.infer<
  typeof TemplateApplicationTestRowSchema
>;
export type MediaRow = z.infer<typeof TemplateMediaRowSchema>;

export interface TypedRow<T> {
  readonly rowNumber: number;
  readonly value: T;
}

/** validate 产出的强类型行（只含 schema 通过的行；失败行以 issue 报告）。 */
export interface ValidatedRows {
  readonly meta: TemplateMetaRow;
  readonly courseInfo: readonly TypedRow<CourseInfoRow>[];
  readonly lessons: readonly TypedRow<LessonRow>[];
  readonly learningPoints: readonly TypedRow<LearningPointRow>[];
  readonly exhibits: readonly TypedRow<ExhibitRow>[];
  readonly readings: readonly TypedRow<ReadingRow>[];
  readonly knowledgeTests: readonly TypedRow<KnowledgeTestRow>[];
  readonly applicationTests: readonly TypedRow<ApplicationTestRow>[];
  readonly media: readonly TypedRow<MediaRow>[];
}

export interface ValidationResult {
  readonly rows: ValidatedRows;
  readonly issues: readonly CompilerIssue[];
}

/** 阻断级错误 → 整包拒绝（C5 P2）。 */
export function hasBlockingErrors(issues: readonly CompilerIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}

/** incomplete → 可入库、阻止发布。 */
export function hasIncomplete(issues: readonly CompilerIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'incomplete');
}

const METADATA_LOCALES = ['en-GB', 'zh-CN'] as const;

/** 编译器派生占用的 blockId；模板 exhibit code 不得与之冲突（P4 派生确定）。 */
const RESERVED_BLOCK_IDS: ReadonlySet<string> = new Set([
  'video',
  'body',
  'application',
]);
const RESERVED_BLOCK_ID_PATTERN = /^q\.\d+$/;
const RESERVED_READING_BLOCK_ID_PATTERN = /^reading\.\d+$/;

// ---------------------------------------------------------------------------
// issue 构造
// ---------------------------------------------------------------------------

function makeIssue(
  severity: IssueSeverity,
  code: CompilerIssueCode,
  message: string,
  source: SourceCoordinate | undefined,
  details?: Record<string, unknown>,
  invariant?: string,
): CompilerIssue {
  return { severity, code, message, invariant, source, details };
}

function rowSource(
  sheet: string,
  row: TypedRow<unknown> | { rowNumber: number },
  column?: string,
): SourceCoordinate {
  return { sheet, row: row.rowNumber, column };
}

// ---------------------------------------------------------------------------
// 行级 schema
// ---------------------------------------------------------------------------

function parseSheetRows<Shape extends z.ZodType>(
  sheetName: TemplateV2SheetName,
  ir: PackageIR,
  schema: Shape,
  issues: CompilerIssue[],
): TypedRow<z.infer<Shape>>[] {
  const out: TypedRow<z.infer<Shape>>[] = [];
  for (const row of ir.template.sheets[sheetName]) {
    const parsed = schema.safeParse(row.values);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const column =
        first !== undefined && typeof first.path[0] === 'string'
          ? String(first.path[0])
          : undefined;
      issues.push(
        makeIssue(
          'error',
          'TEMPLATE_ROW_INVALID',
          'template row does not satisfy the v2 machine contract',
          { sheet: sheetName, row: row.rowNumber, column },
          {
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.map(String).join('.'),
              code: issue.code,
              message: issue.message,
            })),
          },
        ),
      );
      continue;
    }
    out.push({ rowNumber: row.rowNumber, value: parsed.data });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 主校验
// ---------------------------------------------------------------------------

/** P2 validate：收集全部问题（不 fail-fast），不修改任何输入。 */
export function validatePackage(ir: PackageIR): ValidationResult {
  const issues: CompilerIssue[] = [];

  const rows: ValidatedRows = {
    meta: ir.template.meta,
    courseInfo: parseSheetRows(
      'Course Info',
      ir,
      TemplateCourseInfoRowSchema,
      issues,
    ),
    lessons: parseSheetRows('Lessons', ir, TemplateLessonRowSchema, issues),
    learningPoints: parseSheetRows(
      'Learning Points',
      ir,
      TemplateLearningPointRowSchema,
      issues,
    ),
    exhibits: parseSheetRows('Exhibits', ir, TemplateExhibitRowSchema, issues),
    readings: parseSheetRows(
      'Reading List',
      ir,
      TemplateReadingRowSchema,
      issues,
    ),
    knowledgeTests: parseSheetRows(
      'Knowledge Test',
      ir,
      TemplateKnowledgeTestRowSchema,
      issues,
    ),
    applicationTests: parseSheetRows(
      'Application Test',
      ir,
      TemplateApplicationTestRowSchema,
      issues,
    ),
    media: parseSheetRows('Media', ir, TemplateMediaRowSchema, issues),
  };

  checkCourseMeta(ir, rows, issues);
  checkCodeUniqueness(rows, issues);
  checkReferencesAndLanguages(ir, rows, issues);
  checkMediaBindings(rows, issues);
  checkLanguageCompleteness(ir, rows, issues);
  checkStageInvariants(ir.content, issues);
  checkPins(ir, rows, issues);

  return { rows, issues };
}

// ---------------------------------------------------------------------------
// course / Meta 一致性
// ---------------------------------------------------------------------------

function checkCourseMeta(
  ir: PackageIR,
  rows: ValidatedRows,
  issues: CompilerIssue[],
): void {
  const declared = [...ir.course.learningLanguages].sort();
  const meta = [...rows.meta.learningLanguages].sort();
  if (declared.join('\u0000') !== meta.join('\u0000')) {
    issues.push(
      makeIssue(
        'error',
        'COURSE_META_MISMATCH',
        'Meta learningLanguages must equal manifest course.learningLanguages',
        {
          sheet: 'Meta',
          row: ir.template.metaRowNumber,
          column: 'learningLanguages',
        },
        {
          manifest: ir.course.learningLanguages,
          meta: rows.meta.learningLanguages,
        },
      ),
    );
  }
  if (rows.meta.studyMode !== ir.course.studyMode) {
    issues.push(
      makeIssue(
        'error',
        'COURSE_META_MISMATCH',
        'Meta studyMode must equal manifest course.studyMode',
        { sheet: 'Meta', row: ir.template.metaRowNumber, column: 'studyMode' },
        { manifest: ir.course.studyMode, meta: rows.meta.studyMode },
      ),
    );
  }

  // 元数据本地化恒为 en-GB + zh-CN（B2.6）；缺失 → incomplete，阻止发布。
  const titleLocales = new Set(Object.keys(ir.course.titleLocalized));
  for (const locale of METADATA_LOCALES) {
    if (!titleLocales.has(locale)) {
      issues.push(
        makeIssue(
          'incomplete',
          'LANGUAGE_MISSING',
          'course titleLocalized must carry en-GB and zh-CN metadata',
          { path: 'course.titleLocalized' },
          { locale },
        ),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// code 唯一
// ---------------------------------------------------------------------------

function checkCodeUniqueness(
  rows: ValidatedRows,
  issues: CompilerIssue[],
): void {
  const lessonKeys = new Set<string>();
  for (const row of rows.lessons) {
    const key = `${row.value.lesson_code}\u0000${row.value.language}`;
    if (lessonKeys.has(key)) {
      issues.push(
        makeIssue(
          'error',
          'CODE_DUPLICATE',
          'lesson_code must be unique per language',
          rowSource('Lessons', row, 'lesson_code'),
          { lesson_code: row.value.lesson_code, language: row.value.language },
        ),
      );
    }
    lessonKeys.add(key);
  }

  const lpKeys = new Set<string>();
  for (const row of rows.learningPoints) {
    const key = `${row.value.lesson_code}\u0000${row.value.lp_code}\u0000${row.value.language}`;
    if (lpKeys.has(key)) {
      issues.push(
        makeIssue(
          'error',
          'CODE_DUPLICATE',
          'lp_code must be unique per lesson and language',
          rowSource('Learning Points', row, 'lp_code'),
          {
            lesson_code: row.value.lesson_code,
            lp_code: row.value.lp_code,
            language: row.value.language,
          },
        ),
      );
    }
    lpKeys.add(key);
  }

  const exhibitKeys = new Set<string>();
  const exhibitMediaType = new Map<string, string>();
  for (const row of rows.exhibits) {
    const key = `${row.value.lesson_code}\u0000${row.value.exhibit_code}\u0000${row.value.language}`;
    if (exhibitKeys.has(key)) {
      issues.push(
        makeIssue(
          'error',
          'CODE_DUPLICATE',
          'exhibit_code must be unique per lesson and language',
          rowSource('Exhibits', row, 'exhibit_code'),
          {
            lesson_code: row.value.lesson_code,
            exhibit_code: row.value.exhibit_code,
            language: row.value.language,
          },
        ),
      );
    }
    exhibitKeys.add(key);

    const codeKey = `${row.value.lesson_code}\u0000${row.value.exhibit_code}`;
    const previousType = exhibitMediaType.get(codeKey);
    if (previousType !== undefined && previousType !== row.value.media_type) {
      issues.push(
        makeIssue(
          'error',
          'REFERENCE_UNRESOLVED',
          'exhibit_code must carry the same media_type across languages',
          rowSource('Exhibits', row, 'media_type'),
          {
            lesson_code: row.value.lesson_code,
            exhibit_code: row.value.exhibit_code,
            previousType,
            currentType: row.value.media_type,
          },
        ),
      );
    }
    exhibitMediaType.set(codeKey, row.value.media_type);

    if (
      RESERVED_BLOCK_IDS.has(row.value.exhibit_code) ||
      RESERVED_BLOCK_ID_PATTERN.test(row.value.exhibit_code) ||
      RESERVED_READING_BLOCK_ID_PATTERN.test(row.value.exhibit_code)
    ) {
      issues.push(
        makeIssue(
          'error',
          'CODE_RESERVED',
          'exhibit_code collides with a compiler-reserved blockId',
          rowSource('Exhibits', row, 'exhibit_code'),
          { exhibit_code: row.value.exhibit_code },
        ),
      );
    }
  }

  const mediaKeys = new Set<string>();
  for (const row of rows.media) {
    if (mediaKeys.has(row.value.asset_key)) {
      issues.push(
        makeIssue(
          'error',
          'CODE_DUPLICATE',
          'asset_key must be unique inside the Media sheet',
          rowSource('Media', row, 'asset_key'),
          { asset_key: row.value.asset_key },
        ),
      );
    }
    mediaKeys.add(row.value.asset_key);
  }

  const ktKeys = new Set<string>();
  for (const row of rows.knowledgeTests) {
    const key = `${row.value.lesson_code}\u0000${row.value.order}\u0000${row.value.language}`;
    if (ktKeys.has(key)) {
      issues.push(
        makeIssue(
          'error',
          'CODE_DUPLICATE',
          'knowledge test order must be unique per lesson and language',
          rowSource('Knowledge Test', row, 'order'),
          {
            lesson_code: row.value.lesson_code,
            order: row.value.order,
            language: row.value.language,
          },
        ),
      );
    }
    ktKeys.add(key);
  }

  const atKeys = new Set<string>();
  for (const row of rows.applicationTests) {
    const key = `${row.value.lesson_code}\u0000${row.value.language}`;
    if (atKeys.has(key)) {
      issues.push(
        makeIssue(
          'error',
          'CODE_DUPLICATE',
          'application test must be unique per lesson and language',
          rowSource('Application Test', row, 'lesson_code'),
          {
            lesson_code: row.value.lesson_code,
            language: row.value.language,
          },
        ),
      );
    }
    atKeys.add(key);
  }
}

// ---------------------------------------------------------------------------
// 引用双向覆盖 + 语言声明
// ---------------------------------------------------------------------------

function declaredLanguageSet(ir: PackageIR): Set<string> {
  return new Set(ir.course.learningLanguages);
}

function checkLanguageDeclared(
  language: string,
  declared: ReadonlySet<string>,
  sheet: TemplateV2SheetName,
  row: TypedRow<unknown>,
  issues: CompilerIssue[],
): void {
  if (!declared.has(language)) {
    issues.push(
      makeIssue(
        'error',
        'LANGUAGE_UNDECLARED',
        'row language is not declared in course.learningLanguages',
        rowSource(sheet, row, 'language'),
        { language },
      ),
    );
  }
}

function checkReferencesAndLanguages(
  ir: PackageIR,
  rows: ValidatedRows,
  issues: CompilerIssue[],
): void {
  const lessonCodes = new Set(rows.lessons.map((row) => row.value.lesson_code));
  const declared = declaredLanguageSet(ir);

  for (const row of rows.lessons) {
    checkLanguageDeclared(row.value.language, declared, 'Lessons', row, issues);
  }

  for (const row of rows.learningPoints) {
    if (!lessonCodes.has(row.value.lesson_code)) {
      issues.push(
        makeIssue(
          'error',
          'REFERENCE_UNRESOLVED',
          'learning point references an unknown lesson_code',
          rowSource('Learning Points', row, 'lesson_code'),
          { lesson_code: row.value.lesson_code },
        ),
      );
    }
    checkLanguageDeclared(
      row.value.language,
      declared,
      'Learning Points',
      row,
      issues,
    );
  }

  const mediaKeys = new Set(rows.media.map((row) => row.value.asset_key));
  for (const row of rows.exhibits) {
    if (!lessonCodes.has(row.value.lesson_code)) {
      issues.push(
        makeIssue(
          'error',
          'REFERENCE_UNRESOLVED',
          'exhibit references an unknown lesson_code',
          rowSource('Exhibits', row, 'lesson_code'),
          { lesson_code: row.value.lesson_code },
        ),
      );
    }
    checkLanguageDeclared(
      row.value.language,
      declared,
      'Exhibits',
      row,
      issues,
    );
    if (row.value.asset_key !== null && !mediaKeys.has(row.value.asset_key)) {
      issues.push(
        makeIssue(
          'error',
          'REFERENCE_UNRESOLVED',
          'exhibit asset_key is not registered in the Media sheet',
          rowSource('Exhibits', row, 'asset_key'),
          { asset_key: row.value.asset_key },
        ),
      );
    }
  }

  for (const row of rows.readings) {
    if (!lessonCodes.has(row.value.lesson_code)) {
      issues.push(
        makeIssue(
          'error',
          'REFERENCE_UNRESOLVED',
          'reading references an unknown lesson_code',
          rowSource('Reading List', row, 'lesson_code'),
          { lesson_code: row.value.lesson_code },
        ),
      );
    }
  }

  for (const [sheet, list] of [
    ['Knowledge Test', rows.knowledgeTests],
    ['Application Test', rows.applicationTests],
  ] as const) {
    for (const row of list) {
      if (!lessonCodes.has(row.value.lesson_code)) {
        issues.push(
          makeIssue(
            'error',
            'REFERENCE_UNRESOLVED',
            'test references an unknown lesson_code',
            rowSource(sheet, row, 'lesson_code'),
            { lesson_code: row.value.lesson_code },
          ),
        );
      }
      checkLanguageDeclared(row.value.language, declared, sheet, row, issues);
    }
  }

  for (const row of rows.media) {
    if (
      row.value.lesson_code !== null &&
      !lessonCodes.has(row.value.lesson_code)
    ) {
      issues.push(
        makeIssue(
          'error',
          'REFERENCE_UNRESOLVED',
          'media row references an unknown lesson_code',
          rowSource('Media', row, 'lesson_code'),
          { lesson_code: row.value.lesson_code },
        ),
      );
    }
    if (row.value.language !== null) {
      checkLanguageDeclared(row.value.language, declared, 'Media', row, issues);
    }
    if (
      row.value.thumbnail_of !== null &&
      !mediaKeys.has(row.value.thumbnail_of)
    ) {
      issues.push(
        makeIssue(
          'error',
          'REFERENCE_UNRESOLVED',
          'media thumbnail_of does not reference a media asset_key',
          rowSource('Media', row, 'thumbnail_of'),
          { thumbnail_of: row.value.thumbnail_of },
        ),
      );
    }
  }

  for (const row of rows.courseInfo) {
    if (!(METADATA_LOCALES as readonly string[]).includes(row.value.language)) {
      issues.push(
        makeIssue(
          'error',
          'LANGUAGE_UNDECLARED',
          'course info is metadata and only supports en-GB / zh-CN',
          rowSource('Course Info', row, 'language'),
          { language: row.value.language },
        ),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 媒体绑定与歧义
// ---------------------------------------------------------------------------

const LESSON_BOUND_KINDS = new Set([
  'video',
  'subtitle',
  'chapters',
  'lesson-text',
]);
const LANGUAGE_REQUIRED_KINDS = new Set(['video', 'subtitle', 'lesson-text']);

function checkMediaBindings(
  rows: ValidatedRows,
  issues: CompilerIssue[],
): void {
  const seenCarrier = new Map<string, string>();
  for (const row of rows.media) {
    const kind = row.value.kind;
    if (LESSON_BOUND_KINDS.has(kind)) {
      if (row.value.lesson_code === null) {
        issues.push(
          makeIssue(
            'error',
            'MEDIA_BINDING_MISSING',
            'this media kind must be bound to a lesson_code',
            rowSource('Media', row, 'lesson_code'),
            { asset_key: row.value.asset_key, kind },
          ),
        );
      }
      if (LANGUAGE_REQUIRED_KINDS.has(kind) && row.value.language === null) {
        issues.push(
          makeIssue(
            'error',
            'MEDIA_BINDING_MISSING',
            'this media kind must carry a language',
            rowSource('Media', row, 'language'),
            { asset_key: row.value.asset_key, kind },
          ),
        );
      }
      if (row.value.lesson_code !== null && row.value.language !== null) {
        const slot = `${kind}\u0000${row.value.lesson_code}\u0000${row.value.language}`;
        if (seenCarrier.has(slot)) {
          issues.push(
            makeIssue(
              'error',
              'MEDIA_AMBIGUOUS',
              'a lesson/language slot must not declare more than one carrier of this kind',
              rowSource('Media', row, 'asset_key'),
              {
                kind,
                lesson_code: row.value.lesson_code,
                language: row.value.language,
                first: seenCarrier.get(slot),
                second: row.value.asset_key,
              },
            ),
          );
        } else {
          seenCarrier.set(slot, row.value.asset_key);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 语言完整性（B2.4/B2.6）
// ---------------------------------------------------------------------------

function checkLanguageCompleteness(
  ir: PackageIR,
  rows: ValidatedRows,
  issues: CompilerIssue[],
): void {
  const lessonCodes = [
    ...new Set(rows.lessons.map((r) => r.value.lesson_code)),
  ].sort();
  const lessonLanguages = new Map<string, Set<string>>();
  let firstLessonRow: TypedRow<LessonRow> | null = null;
  for (const row of rows.lessons) {
    firstLessonRow ??= row;
    const set = lessonLanguages.get(row.value.lesson_code) ?? new Set<string>();
    set.add(row.value.language);
    lessonLanguages.set(row.value.lesson_code, set);
  }

  const requiredLanguages = [
    ...new Set<string>([...METADATA_LOCALES, ...ir.course.learningLanguages]),
  ].sort();

  for (const lessonCode of lessonCodes) {
    const present = lessonLanguages.get(lessonCode) ?? new Set<string>();
    for (const language of requiredLanguages) {
      if (!present.has(language)) {
        issues.push(
          makeIssue(
            'incomplete',
            'LANGUAGE_MISSING',
            'lesson is missing a language row (metadata or declared learning language)',
            {
              sheet: 'Lessons',
              row: firstLessonRow?.rowNumber,
              column: 'language',
            },
            { lesson_code: lessonCode, language },
          ),
        );
      }
    }
  }

  const courseInfoByField = new Map<string, Set<string>>();
  for (const row of rows.courseInfo) {
    const set = courseInfoByField.get(row.value.field) ?? new Set<string>();
    set.add(row.value.language);
    courseInfoByField.set(row.value.field, set);
  }
  for (const field of COURSE_INFO_FIELDS) {
    const present = courseInfoByField.get(field) ?? new Set<string>();
    for (const language of METADATA_LOCALES) {
      if (!present.has(language)) {
        issues.push(
          makeIssue(
            'incomplete',
            'LANGUAGE_MISSING',
            'course info field must be present in en-GB and zh-CN',
            { sheet: 'Course Info', column: 'language' },
            { field, language },
          ),
        );
      }
    }
  }

  for (const [sheet, list] of [
    ['Knowledge Test', rows.knowledgeTests],
    ['Application Test', rows.applicationTests],
  ] as const) {
    const byLesson = new Map<string, Set<string>>();
    for (const row of list) {
      const set = byLesson.get(row.value.lesson_code) ?? new Set<string>();
      set.add(row.value.language);
      byLesson.set(row.value.lesson_code, set);
    }
    for (const lessonCode of [...byLesson.keys()].sort()) {
      const present = byLesson.get(lessonCode) as Set<string>;
      for (const language of METADATA_LOCALES) {
        if (!present.has(language)) {
          issues.push(
            makeIssue(
              'incomplete',
              'LANGUAGE_MISSING',
              'bilingual assessment requires en-GB and zh-CN rows',
              { sheet, column: 'language' },
              { lesson_code: lessonCode, language },
            ),
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// STR-1 / STR-2 / STR-4 / STR-5 / STR-7（C4）
// ---------------------------------------------------------------------------

const STAGE_KIND_LEVEL: Readonly<Record<Stage['kind'], number>> = {
  program: 1,
  phase: 2,
  stage: 3,
  step: 4,
};

function stagePath(index: number, field: string): SourceCoordinate {
  return { path: `content.stages[${index}].${field}` };
}

interface StageGraph {
  readonly indexByKey: Map<string, number>;
  readonly childrenByParent: Map<string, number[]>;
  readonly rootIndices: number[];
  readonly parentIndex: Map<number, number>;
}

function buildStageGraph(
  stages: readonly Stage[],
  issues: CompilerIssue[],
  courseKey: string,
): StageGraph {
  const indexByKey = new Map<string, number>();
  stages.forEach((stage, index) => indexByKey.set(stage.stageKey, index));

  const parentIndex = new Map<number, number>();
  stages.forEach((stage, index) => {
    if (stage.courseKey !== courseKey) {
      issues.push(
        makeIssue(
          'error',
          'STAGE_INVALID',
          'stage.courseKey must equal the package course key',
          stagePath(index, 'courseKey'),
          { stageKey: stage.stageKey, expected: courseKey },
          'STR-1',
        ),
      );
    }
    if (stage.parentStageKey === null) return;
    const parent = indexByKey.get(stage.parentStageKey);
    if (parent === undefined) {
      issues.push(
        makeIssue(
          'error',
          'STAGE_INVALID',
          'parentStageKey does not exist in this content version',
          stagePath(index, 'parentStageKey'),
          { stageKey: stage.stageKey, parentStageKey: stage.parentStageKey },
          'STR-1',
        ),
      );
      return;
    }
    if (STAGE_KIND_LEVEL[stage.kind] <= STAGE_KIND_LEVEL[stages[parent].kind]) {
      issues.push(
        makeIssue(
          'error',
          'STAGE_INVALID',
          'stage kind must be strictly deeper than its parent kind',
          stagePath(index, 'kind'),
          {
            stageKey: stage.stageKey,
            kind: stage.kind,
            parentKind: stages[parent].kind,
          },
          'STR-1',
        ),
      );
    }
    parentIndex.set(index, parent);
  });

  const childrenByParent = new Map<string, number[]>();
  const rootIndices: number[] = [];
  stages.forEach((stage, index) => {
    if (!parentIndex.has(index)) {
      rootIndices.push(index);
      return;
    }
    const key = stage.parentStageKey as string;
    const list = childrenByParent.get(key) ?? [];
    list.push(index);
    childrenByParent.set(key, list);
  });

  // 包含环：单父结构下按父指针走链即可（I4/STR-1）。
  const reportedCycles = new Set<string>();
  stages.forEach((stage, index) => {
    const seen = new Set<number>();
    let current: number | undefined = index;
    while (current !== undefined) {
      if (seen.has(current)) {
        const cycle = [...seen].sort((a, b) => a - b);
        const key = cycle.join(',');
        if (!reportedCycles.has(key)) {
          reportedCycles.add(key);
          issues.push(
            makeIssue(
              'error',
              'STAGE_INVALID',
              'containment graph contains a cycle',
              stagePath(index, 'parentStageKey'),
              { stageKeys: cycle.map((i) => stages[i].stageKey).sort() },
              'STR-1',
            ),
          );
        }
        break;
      }
      seen.add(current);
      current = parentIndex.get(current);
    }
  });

  return { indexByKey, childrenByParent, rootIndices, parentIndex };
}

function leafIndicesOf(
  index: number,
  graph: StageGraph,
  stages: readonly Stage[],
): number[] {
  const leaves: number[] = [];
  const stack = [index];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const current = stack.pop() as number;
    if (seen.has(current)) continue;
    seen.add(current);
    const children = graph.childrenByParent.get(stages[current].stageKey);
    if (children === undefined || children.length === 0) {
      leaves.push(current);
      continue;
    }
    for (const child of children) stack.push(child);
  }
  return leaves.sort((a, b) => a - b);
}

function checkLeafAndContainerRules(
  stages: readonly Stage[],
  graph: StageGraph,
  issues: CompilerIssue[],
): void {
  stages.forEach((stage, index) => {
    const children = graph.childrenByParent.get(stage.stageKey) ?? [];
    if (children.length === 0) {
      if (stage.objectiveKeys.length === 0) {
        issues.push(
          makeIssue(
            'error',
            'STAGE_INVALID',
            'delivery leaf (no children) must declare objectiveKeys',
            stagePath(index, 'objectiveKeys'),
            { stageKey: stage.stageKey },
            'STR-1',
          ),
        );
      }
      if (stage.exitEvidence.length === 0) {
        issues.push(
          makeIssue(
            'error',
            'STAGE_INVALID',
            'delivery leaf (no children) must declare exitEvidence',
            stagePath(index, 'exitEvidence'),
            { stageKey: stage.stageKey },
            'STR-1',
          ),
        );
      }
    } else if (stage.exitEvidence.length > 0) {
      issues.push(
        makeIssue(
          'error',
          'STAGE_INVALID',
          'container stage must not declare exitEvidence',
          stagePath(index, 'exitEvidence'),
          { stageKey: stage.stageKey },
          'STR-1',
        ),
      );
    }
  });
}

interface MutableGraph {
  readonly nodes: Set<string>;
  readonly edges: Map<string, Set<string>>;
}

function newGraph(): MutableGraph {
  return { nodes: new Set<string>(), edges: new Map<string, Set<string>>() };
}

function addEdge(graph: MutableGraph, from: string, to: string): void {
  graph.nodes.add(from);
  graph.nodes.add(to);
  const set = graph.edges.get(from) ?? new Set<string>();
  set.add(to);
  graph.edges.set(from, set);
}

/** 交付序图：sequence 兄弟链投影到叶 + requires（C4 STR-2/STR-7）。 */
function buildDeliveryGraph(
  stages: readonly Stage[],
  graph: StageGraph,
  content: ContentVersionContent,
  includeRequires: boolean,
): MutableGraph {
  const delivery = newGraph();
  stages.forEach((stage) => delivery.nodes.add(stage.stageKey));

  const siblingGroups: number[][] = [];
  for (const children of graph.childrenByParent.values()) {
    siblingGroups.push(
      [...children].sort((a, b) =>
        stages[a].orderKey < stages[b].orderKey ? -1 : 1,
      ),
    );
  }
  siblingGroups.push(
    [...graph.rootIndices].sort((a, b) =>
      stages[a].orderKey < stages[b].orderKey ? -1 : 1,
    ),
  );

  for (const group of siblingGroups) {
    for (let i = 0; i + 1 < group.length; i += 1) {
      const leftLeaves = leafIndicesOf(group[i], graph, stages);
      const rightLeaves = leafIndicesOf(group[i + 1], graph, stages);
      for (const left of leftLeaves) {
        for (const right of rightLeaves) {
          addEdge(delivery, stages[left].stageKey, stages[right].stageKey);
        }
      }
    }
  }

  if (includeRequires) {
    for (const edge of content.prerequisiteEdges) {
      if (edge.kind !== 'requires') continue;
      const fromIndex = graph.indexByKey.get(edge.fromStageKey);
      const toIndex = graph.indexByKey.get(edge.toStageKey);
      if (fromIndex === undefined || toIndex === undefined) continue;
      const fromLeaves = leafIndicesOf(fromIndex, graph, stages);
      const toLeaves = leafIndicesOf(toIndex, graph, stages);
      for (const from of fromLeaves) {
        for (const to of toLeaves) {
          addEdge(delivery, stages[from].stageKey, stages[to].stageKey);
        }
      }
    }
  }

  return delivery;
}

/** Tarjan SCC（确定性：节点按插入序，结果按 SCC 内排序后的字符串去重）。 */
function stronglyConnectedComponents(graph: MutableGraph): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  const visit = (node: string): void => {
    indices.set(node, index);
    lowlink.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);

    for (const next of graph.edges.get(node) ?? []) {
      if (!indices.has(next)) {
        visit(next);
        lowlink.set(
          node,
          Math.min(lowlink.get(node) as number, lowlink.get(next) as number),
        );
      } else if (onStack.has(next)) {
        lowlink.set(
          node,
          Math.min(lowlink.get(node) as number, indices.get(next) as number),
        );
      }
    }

    if (lowlink.get(node) === indices.get(node)) {
      const component: string[] = [];
      let current: string;
      do {
        current = stack.pop() as string;
        onStack.delete(current);
        component.push(current);
      } while (current !== node);
      components.push(component.sort());
    }
  };

  for (const node of graph.nodes) {
    if (!indices.has(node)) visit(node);
  }
  return components;
}

function cyclicComponents(
  graph: MutableGraph,
): Array<{ nodes: string[]; selfLoop: boolean }> {
  const out: Array<{ nodes: string[]; selfLoop: boolean }> = [];
  for (const component of stronglyConnectedComponents(graph)) {
    if (component.length > 1) {
      out.push({ nodes: component, selfLoop: false });
    } else {
      const only = component[0];
      if (graph.edges.get(only)?.has(only)) {
        out.push({ nodes: component, selfLoop: true });
      }
    }
  }
  return out;
}

function checkDeliveryAndPrerequisites(
  content: ContentVersionContent,
  graph: StageGraph,
  issues: CompilerIssue[],
): void {
  const stages = content.stages;

  for (const [edgeIndex, edge] of content.prerequisiteEdges.entries()) {
    const fromExists = graph.indexByKey.has(edge.fromStageKey);
    const toExists = graph.indexByKey.has(edge.toStageKey);
    if (!fromExists || !toExists) {
      issues.push(
        makeIssue(
          'error',
          'PREREQUISITE_INVALID',
          'prerequisite edge endpoints must exist in this content version',
          { path: `content.prerequisiteEdges[${edgeIndex}]` },
          {
            fromStageKey: edge.fromStageKey,
            toStageKey: edge.toStageKey,
            fromExists,
            toExists,
          },
          'STR-7',
        ),
      );
    }
    if (
      edge.fromStageKey === edge.toStageKey ||
      (fromExists &&
        stages[graph.indexByKey.get(edge.fromStageKey) as number].courseKey !==
          content.courseKey) ||
      (toExists &&
        stages[graph.indexByKey.get(edge.toStageKey) as number].courseKey !==
          content.courseKey)
    ) {
      issues.push(
        makeIssue(
          'error',
          'PREREQUISITE_INVALID',
          'prerequisite edge must not be self-referential or cross-course',
          { path: `content.prerequisiteEdges[${edgeIndex}]` },
          {
            fromStageKey: edge.fromStageKey,
            toStageKey: edge.toStageKey,
          },
          'STR-7',
        ),
      );
    }
    if (edge.kind === 'recommends') {
      issues.push(
        makeIssue(
          'warning',
          'PREREQUISITE_WARNING',
          'recommends edge does not enter the delivery order (warning only)',
          { path: `content.prerequisiteEdges[${edgeIndex}]` },
          {
            fromStageKey: edge.fromStageKey,
            toStageKey: edge.toStageKey,
          },
          'STR-7',
        ),
      );
    }
  }

  const sequenceGraph = buildDeliveryGraph(stages, graph, content, false);
  const sequenceCycles = cyclicComponents(sequenceGraph);
  for (const cycle of sequenceCycles) {
    issues.push(
      makeIssue(
        'error',
        'DELIVERY_ORDER_CYCLE',
        'sequence sibling chains project to a cycle over delivery leaves',
        { path: 'content.stages' },
        { stageKeys: cycle.nodes, selfLoop: cycle.selfLoop },
        'STR-2',
      ),
    );
  }

  const combined = buildDeliveryGraph(stages, graph, content, true);
  const combinedCycles = cyclicComponents(combined);
  const sequenceCycleKeys = new Set(
    sequenceCycles.map((cycle) => cycle.nodes.join('\u0000')),
  );
  for (const cycle of combinedCycles) {
    if (sequenceCycleKeys.has(cycle.nodes.join('\u0000'))) continue;
    issues.push(
      makeIssue(
        'error',
        'PREREQUISITE_INVALID',
        'requires edges combined with sequence order contain a cycle',
        { path: 'content.prerequisiteEdges' },
        { stageKeys: cycle.nodes, selfLoop: cycle.selfLoop },
        'STR-7',
      ),
    );
  }
}

function checkEvidenceBinding(
  content: ContentVersionContent,
  issues: CompilerIssue[],
): void {
  const specByKey = new Map<string, EvidenceSpec>(
    content.evidenceSpecs.map((spec) => [spec.evidenceKey, spec]),
  );
  const renditionByKey = new Map<string, Rendition>(
    content.renditions.map((rendition) => [rendition.renditionKey, rendition]),
  );

  content.stages.forEach((stage, index) => {
    // STR-4：exitRollup 必须可被声明的出口证据满足（atLeast n > 证据数 = 永远 blocked）。
    if (
      stage.exitRollup.kind === 'atLeast' &&
      stage.exitRollup.n > stage.exitEvidence.length
    ) {
      issues.push(
        makeIssue(
          'error',
          'EVIDENCE_UNSUPPORTED',
          'exitRollup atLeast(n) cannot be satisfied by the declared exitEvidence',
          stagePath(index, 'exitRollup'),
          {
            stageKey: stage.stageKey,
            n: stage.exitRollup.n,
            declared: stage.exitEvidence.length,
          },
          'STR-4',
        ),
      );
    }

    const coveringObjectives = new Set<string>();
    for (const evidenceKey of stage.exitEvidence) {
      const spec = specByKey.get(evidenceKey);
      if (spec === undefined) {
        issues.push(
          makeIssue(
            'incomplete',
            'EVIDENCE_INCOMPLETE',
            'exitEvidence has no matching EvidenceSpec (publish-blocking)',
            stagePath(index, 'exitEvidence'),
            { stageKey: stage.stageKey, evidenceKey },
            'STR-5',
          ),
        );
        continue;
      }
      if (!(EVIDENCE_KINDS as readonly string[]).includes(spec.kind)) {
        issues.push(
          makeIssue(
            'error',
            'EVIDENCE_UNSUPPORTED',
            'evidence kind must come from the closed assessment/artifact/performance set',
            stagePath(index, 'exitEvidence'),
            { stageKey: stage.stageKey, evidenceKey, kind: spec.kind },
            'STR-4',
          ),
        );
      }
      for (const objectiveKey of spec.objectiveKeys) {
        coveringObjectives.add(objectiveKey);
      }

      if (spec.kind === 'assessment' && spec.measure.kind === 'assessment') {
        const measure = spec.measure;
        const bound = content.alignments.some((alignment) => {
          if (alignment.role !== 'assessment') return false;
          if (!stage.objectiveKeys.includes(alignment.objectiveKey)) {
            return false;
          }
          const rendition = renditionByKey.get(alignment.renditionKey);
          if (rendition === undefined) return false;
          return (
            rendition.contentKey === measure.contentKey &&
            measure.blockIds.includes(rendition.blockId)
          );
        });
        if (!bound) {
          issues.push(
            makeIssue(
              'incomplete',
              'EVIDENCE_INCOMPLETE',
              'assessment evidence needs a verified assessment alignment to its measure blocks',
              stagePath(index, 'exitEvidence'),
              { stageKey: stage.stageKey, evidenceKey },
              'STR-5',
            ),
          );
        }
      }
    }

    for (const objectiveKey of stage.objectiveKeys) {
      if (!coveringObjectives.has(objectiveKey)) {
        issues.push(
          makeIssue(
            'incomplete',
            'EVIDENCE_INCOMPLETE',
            'stage objective is not covered by any exit evidence objective set',
            stagePath(index, 'objectiveKeys'),
            { stageKey: stage.stageKey, objectiveKey },
            'STR-5',
          ),
        );
      }
    }
  });
}

function checkStageInvariants(
  content: ContentVersionContent,
  issues: CompilerIssue[],
): void {
  const graph = buildStageGraph(content.stages, issues, content.courseKey);
  checkLeafAndContainerRules(content.stages, graph, issues);
  checkDeliveryAndPrerequisites(content, graph, issues);
  checkEvidenceBinding(content, issues);
}

// ---------------------------------------------------------------------------
// 内容 pin 与模板的双向覆盖
// ---------------------------------------------------------------------------

function checkPins(
  ir: PackageIR,
  rows: ValidatedRows,
  issues: CompilerIssue[],
): void {
  const mediaKeys = new Set(rows.media.map((row) => row.value.asset_key));
  for (const [index, pin] of ir.content.assetPins.entries()) {
    if (!mediaKeys.has(pin.assetKey)) {
      issues.push(
        makeIssue(
          'error',
          'REFERENCE_UNRESOLVED',
          'asset pin references an asset that this package does not deliver',
          { path: `content.assetPins[${index}].assetKey` },
          { assetKey: pin.assetKey },
        ),
      );
    }
  }

  const derivedContentKeys = new Set<string>();
  for (const row of rows.lessons) derivedContentKeys.add(row.value.lesson_code);
  for (const row of rows.readings) {
    derivedContentKeys.add(`${row.value.lesson_code}.reading`);
  }
  for (const row of rows.knowledgeTests) {
    derivedContentKeys.add(`${row.value.lesson_code}.knowledge-test`);
  }
  for (const row of rows.applicationTests) {
    derivedContentKeys.add(`${row.value.lesson_code}.application-test`);
  }
  for (const [index, pin] of ir.content.specPins.entries()) {
    if (!derivedContentKeys.has(pin.contentKey)) {
      issues.push(
        makeIssue(
          'warning',
          'SPEC_PIN_UNKNOWN',
          'spec pin is not derived from this package payload (old spec will be superseded)',
          { path: `content.specPins[${index}].contentKey` },
          { contentKey: pin.contentKey, version: pin.version },
        ),
      );
    }
  }
}

/** 供后续阶段/测试复用的 manifest 简化（避免重复 import 类型）。 */
export type { PackageManifestV2 };

import { z } from 'zod';
import {
  MEDIA_ASSET_KINDS,
  TEMPLATE_V2_HEADERS,
  TEMPLATE_V2_HUMAN_SHEETS,
  TEMPLATE_V2_SHEET_SCHEMAS,
  TemplateMetaRowSchema,
  assertNoHumanTimeColumns,
  assertPackageReaderCompatible,
  parsePackageManifestV2,
  parseTemplateMetaRow,
} from '../contracts';
import type {
  ContentVersionContent,
  PackageCourseV2,
  PackageManifestV2,
  PackageProvenance,
  PackageResource,
  SourceEnv,
  TemplateV2SheetName,
} from '../contracts';
import { PartCError } from '../errors';

/**
 * Part C 编译器 P1：课程包 v2 → PackageIR（设计 §14 C5 P1、C10.6、B8、C9 prior-art）。
 *
 * 纯函数：输入是 manifest.json 的 JSON 值、包内文件字节（path→bytes，ZIP 由
 * 薄壳解压）与已解码的模板工作簿矩阵；不触库、不发网络、不读时钟。
 *
 * 门禁顺序（fail-fast，错误码严格取 C5 P1 / C10 的冻结集合）：
 * 1. 旧包/结构非法 → PACKAGE_FORMAT_UNSUPPORTED
 *    （formatVersion≠2、含旧 course.category、缺 categoryPath、含未知字段/摘要字段）；
 * 2. v1.1 choice 容器 → UNSUPPORTED_ORDERING（先于 schema，保证拿到正确错误码）；
 * 3. manifest.provenance（C10.6）：存在则按契约校验；来源强制（生产环境导入仅接受
 *    provenance.sourceEnv === 'sandbox'）由 PACKAGE_SOURCE_ENFORCEMENT 启用，
 *    默认休眠（off）——off 时只解析并记录 provenance、不因来源拒绝任何包；
 *    判定只读服务端解析出的字段，绝不依据文件名/路径（C10.6）；
 * 4. 读取器能力（minReaderVersion / extensionsRequired）→ PACKAGE_FORMAT_UNSUPPORTED；
 * 5. 闭合包 1:1：声明缺失 → PACKAGE_FILE_MISSING；未声明文件 → PACKAGE_FILE_UNKNOWN；
 *    声明 size 与实际字节数不一致 → PACKAGE_FORMAT_UNSUPPORTED；
 * 6. 模板：templateVersion≠2 / 缺 sheet / 缺列 / 重复列 / Meta 非单行
 *    → TEMPLATE_FORMAT_UNSUPPORTED；任何时间列 → HUMAN_TIME_FORBIDDEN；
 * 7. Media sheet ↔ manifest.resources 一一对应（manifest 为准）→ TEMPLATE_FORMAT_UNSUPPORTED；
 * 8. （可选）分类路径解析失败 → CATEGORY_NOT_FOUND。
 *
 * 稳定 code：parse 只做单元格解码（trim、空串→null、数值列数字化），绝不改名、
 * 不按文件名/目录推断语义、不做任何修复；未知 sheet/列/多余单元格以 warning
 * 进入 IR.notices，由 job 报告显式带出（B8：未消费的列/行必须显式报出）。
 */

/** 包入口文件名；不属于 manifest.resources，参与闭合检查时豁免。 */
export const PACKAGE_ENTRY_FILE = 'manifest.json';

export type TemplateMetaRow = z.infer<typeof TemplateMetaRowSchema>;

/** 错误/警告/不完整的封闭词表（job 报告与后续阶段共用；不另写第二套）。 */
export const COMPILER_ISSUE_CODES = [
  'TEMPLATE_ROW_INVALID',
  'TEMPLATE_COLUMN_UNKNOWN',
  'TEMPLATE_CELL_EXTRA',
  'TEMPLATE_SHEET_UNKNOWN',
  'CODE_DUPLICATE',
  'CODE_RESERVED',
  'REFERENCE_UNRESOLVED',
  'MEDIA_BINDING_MISSING',
  'MEDIA_AMBIGUOUS',
  'LANGUAGE_MISSING',
  'LANGUAGE_UNDECLARED',
  'COURSE_META_MISMATCH',
  'STAGE_INVALID',
  'DELIVERY_ORDER_CYCLE',
  'EVIDENCE_UNSUPPORTED',
  'EVIDENCE_INCOMPLETE',
  'PREREQUISITE_INVALID',
  'PREREQUISITE_WARNING',
  'UNSUPPORTED_ORDERING',
  'SPEC_PIN_UNKNOWN',
  'TIMING_SOURCE_MISSING',
  'TIMING_AMBIGUOUS',
  'TIMING_RANGE_INVALID',
  'TIMING_WINDOW_LARGE',
  'ALIGNMENT_LOW_CONFIDENCE',
  'TRANSCRIPT_INVALID',
  'PROVENANCE_MISMATCH',
  'TRIGGER_EXHIBIT_UNKNOWN',
  'CONTENT_INCOMPLETE',
  'ALIGNMENT_UNBOUND',
  'ALIGNMENT_SEED_UNBOUND',
  'ALIGNMENT_CONFLICT',
] as const;
export type CompilerIssueCode = (typeof COMPILER_ISSUE_CODES)[number];

/** error 整包拒绝；incomplete 允许入库、阻止发布；warning 只入报告（C5 P2）。 */
export type IssueSeverity = 'error' | 'incomplete' | 'warning';

/** 源坐标：模板用 sheet/row/column（1 基行号，表头为第 1 行）；JSON 用 path。 */
export interface SourceCoordinate {
  readonly sheet?: string;
  readonly row?: number;
  readonly column?: string;
  readonly path?: string;
  readonly line?: number;
}

export interface CompilerIssue {
  readonly severity: IssueSeverity;
  readonly code: CompilerIssueCode;
  /** 稳定英文机器消息（不随 locale 变化，job 报告可直接落盘比较）。 */
  readonly message: string;
  /** 可溯源到 §14 的不变量编号（STR-1/STR-2/…），非不变量问题为 undefined。 */
  readonly invariant?: string;
  readonly source?: SourceCoordinate;
  readonly details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 包 provenance（C10.6；契约唯一 SSOT = contracts/package-manifest.ts）
// ---------------------------------------------------------------------------

/**
 * PACKAGE_SOURCE_ENFORCEMENT 的休眠开关（默认 off）。
 *
 * C10.6 要求生产环境导入只接受 sandbox 来源；owner 决策该强制默认休眠，
 * 避免部署后把 UAT（即生产）的 authoring/导入锁死。薄壳读取环境变量后把
 * 结果作为 explicit option 传给 parsePackage（保持 parse 纯函数）。
 */
export function packageSourceEnforcementFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const raw = env.PACKAGE_SOURCE_ENFORCEMENT?.trim().toLowerCase();
  return raw === 'on' || raw === 'true' || raw === '1';
}

/**
 * C10.6 的服务端来源错误码（码表见 errors.ts 的
 * PART_C_ENVIRONMENT_ERROR_DEFINITIONS；与 C5 管线码表分表，保持冻结语义）。
 */
export const PACKAGE_SOURCE_NOT_ALLOWED = 'PACKAGE_SOURCE_NOT_ALLOWED' as const;

function throwPackageSourceNotAllowed(
  message: string,
  details: Record<string, unknown>,
): never {
  throw new PartCError(PACKAGE_SOURCE_NOT_ALLOWED, message, details);
}

// ---------------------------------------------------------------------------
// 输入形状
// ---------------------------------------------------------------------------

/** 模板 sheet 的原始矩阵：第一行是表头，其余是数据行（单元格原值）。 */
export interface RawSheet {
  readonly headers: readonly unknown[];
  readonly rows: ReadonlyArray<readonly unknown[]>;
}

export interface RawWorkbook {
  readonly sheets: Readonly<Record<string, RawSheet>>;
}

export interface RawPackage {
  readonly manifest: unknown;
  /** 包内文件字节（含 manifest.json 亦可）；路径与 manifest.resources[].path 同域。 */
  readonly files: ReadonlyMap<string, Uint8Array>;
  /** template 资源（xlsx）的已解码矩阵，由薄壳用同一个文件字节解码后传入。 */
  readonly workbook: RawWorkbook;
}

export interface ParseOptions {
  /**
   * 分类路径解析器（本环境 ACTIVE catalogue）。缺省不校验；一旦提供且解析失败，
   * 按 C5 P1 抛 CATEGORY_NOT_FOUND，绝不创建分类、不落任何写入。
   */
  readonly resolveCategoryPath?: (path: readonly string[]) => boolean;
  /**
   * 导入目标环境，必须由服务端判定（C10.6/C10.7）；默认 sandbox。
   * 仅供来源强制使用，不参与任何内容解析。
   */
  readonly targetEnvironment?: SourceEnv;
  /**
   * 来源强制开关（PACKAGE_SOURCE_ENFORCEMENT），默认 off（休眠）。
   * off：只解析并记录 provenance，绝不因来源拒绝；on：生产环境导入只接受
   * provenance.sourceEnv === 'sandbox'（且 provenance 必须存在）。
   */
  readonly packageSourceEnforcement?: boolean;
}

/** 带源行号的一行模板数据（values 的键 = 模板契约列名）。 */
export interface SourcedRow {
  readonly rowNumber: number;
  readonly values: Readonly<Record<string, unknown>>;
}

export interface TemplateIR {
  readonly meta: TemplateMetaRow;
  readonly metaRowNumber: number;
  /** 9 张机器 sheet 的原始行（顺序 = sheet 内数据行顺序，行号 1 基含表头）。 */
  readonly sheets: Readonly<Record<TemplateV2SheetName, readonly SourcedRow[]>>;
}

/** P1 产物：闭合包 + 模板 + manifest 内容全部经契约解析后的中间表示。 */
export interface PackageIR {
  readonly manifest: PackageManifestV2;
  readonly course: PackageCourseV2;
  readonly content: ContentVersionContent;
  readonly resources: readonly PackageResource[];
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly template: TemplateIR;
  /** C10.6 provenance（缺失时为 null；是否拒绝由来源强制开关决定）。 */
  readonly provenance: PackageProvenance | null;
  /**
   * manifest.annotations（C10.4：审计报告等环境信息随包携带；不参与身份、
   * 幂等与 staleness）。只要求是 JSON 对象，内容原样保留给薄壳。
   */
  readonly annotations: Readonly<Record<string, unknown>> | null;
  /** 非阻断的结构性提示（未知 sheet/未知列/多余单元格）。 */
  readonly notices: readonly CompilerIssue[];
}

// ---------------------------------------------------------------------------
// choice 容器拒绝（v1.1 延后，C0；parse 在 schema 之前识别，错误码才正确）
// ---------------------------------------------------------------------------

const CHOICE_MARKER_KEYS: ReadonlySet<string> = new Set([
  'choice',
  'choices',
  'choiceGroups',
  'choiceFrom',
  'choiceContainers',
  'choiceContainer',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scanChoiceOrdering(value: unknown, path: string, out: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      scanChoiceOrdering(item, `${path}[${index}]`, out),
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (CHOICE_MARKER_KEYS.has(key)) {
      out.push(childPath);
      continue;
    }
    if (
      (key === 'ordering' ||
        key === 'kind' ||
        key === 'type' ||
        key === 'container') &&
      typeof child === 'string' &&
      /choice/i.test(child)
    ) {
      out.push(childPath);
      continue;
    }
    if (
      key === 'exitRollup' &&
      isRecord(child) &&
      typeof child.kind === 'string' &&
      /choice/i.test(child.kind)
    ) {
      out.push(`${childPath}.kind`);
      continue;
    }
    scanChoiceOrdering(child, childPath, out);
  }
}

/**
 * 扫描 manifest.content 中的 choice 容器标记（v1.1 延后能力）。
 * 返回命中路径；非空即整包拒绝为 UNSUPPORTED_ORDERING（C0 v1 范围）。
 */
export function detectUnsupportedOrdering(manifest: unknown): string[] {
  if (!isRecord(manifest)) return [];
  const content = manifest.content;
  if (content === undefined) return [];
  const found: string[] = [];
  scanChoiceOrdering(content, 'content', found);
  return found;
}

// ---------------------------------------------------------------------------
// 单元格解码
// ---------------------------------------------------------------------------

function normalizeCell(value: unknown, column: string): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  // 电子表格数值单元格在部分读取器里以字符串出现；只对明确的数值列做机器解码。
  if (
    (column === 'order' || column === 'templateVersion') &&
    /^\d+$/.test(trimmed)
  ) {
    return Number(trimmed);
  }
  return trimmed;
}

function decodeMetaValues(
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const decoded: Record<string, unknown> = { ...values };
  const languages = decoded.learningLanguages;
  if (typeof languages === 'string') {
    decoded.learningLanguages = languages
      .split(/[,;|]/)
      .map((item) => item.trim())
      .filter((item) => item !== '');
  }
  return decoded;
}

function isBlankRow(cells: readonly unknown[]): boolean {
  return cells.every(
    (cell) =>
      cell === undefined ||
      cell === null ||
      (typeof cell === 'string' && cell.trim() === ''),
  );
}

/** 表头只接受标量单元格；其余形态按空列处理，由 missing-column 检查显式报错。 */
function normalizeHeader(header: unknown): string {
  if (typeof header === 'string') return header.trim();
  if (typeof header === 'number' || typeof header === 'boolean') {
    return String(header);
  }
  return '';
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * P1 parse：闭合课程包 v2 → PackageIR。
 * 任何 C5 P1 门禁失败抛 PartCError（code 即契约），不做兼容解析、不落任何写入。
 */
export function parsePackage(
  input: RawPackage,
  options: ParseOptions = {},
): PackageIR {
  const notices: CompilerIssue[] = [];

  if (!isRecord(input.manifest)) {
    throw new PartCError(
      'PACKAGE_FORMAT_UNSUPPORTED',
      'manifest.json must be a JSON object',
      { reason: 'manifest-not-object' },
    );
  }

  const choicePaths = detectUnsupportedOrdering(input.manifest);
  if (choicePaths.length > 0) {
    throw new PartCError(
      'UNSUPPORTED_ORDERING',
      'choice containers are deferred to v1.1 and are rejected by the v1 compiler',
      { paths: choicePaths },
    );
  }

  // 契约（PackageManifestV2Schema，唯一 SSOT）解析整包：provenance/annotations
  // 与其余字段同源校验，不存在契约外的第二套形状（评审阻断 3）。
  const manifest = parsePackageManifestV2(input.manifest);
  enforcePackageSource(manifest, manifest.provenance ?? null, options);
  assertPackageReaderCompatible(manifest);

  assertClosedFileSet(manifest, input.files);
  const templateResource = assertSingleTemplateResource(manifest);

  const template = parseWorkbook(input.workbook);
  const templateIR = template.ir;
  if (templateIR.meta.courseCode !== manifest.course.courseKey) {
    throw new PartCError(
      'TEMPLATE_FORMAT_UNSUPPORTED',
      'template Meta courseCode must equal manifest course.courseKey',
      {
        reason: 'course-code-mismatch',
        templateCourseCode: templateIR.meta.courseCode,
        manifestCourseKey: manifest.course.courseKey,
        coordinate: {
          sheet: 'Meta',
          row: templateIR.metaRowNumber,
          column: 'courseCode',
        },
      },
    );
  }

  assertMediaSheetMatchesResources(
    manifest,
    templateIR.sheets.Media,
    templateResource,
  );

  const categoryPath = manifest.course.categoryPath;
  if (
    categoryPath !== null &&
    options.resolveCategoryPath !== undefined &&
    !options.resolveCategoryPath(categoryPath)
  ) {
    throw new PartCError(
      'CATEGORY_NOT_FOUND',
      'categoryPath does not resolve to an ACTIVE category in this environment',
      { categoryPath },
    );
  }

  return {
    manifest,
    course: manifest.course,
    content: manifest.content,
    resources: manifest.resources,
    files: input.files,
    template: templateIR,
    provenance: manifest.provenance ?? null,
    annotations: manifest.annotations ?? null,
    notices: [...notices, ...template.notices],
  };
}

// ---------------------------------------------------------------------------
// 来源强制（C10.6）
// ---------------------------------------------------------------------------

/**
 * 来源强制（C10.6）：默认休眠。
 *
 * - off（默认）：行为与现状完全一致——解析并记录 provenance，绝不拒绝包
 *   （不因 sourceEnv 不是 sandbox、甚至 provenance 缺失而失败）。
 * - on：生产环境导入只接受 provenance.sourceEnv === 'sandbox'；provenance 缺失
 *   视同来源不可证明 → PACKAGE_SOURCE_NOT_ALLOWED。sandbox 环境不设来源限制。
 * - 判定只看服务端解析出的 provenance.sourceEnv，不看文件名/路径/声明位置。
 */
function enforcePackageSource(
  manifest: PackageManifestV2,
  provenance: PackageProvenance | null,
  options: ParseOptions,
): void {
  if (options.packageSourceEnforcement !== true) return;
  if ((options.targetEnvironment ?? 'sandbox') !== 'production') return;
  if (provenance !== null && provenance.sourceEnv === 'sandbox') return;
  throwPackageSourceNotAllowed(
    'production imports only accept course packages exported from a sandbox environment',
    {
      reason:
        provenance === null ? 'provenance-missing' : 'source-env-not-sandbox',
      sourceEnv: provenance?.sourceEnv ?? null,
      formatVersion: manifest.formatVersion,
      targetEnvironment: 'production',
    },
  );
}

// ---------------------------------------------------------------------------
// 闭合包 1:1
// ---------------------------------------------------------------------------

function assertClosedFileSet(
  manifest: PackageManifestV2,
  files: ReadonlyMap<string, Uint8Array>,
): void {
  const declaredByPath = new Map<string, PackageResource>();
  for (const resource of manifest.resources) {
    declaredByPath.set(resource.path, resource);
  }

  for (const path of [...files.keys()].sort()) {
    if (path === PACKAGE_ENTRY_FILE) continue;
    if (!declaredByPath.has(path)) {
      throw new PartCError(
        'PACKAGE_FILE_UNKNOWN',
        'package contains a file that manifest.resources does not declare',
        { path },
      );
    }
  }

  for (const resource of manifest.resources) {
    const bytes = files.get(resource.path);
    if (bytes === undefined) {
      throw new PartCError(
        'PACKAGE_FILE_MISSING',
        'manifest.resources declares a file that is missing from the package',
        { path: resource.path, id: resource.id, kind: resource.kind },
      );
    }
    if (bytes.byteLength !== resource.size) {
      // 闭合包的大小校验（B8「ZIP CRC32 + 大小/类型校验」）；不引入任何摘要。
      throw new PartCError(
        'PACKAGE_FORMAT_UNSUPPORTED',
        'declared resource size does not match the packaged bytes',
        {
          reason: 'resource-size-mismatch',
          path: resource.path,
          declaredSize: resource.size,
          actualSize: bytes.byteLength,
        },
      );
    }
  }
}

function assertSingleTemplateResource(
  manifest: PackageManifestV2,
): PackageResource {
  const templates = manifest.resources.filter(
    (resource) => resource.kind === 'template',
  );
  if (templates.length !== 1) {
    throw new PartCError(
      'TEMPLATE_FORMAT_UNSUPPORTED',
      'package must declare exactly one template resource',
      { reason: 'template-resource-count', count: templates.length },
    );
  }
  return templates[0];
}

// ---------------------------------------------------------------------------
// 模板工作簿
// ---------------------------------------------------------------------------

interface ParsedWorkbook {
  readonly ir: TemplateIR;
  readonly notices: CompilerIssue[];
}

const MACHINE_SHEETS = Object.keys(
  TEMPLATE_V2_SHEET_SCHEMAS,
) as TemplateV2SheetName[];

function parseWorkbook(workbook: RawWorkbook): ParsedWorkbook {
  const notices: CompilerIssue[] = [];
  if (!isRecord(workbook) || !isRecord(workbook.sheets)) {
    throw new PartCError(
      'TEMPLATE_FORMAT_UNSUPPORTED',
      'template workbook could not be decoded',
      { reason: 'workbook-not-decoded' },
    );
  }
  const sheets = workbook.sheets;

  const missingSheets = MACHINE_SHEETS.filter(
    (name) => !isRecord(sheets[name]),
  );
  if (missingSheets.length > 0) {
    throw new PartCError(
      'TEMPLATE_FORMAT_UNSUPPORTED',
      'template is missing required machine sheets',
      { reason: 'missing-sheets', sheets: missingSheets },
    );
  }

  const knownSheets = new Set<string>([
    ...MACHINE_SHEETS,
    ...TEMPLATE_V2_HUMAN_SHEETS,
  ]);
  for (const sheetName of Object.keys(sheets)) {
    if (!knownSheets.has(sheetName)) {
      notices.push({
        severity: 'warning',
        code: 'TEMPLATE_SHEET_UNKNOWN',
        message:
          'template contains a sheet that is not part of the v2 contract',
        source: { sheet: sheetName },
      });
    }
  }

  const headersBySheet = new Map<TemplateV2SheetName, string[]>();
  const missingColumns: Array<{
    sheet: string;
    columns: string[];
  }> = [];
  const duplicateColumns: Array<{ sheet: string; columns: string[] }> = [];

  for (const sheetName of MACHINE_SHEETS) {
    const rawSheet = sheets[sheetName];
    const headers = rawSheet.headers.map(normalizeHeader);
    // 红线：模板没有任何时间列（B1/C5 P1）；未知列也一并检查，fail-closed。
    assertNoHumanTimeColumns(headers.filter((header) => header !== ''));

    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const header of headers) {
      if (header === '') continue;
      if (seen.has(header)) duplicates.push(header);
      seen.add(header);
    }
    if (duplicates.length > 0) {
      duplicateColumns.push({ sheet: sheetName, columns: duplicates });
    }

    const expected = TEMPLATE_V2_HEADERS[sheetName];
    const missing = expected.filter((column) => !seen.has(column));
    if (missing.length > 0) {
      missingColumns.push({ sheet: sheetName, columns: missing });
    }

    const extras = [...seen].filter((column) => !expected.includes(column));
    for (const column of extras) {
      notices.push({
        severity: 'warning',
        code: 'TEMPLATE_COLUMN_UNKNOWN',
        message:
          'template sheet contains a column that is not part of the v2 contract',
        source: { sheet: sheetName, column },
      });
    }

    headersBySheet.set(sheetName, headers);
  }

  if (missingColumns.length > 0 || duplicateColumns.length > 0) {
    throw new PartCError(
      'TEMPLATE_FORMAT_UNSUPPORTED',
      'template headers do not match the v2 machine contract',
      {
        reason: 'header-contract',
        missingColumns,
        duplicateColumns,
      },
    );
  }

  const rowsBySheet = new Map<TemplateV2SheetName, SourcedRow[]>();
  for (const sheetName of MACHINE_SHEETS) {
    const rawSheet = sheets[sheetName];
    const headers = headersBySheet.get(sheetName) as string[];
    const rows: SourcedRow[] = [];
    rawSheet.rows.forEach((cells, rowIndex) => {
      if (isBlankRow(cells)) return;
      const rowNumber = rowIndex + 2; // 第一行是表头
      const values: Record<string, unknown> = {};
      headers.forEach((header, columnIndex) => {
        if (header === '') return;
        values[header] = normalizeCell(cells[columnIndex], header);
      });
      cells.forEach((cell, columnIndex) => {
        if (columnIndex < headers.length) return;
        if (cell === undefined || cell === null) return;
        notices.push({
          severity: 'warning',
          code: 'TEMPLATE_CELL_EXTRA',
          message:
            'template row has a cell beyond the declared columns; it is not consumed',
          source: { sheet: sheetName, row: rowNumber },
          details: { columnIndex },
        });
      });
      rows.push({ rowNumber, values });
    });
    rowsBySheet.set(sheetName, rows);
  }

  const metaRows = rowsBySheet.get('Meta') as SourcedRow[];
  if (metaRows.length !== 1) {
    throw new PartCError(
      'TEMPLATE_FORMAT_UNSUPPORTED',
      'template Meta sheet must contain exactly one data row',
      { reason: 'meta-row-count', count: metaRows.length },
    );
  }
  const metaRow = metaRows[0];
  const meta = parseTemplateMetaRow(decodeMetaValues(metaRow.values));

  const sheetsOut = {} as Record<TemplateV2SheetName, readonly SourcedRow[]>;
  for (const sheetName of MACHINE_SHEETS) {
    sheetsOut[sheetName] = rowsBySheet.get(sheetName) as SourcedRow[];
  }

  return {
    ir: { meta, metaRowNumber: metaRow.rowNumber, sheets: sheetsOut },
    notices,
  };
}

// ---------------------------------------------------------------------------
// Media sheet ↔ manifest.resources 一一对应（manifest 为准）
// ---------------------------------------------------------------------------

function rowString(row: SourcedRow, column: string): string | null {
  const value = row.values[column];
  return typeof value === 'string' ? value : null;
}

function assertMediaSheetMatchesResources(
  manifest: PackageManifestV2,
  mediaRows: readonly SourcedRow[],
  templateResource: PackageResource,
): void {
  const mediaKinds = new Set<string>(MEDIA_ASSET_KINDS);
  const declaredMedia = manifest.resources.filter(
    (resource) =>
      mediaKinds.has(resource.kind) && resource.path !== templateResource.path,
  );

  const rowsByAssetKey = new Map<string, SourcedRow[]>();
  for (const row of mediaRows) {
    const assetKey = rowString(row, 'asset_key');
    if (assetKey === null) continue; // 行级错误由 validate 以源坐标报告
    const list = rowsByAssetKey.get(assetKey) ?? [];
    list.push(row);
    rowsByAssetKey.set(assetKey, list);
  }

  for (const resource of declaredMedia) {
    const rows = rowsByAssetKey.get(resource.id) ?? [];
    if (rows.length === 0) {
      throw new PartCError(
        'TEMPLATE_FORMAT_UNSUPPORTED',
        'manifest declares a media resource that the Media sheet does not register',
        {
          reason: 'media-row-missing',
          assetKey: resource.id,
          path: resource.path,
          kind: resource.kind,
          coordinate: { sheet: 'Media' },
        },
      );
    }
    const matched = rows.some(
      (row) =>
        rowString(row, 'kind') === resource.kind &&
        rowString(row, 'relative_path') === resource.path,
    );
    if (!matched) {
      throw new PartCError(
        'TEMPLATE_FORMAT_UNSUPPORTED',
        'Media sheet row does not agree with the manifest resource it registers',
        {
          reason: 'media-row-mismatch',
          assetKey: resource.id,
          path: resource.path,
          kind: resource.kind,
          coordinate: {
            sheet: 'Media',
            row: rows[0].rowNumber,
            column: 'relative_path',
          },
        },
      );
    }
  }

  const resourceById = new Map(
    manifest.resources.map((resource) => [resource.id, resource]),
  );

  for (const row of mediaRows) {
    const assetKey = rowString(row, 'asset_key');
    const kind = rowString(row, 'kind');
    const path = rowString(row, 'relative_path');
    if (assetKey === null || kind === null || path === null) continue;
    const resource = resourceById.get(assetKey);
    const matchesResource =
      resource !== undefined &&
      resource.kind === kind &&
      resource.path === path;
    // lesson-text 模板登记允许对应 manifest 的 document 资源（DOCX 载体）。
    const matchesDocument =
      kind === 'lesson-text' &&
      resource !== undefined &&
      resource.kind === 'document' &&
      resource.path === path;
    if (!matchesResource && !matchesDocument) {
      throw new PartCError(
        'TEMPLATE_FORMAT_UNSUPPORTED',
        'Media sheet row is not declared as a matching resource in the manifest',
        {
          reason: 'media-row-unknown',
          assetKey,
          kind,
          path,
          coordinate: {
            sheet: 'Media',
            row: row.rowNumber,
            column: 'asset_key',
          },
        },
      );
    }
  }
}

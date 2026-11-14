import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import * as XLSX from 'xlsx';
import { PrismaService } from '../prisma/prisma.service';
import { COMMERCE_CONFIG, type CommerceCourseConfig } from './commerce.config';
import { convertDocxToHtml } from './docx-to-html';
import { mp4DurationSeconds } from './media-duration';
import {
  MediaValidationError,
  validateMediaFile,
  type MediaKind,
  type ValidatedMedia,
} from './media-validate';
import { CourseStorageService } from './storage.service';
import { categoryRef, EXHIBIT_FIELDS } from './localized-fields';
import { parseLocalized } from '../common/i18n/localized';

const READING_TYPES = new Set(['BOOK', 'ARTICLE', 'PAPER', 'OTHER']);
const EXHIBIT_TYPES = new Set(['IMAGE', 'VIDEO', 'MODEL3D']);

function required(value: unknown, message: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new BadRequestException({ code: 'REQUIRED', message });
  return text;
}

function upper(value: unknown): string {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ParsedTextLearningPoint {
  heading: string;
  hasBody: boolean;
}

/** 从富文本中识别 Heading 1；仅 H1 是 LP（PRD 12.5.2）。 */
export function parseTextLearningPoints(
  html: string,
): ParsedTextLearningPoint[] {
  const matches = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)];
  return matches
    .map((match, index) => {
      const heading = stripHtml(match[1] ?? '');
      const start = (match.index ?? 0) + match[0].length;
      const end =
        index + 1 < matches.length
          ? (matches[index + 1].index ?? html.length)
          : html.length;
      const body = stripHtml(html.slice(start, end));
      return { heading, hasBody: Boolean(body) };
    })
    .filter((row) => Boolean(row.heading));
}

/**
 * 把文本中的 H1 同步为 TEXT Learning Point。
 * 标题不变的 LP 复用原 code，避免简单编辑导致学习进度 ID 漂移。
 */
export async function syncTextLearningPoints(
  client: PrismaService | Prisma.TransactionClient,
  lessonId: string,
  language: string,
  html: string | null,
): Promise<void> {
  const points = html ? parseTextLearningPoints(html) : [];
  const existing = await client.learningPoint.findMany({
    where: { lessonId, language },
    orderBy: { sortOrder: 'asc' },
  });
  const codeByTitle = new Map(
    existing
      .filter((lp) => (lp.source as string) === 'TEXT')
      .map((lp) => [lp.title, lp.code]),
  );
  const usedCodes = new Set(existing.map((lp) => lp.code));

  await client.learningPoint.deleteMany({
    where: { lessonId, language, source: 'TEXT' },
  });

  const nextCode = (title: string): string => {
    const reused = codeByTitle.get(title);
    if (reused) return reused;
    let index = 1;
    while (usedCodes.has(`T${index}`)) index++;
    const code = `T${index}`;
    usedCodes.add(code);
    return code;
  };

  const codes: string[] = [];
  for (const [index, point] of points.entries()) {
    const code = nextCode(point.heading);
    codes.push(code);
    await client.learningPoint.create({
      data: {
        lessonId,
        language,
        code,
        title: point.heading,
        source: 'TEXT',
        anchorHeading: point.heading,
        sortOrder: index,
      },
    });
  }

  await client.lessonLocalization.updateMany({
    where: { lessonId, language },
    data: {
      textLearningPoints: points.length
        ? (points.map((point, index) => ({
            code: codes[index],
            heading: point.heading,
            hasBody: point.hasBody,
          })) as unknown as Prisma.InputJsonValue)
        : Prisma.DbNull,
    },
  });
}

@Injectable()
export class CourseAuthoringService {
  private readonly videoDurationCache = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: CourseStorageService,
    @Inject(COMMERCE_CONFIG) private readonly config: CommerceCourseConfig,
  ) {}

  async listCategories() {
    const rows = await this.prisma.courseCatalogueEntry.findMany({
      where: { parentId: null, status: 'ACTIVE' },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, localized: true },
    });
    return rows.map((row) => categoryRef(row));
  }

  async uploadMedia(
    courseId: string,
    file:
      { originalname: string; mimetype?: string; buffer: Buffer } | undefined,
    expected?: 'COVER' | 'VIDEO' | 'IMAGE',
  ) {
    if (!file?.buffer) {
      throw new BadRequestException({
        code: 'FILE_REQUIRED',
        message: 'No file uploaded.',
      });
    }
    await this.assertCourse(courseId);
    let validated: ValidatedMedia;
    try {
      validated = validateMediaFile(
        {
          name: file.originalname,
          type: file.mimetype,
          bytes: file.buffer,
        },
        this.config,
      );
    } catch (error) {
      if (error instanceof MediaValidationError) {
        throw new BadRequestException({
          code: 'MEDIA_INVALID',
          message: error.message,
        });
      }
      throw error;
    }
    this.assertExpectedKind(validated.kind, expected);

    const assetId = randomUUID();
    const storageKey = this.storage.mediaKey(
      courseId,
      assetId,
      validated.extension,
    );
    await this.storage.putMedia(storageKey, file.buffer);
    try {
      const asset = await this.prisma.courseMediaAsset.create({
        data: {
          id: assetId,
          courseId,
          kind: validated.kind as never,
          originalName: validated.originalName,
          mimeType: validated.mimeType,
          extension: validated.extension,
          size: validated.size,
          storageKey,
          checksum: CourseStorageService.sha256(file.buffer),
        },
        select: {
          id: true,
          kind: true,
          originalName: true,
          mimeType: true,
          extension: true,
          size: true,
        },
      });
      // 时长解析需要整份文件：刚上传时 Buffer 就在手上，顺手算好并缓存，
      // 绑定到课时（setLessonVideo）时就不必再从存储下载一遍几百 MB 的视频。
      let durationSeconds: number | null = null;
      if (
        validated.kind === 'VIDEO' &&
        ['mp4', 'mov'].includes(validated.extension)
      ) {
        durationSeconds =
          Math.max(0, Math.round(mp4DurationSeconds(file.buffer) ?? 0)) || null;
        this.rememberVideoDuration(asset.id, durationSeconds);
      }
      return { ...asset, durationSeconds };
    } catch (error) {
      await this.storage.removeMedia(storageKey).catch(() => undefined);
      throw error;
    }
  }

  /** 视频时长小缓存（进程内，最多保留 200 条），避免绑定课时时重复下载大文件。 */
  private rememberVideoDuration(assetId: string, seconds: number | null): void {
    if (seconds === null) return;
    this.videoDurationCache.delete(assetId);
    this.videoDurationCache.set(assetId, seconds);
    while (this.videoDurationCache.size > 200) {
      const oldest = this.videoDurationCache.keys().next().value;
      if (oldest === undefined) break;
      this.videoDurationCache.delete(oldest);
    }
  }

  async uploadCover(
    courseId: string,
    file:
      { originalname: string; mimetype?: string; buffer: Buffer } | undefined,
  ) {
    const asset = await this.uploadMedia(courseId, file, 'COVER');
    await this.prisma.commerceCourse.update({
      where: { id: courseId },
      data: {
        coverAssetId: asset.id,
        hasDraft: true,
        draftRevision: { increment: 1 },
        lifecycleStatus: 'WORKING',
      },
    });
    return asset;
  }

  async deleteCover(courseId: string) {
    await this.assertCourse(courseId);
    await this.prisma.commerceCourse.update({
      where: { id: courseId },
      data: {
        coverAssetId: null,
        hasDraft: true,
        draftRevision: { increment: 1 },
        lifecycleStatus: 'WORKING',
      },
    });
    return { deleted: true };
  }

  async setLessonVideo(
    courseId: string,
    lessonId: string,
    language: string,
    assetId: string,
  ) {
    const lesson = await this.requireLesson(courseId, lessonId);
    const asset = await this.requireAsset(courseId, assetId);
    if (asset.kind !== 'VIDEO') {
      throw new BadRequestException({
        code: 'VIDEO_REQUIRED',
        message: 'Choose a video asset.',
      });
    }
    const cachedDuration = this.videoDurationCache.get(assetId);
    const duration =
      cachedDuration ??
      (asset.extension.toLowerCase() === 'mp4'
        ? Math.max(
            0,
            Math.round(
              mp4DurationSeconds(
                await this.storage.getMedia(asset.storageKey),
              ) ?? 0,
            ),
          ) || null
        : null);
    const existing = lesson.localizations.find(
      (loc) => loc.language === language,
    );
    await this.prisma.lessonLocalization.upsert({
      where: { lessonId_language: { lessonId, language } },
      create: {
        lessonId,
        language,
        title: existing?.title ?? lesson.code,
        description: existing?.description ?? null,
        videoAssetId: assetId,
        videoDurationSeconds: duration,
        textHtml: existing?.textHtml ?? null,
      },
      update: { videoAssetId: assetId, videoDurationSeconds: duration },
    });
    await this.touchCourse(courseId);
    return { assetId, durationSeconds: duration };
  }

  async saveVideoLearningPoints(
    courseId: string,
    lessonId: string,
    language: string,
    input: Array<{ code?: string; title: string; timeSeconds: number }>,
  ) {
    const lesson = await this.requireLesson(courseId, lessonId);
    const duration =
      lesson.localizations.find((loc) => loc.language === language)
        ?.videoDurationSeconds ?? null;
    const existing = lesson.learningPoints.filter(
      (lp) => lp.language === language && lp.source === 'VIDEO',
    );
    const codeByTitle = new Map(existing.map((lp) => [lp.title, lp.code]));
    const usedCodes = new Set(
      lesson.learningPoints
        .filter((lp) => lp.language === language)
        .map((lp) => lp.code),
    );
    const points = input.map((point, index) => {
      const title = required(
        point.title,
        `Learning point ${index + 1} needs a title.`,
      );
      const timeSeconds = Math.max(
        0,
        Math.round(Number(point.timeSeconds) || 0),
      );
      if (duration !== null && timeSeconds > duration) {
        throw new BadRequestException({
          code: 'LP_BEYOND_VIDEO',
          message: `Learning point "${title}" is beyond the video length.`,
        });
      }
      let code = point.code?.trim() || codeByTitle.get(title) || '';
      if (!code) {
        let n = 1;
        while (usedCodes.has(`V${n}`)) n++;
        code = `V${n}`;
      }
      usedCodes.add(code);
      return { code, title, timeSeconds, sortOrder: index };
    });
    await this.prisma.$transaction(async (tx) => {
      await tx.learningPoint.deleteMany({
        where: { lessonId, language, source: 'VIDEO' },
      });
      for (const point of points) {
        await tx.learningPoint.create({
          data: { lessonId, language, source: 'VIDEO', ...point },
        });
      }
      await tx.commerceCourse.update({
        where: { id: courseId },
        data: {
          hasDraft: true,
          draftRevision: { increment: 1 },
          lifecycleStatus: 'WORKING',
        },
      });
    });
    return { points };
  }

  async saveTriggers(
    courseId: string,
    lessonId: string,
    language: string,
    input: Array<{ exhibitId: string; timeSeconds: number }>,
  ) {
    const lesson = await this.requireLesson(courseId, lessonId);
    const duration =
      lesson.localizations.find((loc) => loc.language === language)
        ?.videoDurationSeconds ?? null;
    const exhibitIds = new Set(lesson.exhibits.map((exhibit) => exhibit.id));
    const rows = input.map((row, index) => {
      if (!exhibitIds.has(row.exhibitId)) {
        throw new BadRequestException({
          code: 'EXHIBIT_NOT_FOUND',
          message: `Exhibit ${index + 1} does not belong to this lesson.`,
        });
      }
      const timeSeconds = Math.max(0, Math.round(Number(row.timeSeconds) || 0));
      if (duration !== null && timeSeconds > duration) {
        throw new BadRequestException({
          code: 'TRIGGER_BEYOND_VIDEO',
          message: `Exhibit trigger ${index + 1} is beyond the video length.`,
        });
      }
      return { exhibitId: row.exhibitId, timeSeconds };
    });
    await this.prisma.$transaction(async (tx) => {
      await tx.exhibitTrigger.deleteMany({ where: { lessonId, language } });
      for (const row of rows) {
        await tx.exhibitTrigger.create({
          data: { lessonId, language, ...row },
        });
      }
      await tx.commerceCourse.update({
        where: { id: courseId },
        data: {
          hasDraft: true,
          draftRevision: { increment: 1 },
          lifecycleStatus: 'WORKING',
        },
      });
    });
    return { triggers: rows.length };
  }

  async createExhibit(
    courseId: string,
    lessonId: string,
    body: {
      code?: string;
      type: string;
      mediaAssetId?: string | null;
      thumbnailAssetId?: string | null;
      sourceText?: string | null;
      localized?: unknown;
    },
  ) {
    await this.requireLesson(courseId, lessonId);
    const type = upper(body.type);
    if (!EXHIBIT_TYPES.has(type)) {
      throw new BadRequestException({
        code: 'EXHIBIT_TYPE_INVALID',
        message: 'Media type must be Image, Video or 3D.',
      });
    }
    if (body.mediaAssetId) await this.requireAsset(courseId, body.mediaAssetId);
    if (body.thumbnailAssetId)
      await this.requireAsset(courseId, body.thumbnailAssetId);
    const code = body.code?.trim() || (await this.nextExhibitCode(courseId));
    const exhibit = await this.prisma.exhibit.create({
      data: {
        lessonId,
        code,
        type: type as never,
        mediaAssetId: body.mediaAssetId ?? null,
        thumbnailAssetId: body.thumbnailAssetId ?? null,
        sourceText: body.sourceText ?? null,
        localized: parseLocalized(body.localized, EXHIBIT_FIELDS),
      },
    });
    await this.touchCourse(courseId);
    return exhibit;
  }

  async updateExhibit(
    courseId: string,
    lessonId: string,
    exhibitId: string,
    body: {
      type?: string;
      mediaAssetId?: string | null;
      thumbnailAssetId?: string | null;
      sourceText?: string | null;
      localized?: unknown;
    },
  ) {
    await this.requireLesson(courseId, lessonId);
    const exhibit = await this.prisma.exhibit.findFirst({
      where: { id: exhibitId, lessonId },
    });
    if (!exhibit)
      throw new NotFoundException({
        code: 'EXHIBIT_NOT_FOUND',
        message: 'Exhibit not found.',
      });
    if (body.mediaAssetId) await this.requireAsset(courseId, body.mediaAssetId);
    if (body.thumbnailAssetId)
      await this.requireAsset(courseId, body.thumbnailAssetId);
    const type = body.type ? upper(body.type) : null;
    if (type && !EXHIBIT_TYPES.has(type)) {
      throw new BadRequestException({
        code: 'EXHIBIT_TYPE_INVALID',
        message: 'Media type must be Image, Video or 3D.',
      });
    }
    const updated = await this.prisma.exhibit.update({
      where: { id: exhibitId },
      data: {
        ...(type ? { type: type as never } : {}),
        ...(body.mediaAssetId !== undefined
          ? { mediaAssetId: body.mediaAssetId }
          : {}),
        ...(body.thumbnailAssetId !== undefined
          ? { thumbnailAssetId: body.thumbnailAssetId }
          : {}),
        ...(body.sourceText !== undefined
          ? { sourceText: body.sourceText }
          : {}),
        ...(body.localized !== undefined
          ? { localized: parseLocalized(body.localized, EXHIBIT_FIELDS) }
          : {}),
      },
    });
    await this.touchCourse(courseId);
    return updated;
  }

  async deleteExhibit(courseId: string, lessonId: string, exhibitId: string) {
    const lesson = await this.requireLesson(courseId, lessonId);
    const exhibit = lesson.exhibits.find((row) => row.id === exhibitId);
    if (!exhibit)
      throw new NotFoundException({
        code: 'EXHIBIT_NOT_FOUND',
        message: 'Exhibit not found.',
      });
    if (lesson.triggers.some((trigger) => trigger.exhibitId === exhibitId)) {
      throw new ConflictException({
        code: 'EXHIBIT_IN_USE',
        message: 'Used in Video triggers. Remove the trigger first.',
      });
    }
    const referencedInText = lesson.localizations.some(
      (loc) =>
        loc.textHtml?.includes(exhibitId) ||
        loc.textHtml?.includes(`data-exhibit-code="${exhibit.code}"`),
    );
    if (referencedInText) {
      throw new ConflictException({
        code: 'EXHIBIT_IN_USE',
        message: 'Used in text content. Remove it there first.',
      });
    }
    await this.prisma.exhibit.delete({ where: { id: exhibitId } });
    await this.touchCourse(courseId);
    return { deleted: true };
  }

  async saveReadings(
    courseId: string,
    lessonId: string,
    language: string,
    rows: Array<{
      type: string;
      title: string;
      author: string;
      whyRecommended: string;
    }>,
  ) {
    await this.requireLesson(courseId, lessonId);
    const data = rows.map((row, index) => {
      const type = upper(row.type);
      if (!READING_TYPES.has(type)) {
        throw new BadRequestException({
          code: 'READING_TYPE_INVALID',
          message: 'Type must be Book, Article, Paper or Other.',
        });
      }
      return {
        type: type as never,
        title: required(row.title, `Reading ${index + 1} needs a title.`),
        author: required(row.author, `Reading ${index + 1} needs an author.`),
        whyRecommended: required(
          row.whyRecommended,
          `Reading ${index + 1} needs a recommendation.`,
        ),
        sortOrder: index,
      };
    });
    await this.prisma.$transaction(async (tx) => {
      await tx.recommendedReading.deleteMany({ where: { lessonId, language } });
      for (const row of data) {
        await tx.recommendedReading.create({
          data: { lessonId, language, ...row },
        });
      }
      await tx.commerceCourse.update({
        where: { id: courseId },
        data: {
          hasDraft: true,
          draftRevision: { increment: 1 },
          lifecycleStatus: 'WORKING',
        },
      });
    });
    return { count: data.length };
  }

  async saveKnowledgeTest(
    courseId: string,
    lessonId: string,
    enabled: boolean,
    rows: Array<{ code?: string; question: string; referenceAnswer: string }>,
  ) {
    await this.requireLesson(courseId, lessonId);
    await this.prisma.$transaction(async (tx) => {
      await tx.knowledgeQuestion.deleteMany({ where: { lessonId } });
      if (enabled) {
        for (const [index, row] of rows.entries()) {
          await tx.knowledgeQuestion.create({
            data: {
              lessonId,
              code:
                row.code?.trim() || `K-${String(index + 1).padStart(4, '0')}`,
              question: required(
                row.question,
                `Question ${index + 1} is required.`,
              ),
              referenceAnswer: required(
                row.referenceAnswer,
                `Reference answer ${index + 1} is required.`,
              ),
              sortOrder: index,
            },
          });
        }
      }
      await tx.commerceCourse.update({
        where: { id: courseId },
        data: {
          hasDraft: true,
          draftRevision: { increment: 1 },
          lifecycleStatus: 'WORKING',
        },
      });
    });
    return { count: enabled ? rows.length : 0 };
  }

  async saveApplicationTest(
    courseId: string,
    lessonId: string,
    body: { enabled: boolean; scenario?: string; referenceAnswer?: string },
  ) {
    await this.requireLesson(courseId, lessonId);
    if (!body.enabled) {
      await this.prisma.applicationTest.deleteMany({ where: { lessonId } });
    } else {
      await this.prisma.applicationTest.upsert({
        where: { lessonId },
        create: {
          lessonId,
          scenario: required(
            body.scenario,
            'Application question is required.',
          ),
          referenceAnswer: required(
            body.referenceAnswer,
            'Application reference answer is required.',
          ),
          enabled: true,
        },
        update: {
          scenario: required(
            body.scenario,
            'Application question is required.',
          ),
          referenceAnswer: required(
            body.referenceAnswer,
            'Application reference answer is required.',
          ),
          enabled: true,
        },
      });
    }
    await this.touchCourse(courseId);
    return { enabled: body.enabled };
  }

  async parseDocx(
    file: { originalname: string; buffer: Buffer } | undefined,
  ): Promise<{
    html: string;
    messages: Array<{ type: string; message: string }>;
  }> {
    if (!file?.buffer) {
      throw new BadRequestException({
        code: 'FILE_REQUIRED',
        message: 'Upload a .docx file.',
      });
    }
    if (!file.originalname.toLowerCase().endsWith('.docx')) {
      throw new BadRequestException({
        code: 'DOCX_INVALID',
        message: 'Use a .docx file.',
      });
    }
    try {
      const result = await convertDocxToHtml(file.buffer);
      if (!result.html) {
        throw new BadRequestException({
          code: 'DOCX_INVALID',
          message: 'Could not read the Word document.',
        });
      }
      return {
        html: result.html,
        messages: result.warnings.map((message) => ({
          type: 'warning',
          message,
        })),
      };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException({
        code: 'DOCX_INVALID',
        message: 'Could not read the Word document.',
      });
    }
  }

  async importReadings(
    courseId: string,
    file: { originalname: string; buffer: Buffer } | undefined,
  ) {
    const rows = this.readSheet(file);
    const lessons = await this.prisma.lesson.findMany({
      where: { courseId, archivedAt: null },
      select: { id: true, code: true },
    });
    const lessonByCode = new Map(
      lessons.map((lesson) => [lesson.code, lesson]),
    );
    const errors: Array<{ row: number; message: string }> = [];
    let added = 0;
    for (const [index, row] of rows.entries()) {
      const lessonCode = this.cell(row, 'Lesson ID', 'LessonID');
      const lesson = lessonByCode.get(lessonCode);
      if (!lesson) {
        errors.push({
          row: index + 2,
          message: `Lesson ID ${lessonCode || '(empty)'} doesn't exist`,
        });
        continue;
      }
      const type = upper(this.cell(row, 'Type'));
      const title = this.cell(row, 'Title');
      const author = this.cell(row, 'Author');
      const why = this.cell(
        row,
        'Why we recommend it',
        'Why we recommend',
        'Why',
      );
      if (!READING_TYPES.has(type)) {
        errors.push({
          row: index + 2,
          message: 'Type must be Book, Article, Paper or Other',
        });
        continue;
      }
      if (!title) {
        errors.push({ row: index + 2, message: 'Title is empty' });
        continue;
      }
      if (!author) {
        errors.push({ row: index + 2, message: 'Author is empty' });
        continue;
      }
      if (!why) {
        errors.push({
          row: index + 2,
          message: 'Why we recommend it is empty',
        });
        continue;
      }
      const last = await this.prisma.recommendedReading.findFirst({
        where: { lessonId: lesson.id, language: 'en-GB' },
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
      });
      await this.prisma.recommendedReading.create({
        data: {
          lessonId: lesson.id,
          language: 'en-GB',
          type: type as never,
          title,
          author,
          whyRecommended: why,
          sortOrder: (last?.sortOrder ?? -1) + 1,
        },
      });
      added++;
    }
    await this.touchCourse(courseId);
    return { added, errors };
  }

  async importUnderstanding(
    courseId: string,
    language: string,
    file: { originalname: string; buffer: Buffer } | undefined,
    singleLessonId?: string,
  ) {
    void language;
    const rows = this.readSheet(file);
    const expected = [
      'Course ID',
      'Lesson ID',
      'Lesson title',
      'Type',
      'Question',
      'Reference answer',
    ];
    const first = rows[0] ?? {};
    const normalized = new Set(
      Object.keys(first).map((key) => this.normalizeHeader(key)),
    );
    for (const header of expected) {
      if (!normalized.has(this.normalizeHeader(header))) {
        return {
          added: 0,
          byLesson: {},
          errors: [{ row: 1, message: 'Use the template to import questions' }],
        };
      }
    }

    const lessons = await this.prisma.lesson.findMany({
      where: { courseId, archivedAt: null },
      include: { applicationTest: true },
    });
    const lessonByCode = new Map(
      lessons.map((lesson) => [lesson.code, lesson]),
    );
    const errors: Array<{ row: number; message: string }> = [];
    const byLesson: Record<string, number> = {};
    const applicationSeen = new Set<string>();
    let added = 0;

    for (const [index, row] of rows.entries()) {
      const rowNo = index + 2;
      const lessonCode = this.cell(row, 'Lesson ID', 'LessonID');
      const lesson = lessonByCode.get(lessonCode);
      if (singleLessonId && lesson?.id !== singleLessonId) continue;
      if (!lesson) {
        errors.push({
          row: rowNo,
          message: `Lesson ID ${lessonCode || '(empty)'} doesn't exist`,
        });
        continue;
      }
      const type = this.cell(row, 'Type');
      const question = this.cell(row, 'Question');
      const referenceAnswer = this.cell(
        row,
        'Reference answer',
        'Reference Answer',
      );
      if (type !== 'Knowledge' && type !== 'Application') {
        errors.push({
          row: rowNo,
          message: 'Type must be Knowledge or Application',
        });
        continue;
      }
      if (!question) {
        errors.push({ row: rowNo, message: 'Question is empty' });
        continue;
      }
      if (!referenceAnswer) {
        errors.push({ row: rowNo, message: 'Reference answer is empty' });
        continue;
      }
      if (type === 'Application') {
        if (lesson.applicationTest || applicationSeen.has(lessonCode)) {
          errors.push({
            row: rowNo,
            message: `${lessonCode} already has an Application Test`,
          });
          continue;
        }
        applicationSeen.add(lessonCode);
        await this.prisma.applicationTest.create({
          data: {
            lessonId: lesson.id,
            scenario: question,
            referenceAnswer,
            enabled: true,
          },
        });
      } else {
        const count = await this.prisma.knowledgeQuestion.count({
          where: { lessonId: lesson.id },
        });
        await this.prisma.knowledgeQuestion.create({
          data: {
            lessonId: lesson.id,
            code: `K-${String(count + 1).padStart(4, '0')}`,
            question,
            referenceAnswer,
            sortOrder: count,
          },
        });
      }
      byLesson[lessonCode] = (byLesson[lessonCode] ?? 0) + 1;
      added++;
    }
    if (added > 0) await this.touchCourse(courseId);
    return { added, byLesson, errors };
  }

  async downloadUnderstandingTemplate(courseId: string): Promise<string> {
    const lessons = await this.prisma.lesson.findMany({
      where: { courseId, archivedAt: null },
      orderBy: { sortOrder: 'asc' },
      include: { localizations: true },
    });
    const course = await this.prisma.commerceCourse.findUnique({
      where: { id: courseId },
      select: { code: true },
    });
    const lines = [
      'Course ID,Lesson ID,Lesson title,Type,Question,Reference answer',
    ];
    for (const lesson of lessons) {
      const title = lesson.localizations[0]?.title ?? lesson.code;
      lines.push(`${course?.code ?? ''},${lesson.code},${csv(title)},,`);
    }
    return lines.join('\n');
  }

  /** 供分块上传在收第一块之前就确认课程存在（避免大文件传完才发现 404）。 */
  async ensureCourseExists(courseId: string): Promise<void> {
    await this.assertCourse(courseId);
  }

  private async assertCourse(courseId: string) {
    const course = await this.prisma.commerceCourse.findUnique({
      where: { id: courseId },
      select: { id: true },
    });
    if (!course)
      throw new NotFoundException({
        code: 'COURSE_NOT_FOUND',
        message: 'Course not found.',
      });
  }

  private async touchCourse(courseId: string) {
    await this.prisma.commerceCourse.update({
      where: { id: courseId },
      data: {
        hasDraft: true,
        draftRevision: { increment: 1 },
        lifecycleStatus: 'WORKING',
        draftSourceType: null,
        draftSourceEnvironment: null,
        draftSourceVersionLabel: null,
      },
    });
  }

  private async requireLesson(courseId: string, lessonId: string) {
    const lesson = await this.prisma.lesson.findFirst({
      where: { id: lessonId, courseId, archivedAt: null },
      include: {
        localizations: true,
        learningPoints: true,
        exhibits: true,
        triggers: true,
      },
    });
    if (!lesson)
      throw new NotFoundException({
        code: 'LESSON_NOT_FOUND',
        message: 'Lesson not found.',
      });
    return lesson;
  }

  private async requireAsset(courseId: string, assetId: string) {
    const asset = await this.prisma.courseMediaAsset.findFirst({
      where: { id: assetId, courseId },
    });
    if (!asset)
      throw new NotFoundException({
        code: 'MEDIA_NOT_FOUND',
        message: 'Media asset not found.',
      });
    return asset;
  }

  private async nextExhibitCode(courseId: string): Promise<string> {
    const rows = await this.prisma.exhibit.findMany({
      where: { lesson: { courseId } },
      select: { code: true },
    });
    let max = 0;
    for (const row of rows) {
      const match = /^E(\d+)$/i.exec(row.code);
      if (match) max = Math.max(max, Number(match[1]));
    }
    return `E${String(max + 1).padStart(3, '0')}`;
  }

  private assertExpectedKind(
    kind: MediaKind,
    expected?: 'COVER' | 'VIDEO' | 'IMAGE',
  ) {
    if (!expected) return;
    if (expected === 'VIDEO' && kind !== 'VIDEO') {
      throw new BadRequestException({
        code: 'VIDEO_REQUIRED',
        message: 'Please upload a video file.',
      });
    }
    if ((expected === 'IMAGE' || expected === 'COVER') && kind !== 'IMAGE') {
      throw new BadRequestException({
        code: 'IMAGE_REQUIRED',
        message: 'Please upload an image file.',
      });
    }
  }

  private readSheet(
    file: { originalname: string; buffer: Buffer } | undefined,
  ) {
    if (!file?.buffer) {
      throw new BadRequestException({
        code: 'FILE_REQUIRED',
        message: 'Upload an .xlsx or .csv file.',
      });
    }
    try {
      const workbook = XLSX.read(file.buffer, { type: 'buffer' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!sheet) throw new Error('No sheet');
      return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
        defval: '',
        raw: false,
      });
    } catch {
      throw new BadRequestException({
        code: 'SHEET_INVALID',
        message: 'Could not read the spreadsheet.',
      });
    }
  }

  private normalizeHeader(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  private cell(row: Record<string, unknown>, ...names: string[]): string {
    const entries = Object.entries(row);
    for (const name of names) {
      const normalized = this.normalizeHeader(name);
      const found = entries.find(
        ([key]) => this.normalizeHeader(key) === normalized,
      );
      if (found) {
        const value = found[1];
        return typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean'
          ? String(value).trim()
          : '';
      }
    }
    return '';
  }
}

function csv(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

import type {
  PackageCourse,
  PackageLesson,
  PackageLessonLocalization,
  PackageExhibit,
  PackageReading,
  PackageKnowledgeQuestion,
  PackageTrial,
} from './contracts/manifest';
import type { Lesson, CommerceCourse } from '@prisma/client';

/**
 * 把 v2 数据库聚合（含 relations）转成课程包 `PackageCourse`（导出用），
 * 与导入方向共用字段定义，保证往返一致。媒体二进制由包服务另行打包。
 */

type ExhibitRow = {
  id: string;
  code: string;
  type: string;
  media?: { storageKey: string } | null;
  thumbnail?: { storageKey: string } | null;
  sourceText: string | null;
  localized: unknown;
};
type LessonLocRow = {
  language: string;
  title: string;
  description: string | null;
  video?: { storageKey: string | null; originalName?: string } | null;
  videoDurationSeconds: number | null;
  textHtml: string | null;
  textLearningPoints: unknown;
};
type LessonRow = Lesson & {
  localizations: LessonLocRow[];
  exhibits: ExhibitRow[];
  readings: {
    language: string;
    type: string;
    title: string;
    author: string | null;
    whyRecommended: string | null;
    sortOrder: number;
  }[];
  questions: {
    code: string;
    question: string;
    referenceAnswer: string | null;
    sortOrder: number;
  }[];
  applicationTest: {
    scenario: string;
    referenceAnswer: string | null;
    enabled: boolean;
  } | null;
  learningPoints: {
    id: string;
    language: string;
    code: string;
    title: string;
    source: string;
    timeSeconds: number | null;
    sortOrder: number;
  }[];
  triggers: { exhibitId: string; language: string; timeSeconds: number }[];
};
export type CourseAggregate = CommerceCourse & {
  category?: { id: string; name: string } | null;
  localizations: {
    language: string;
    title: string;
    shortDescription: string | null;
    overview: string | null;
    whatYouLearn: unknown;
    provides: unknown;
  }[];
  lessons: LessonRow[];
  trialRows: {
    lessonId: string;
    videoCutoffSeconds: number | null;
    textCutoffLearningPointId: string | null;
    status: string;
  }[];
  cover?: { storageKey: string } | null;
  plans?: Array<{
    name: string;
    termMonths: number;
    amountMinor: number;
    currency: string;
    stripeLookupKey: string | null;
  }>;
};

/** 媒体在包内的相对路径约定。 */
export const packageMediaPath = {
  cover: (ext: string) => `media/cover.${ext}`,
  video: (lessonCode: string, lang: string, ext: string) =>
    `media/video/${lessonCode}/${lang}.${ext}`,
  exhibit: (code: string, ext: string) => `media/exhibits/${code}.${ext}`,
  exhibitThumb: (code: string, ext: string) =>
    `media/exhibits/${code}.thumb.${ext}`,
};

export interface SnapshotMediaRef {
  path: string;
  storageKey: string;
  assetId: string;
}

export interface CourseSnapshot {
  course: PackageCourse;
  media: SnapshotMediaRef[];
}

export function buildCourseSnapshot(
  agg: CourseAggregate,
  categoryPath?: string[] | null,
): CourseSnapshot {
  const media: SnapshotMediaRef[] = [];
  const addMedia = (
    path: string,
    asset: { storageKey: string } | null | undefined,
  ): string | undefined => {
    if (!asset) return undefined;
    media.push({ path, storageKey: asset.storageKey, assetId: '' });
    return path;
  };

  const cover = agg.cover
    ? addMedia(packageMediaPath.cover(extOf(agg.cover.storageKey)), agg.cover)
    : undefined;

  const lessons: PackageLesson[] = [...agg.lessons]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((lesson) => {
      const localized: Record<string, PackageLessonLocalization> = {};
      for (const loc of lesson.localizations) {
        const lps = (lesson.learningPoints ?? [])
          .filter((lp) => lp.language === loc.language)
          .sort((a, b) => a.sortOrder - b.sortOrder);
        const videoRef = loc.video?.storageKey
          ? addMedia(
              packageMediaPath.video(
                lesson.code,
                loc.language,
                extOf(loc.video.storageKey, loc.video.originalName),
              ),
              { storageKey: loc.video.storageKey },
            )
          : undefined;
        localized[loc.language] = {
          title: loc.title,
          description: loc.description ?? undefined,
          video: loc.video
            ? {
                file: videoRef as string,
                durationSeconds: loc.videoDurationSeconds ?? undefined,
                learningPoints: lps
                  .filter((lp) => lp.source === 'VIDEO')
                  .map((lp) => ({
                    code: lp.code,
                    // C7：无时间源不写 0（0 会被当成真实起点伪造时间）；
                    // 显式 null 表示“本环境没有可派生的机器时间源”。
                    timeSeconds: lp.timeSeconds ?? null,
                    title: lp.title,
                  })),
                exhibitTriggers: lesson.triggers
                  .filter((t) => t.language === loc.language)
                  .map((t) => ({
                    timeSeconds: t.timeSeconds,
                    exhibitRef: exhibitCodeById(lesson.exhibits, t.exhibitId),
                  }))
                  .filter(
                    (t): t is { timeSeconds: number; exhibitRef: string } =>
                      Boolean(t.exhibitRef),
                  ),
              }
            : null,
          text: loc.textHtml
            ? {
                html: loc.textHtml,
                learningPoints: lps
                  .filter((lp) => lp.source === 'TEXT')
                  .map((lp) => ({ code: lp.code, heading: lp.title })),
              }
            : null,
        };
      }

      const exhibits: PackageExhibit[] = lesson.exhibits.map((ex) => ({
        code: ex.code,
        type: ex.type as PackageExhibit['type'],
        file: ex.media?.storageKey
          ? addMedia(
              packageMediaPath.exhibit(ex.code, extOf(ex.media.storageKey)),
              { storageKey: ex.media.storageKey },
            )
          : undefined,
        thumbnail: ex.thumbnail?.storageKey
          ? addMedia(
              packageMediaPath.exhibitThumb(
                ex.code,
                extOf(ex.thumbnail.storageKey),
              ),
              { storageKey: ex.thumbnail.storageKey },
            )
          : undefined,
        source: ex.sourceText ?? undefined,
        localized: (ex.localized as PackageExhibit['localized']) ?? {},
      }));

      const reading: Record<string, PackageReading[]> = {};
      for (const r of lesson.readings.sort(
        (a, b) => a.sortOrder - b.sortOrder,
      )) {
        (reading[r.language] ??= []).push({
          type: r.type as PackageReading['type'],
          title: r.title,
          author: r.author ?? undefined,
          why: r.whyRecommended ?? undefined,
        });
      }

      const questions: PackageKnowledgeQuestion[] = lesson.questions
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((q) => ({
          code: q.code,
          question: q.question,
          referenceAnswer: q.referenceAnswer ?? undefined,
        }));

      return {
        code: lesson.code,
        order: lesson.sortOrder,
        localized,
        exhibits,
        recommendedReading: reading,
        knowledgeTest: { enabled: questions.length > 0, questions },
        applicationTest: lesson.applicationTest
          ? {
              enabled: lesson.applicationTest.enabled,
              scenario: lesson.applicationTest.scenario,
              referenceAnswer:
                lesson.applicationTest.referenceAnswer ?? undefined,
            }
          : undefined,
      };
    });

  const lpCodeById = new Map<string, string>();
  for (const lesson of agg.lessons) {
    for (const lp of lesson.learningPoints ?? []) {
      lpCodeById.set(lp.id, lp.code);
    }
  }
  const trial: PackageTrial = {
    enabled: agg.trialEnabled,
    lessons: agg.trialRows.map((t) => ({
      lessonRef: lessonCodeById(agg.lessons, t.lessonId),
      videoCutoffSeconds: t.videoCutoffSeconds,
      textCutoffLearningPoint: t.textCutoffLearningPointId
        ? (lpCodeById.get(t.textCutoffLearningPointId) ?? null)
        : null,
      status: t.status as PackageTrial['lessons'][number]['status'],
    })),
  };

  const courseLocalized: PackageCourse['localized'] = {};
  for (const loc of agg.localizations) {
    courseLocalized[loc.language] = {
      title: loc.title,
      shortDescription: loc.shortDescription ?? undefined,
      overview: loc.overview ?? undefined,
      whatYouLearn: (loc.whatYouLearn as string[] | null) ?? [],
      provides: (loc.provides as unknown[] | null) ?? [],
    };
  }

  const course: PackageCourse = {
    code: agg.code,
    slug: agg.slug,
    // C6：稳定键路径（完整父链；二级分类不丢末级）。未分类 → null。
    // 禁止任何占位分类（M5）。调用方未提供路径时回退到单级 name 仅为兼容
    // 旧调用方；导出路径一律传入 categoryPathForId 的完整序列。
    categoryPath:
      categoryPath !== undefined
        ? categoryPath
        : agg.category
          ? [agg.category.name]
          : null,
    learningMode: agg.learningMode,
    learningLanguages: (agg.learningLanguages as string[]) ?? [
      agg.defaultContentLanguage,
    ],
    defaultContentLanguage: agg.defaultContentLanguage,
    cover,
    localized: courseLocalized,
    lessons,
    trial,
    pricing: (agg.plans ?? [])
      .filter((plan) => Boolean(plan.stripeLookupKey))
      .map((plan) => ({
        name: plan.name,
        termMonths: plan.termMonths,
        amountMinor: plan.amountMinor,
        currency: plan.currency,
        lookupKey: plan.stripeLookupKey as string,
      })),
  };

  return { course, media };
}

function extOf(storageKey: string, originalName?: string): string {
  const fromKey = storageKey.split('.').pop();
  if (fromKey && fromKey !== storageKey && fromKey.length <= 5) return fromKey;
  if (originalName) {
    const fromName = originalName.split('.').pop();
    if (fromName) return fromName.toLowerCase();
  }
  return 'bin';
}

function exhibitCodeById(
  exhibits: ExhibitRow[],
  exhibitId: string,
): string | undefined {
  return exhibits.find((exhibit) => exhibit.id === exhibitId)?.code;
}

function lessonCodeById(lessons: LessonRow[], lessonId: string): string {
  return lessons.find((l) => l.id === lessonId)?.code ?? lessonId;
}

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { computeCompleteness } from './completeness';
import {
  detailToCompletenessInput,
  snapshotToCompletenessInput,
  type VersionSnapshot,
} from './version-snapshot';
import { TrialService } from './trial.service';
import { categoryRef, EXHIBIT_FIELDS } from './localized-fields';
import { parseLocalized, pickLocalized } from '../common/i18n/localized';

/**
 * 学员视角预览（PRD §10 / §15，对齐 Portal modeling-life 详情页字段）。
 * 只投影前台会看到的内容：
 * - Study & Exploration 未完成的 Lesson 不显示；
 * - Understanding 未完成的 Lesson 不显示测试；
 * - Trial 未完成则不提供试看。
 */
@Injectable()
export class PreviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly trial: TrialService,
  ) {}

  async preview(courseId: string, versionId?: string) {
    const course = await this.prisma.commerceCourse.findUnique({
      where: { id: courseId },
      include: { category: true, cover: true },
    });
    if (!course)
      throw new NotFoundException({
        code: 'COURSE_NOT_FOUND',
        message: 'Course not found',
      });

    const trial = await this.trial.get(courseId);
    const plans = await this.prisma.coursePlan.findMany({
      where: { courseId, active: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    let content: VersionSnapshot['course'];
    let versionLabel: string | null = null;
    let completeness;
    if (versionId) {
      const version = await this.prisma.courseVersion.findFirst({
        where: { id: versionId, courseId },
        select: { versionLabel: true, snapshotData: true },
      });
      if (!version)
        throw new NotFoundException({
          code: 'VERSION_NOT_FOUND',
          message: 'Version not found',
        });
      const snapshot = version.snapshotData as unknown as VersionSnapshot;
      content = snapshot.course;
      versionLabel = version.versionLabel;
      completeness = computeCompleteness(
        snapshotToCompletenessInput(snapshot, {
          trialEnabled: trial.enabled,
          trialRows: trial.rows.filter((row) => row.inTrial),
        }),
      );
    } else {
      const detail = await this.prisma.commerceCourse.findUnique({
        where: { id: courseId },
        include: {
          localizations: true,
          trialRows: true,
          lessons: {
            where: { archivedAt: null },
            orderBy: { sortOrder: 'asc' },
            include: {
              localizations: { include: { video: true } },
              exhibits: { include: { media: true, thumbnail: true } },
              readings: { orderBy: { sortOrder: 'asc' } },
              questions: { orderBy: { sortOrder: 'asc' } },
              applicationTest: true,
              learningPoints: { orderBy: { sortOrder: 'asc' } },
              triggers: true,
            },
          },
        },
      });
      if (!detail)
        throw new NotFoundException({
          code: 'COURSE_NOT_FOUND',
          message: 'Course not found',
        });
      completeness = computeCompleteness(detailToCompletenessInput(detail));
      content = {
        code: detail.code,
        slug: detail.slug,
        categoryId: detail.categoryId,
        coverAssetId: detail.coverAssetId,
        learningMode: detail.learningMode,
        defaultContentLanguage: detail.defaultContentLanguage,
        learningLanguages: (detail.learningLanguages as string[]) ?? [],
        localizations: detail.localizations.map((loc) => ({
          language: loc.language,
          title: loc.title,
          shortDescription: loc.shortDescription,
          overview: loc.overview,
          whatYouLearn: loc.whatYouLearn,
          provides: loc.provides,
        })),
        lessons: detail.lessons.map((lesson) => ({
          id: lesson.id,
          code: lesson.code,
          sortOrder: lesson.sortOrder,
          localizations: lesson.localizations.map((loc) => ({
            language: loc.language,
            title: loc.title,
            description: loc.description,
            videoAssetId: loc.videoAssetId,
            videoDurationSeconds: loc.videoDurationSeconds,
            textHtml: loc.textHtml,
            textLearningPoints: loc.textLearningPoints,
          })),
          exhibits: lesson.exhibits.map((exhibit) => ({
            code: exhibit.code,
            type: exhibit.type,
            mediaAssetId: exhibit.mediaAssetId,
            thumbnailAssetId: exhibit.thumbnailAssetId,
            sourceText: exhibit.sourceText,
            localized: exhibit.localized,
          })),
          learningPoints: lesson.learningPoints.map((lp) => ({
            language: lp.language,
            code: lp.code,
            title: lp.title,
            source: lp.source,
            timeSeconds: lp.timeSeconds,
            anchorHeading: lp.anchorHeading,
            sortOrder: lp.sortOrder,
          })),
          triggers: lesson.triggers.map((trigger) => ({
            exhibitCode:
              lesson.exhibits.find(
                (exhibit) => exhibit.id === trigger.exhibitId,
              )?.code ?? '',
            language: trigger.language,
            timeSeconds: trigger.timeSeconds,
          })),
          readings: lesson.readings.map((reading) => ({
            language: reading.language,
            type: reading.type,
            title: reading.title,
            author: reading.author,
            whyRecommended: reading.whyRecommended,
            sortOrder: reading.sortOrder,
          })),
          questions: lesson.questions.map((question) => ({
            code: question.code,
            question: question.question,
            referenceAnswer: question.referenceAnswer,
            sortOrder: question.sortOrder,
            enabled: question.enabled,
          })),
          applicationTest: lesson.applicationTest
            ? {
                scenario: lesson.applicationTest.scenario,
                referenceAnswer: lesson.applicationTest.referenceAnswer,
                enabled: lesson.applicationTest.enabled,
              }
            : null,
        })),
      };
    }

    const completenessByLesson = new Map(
      completeness.steps.content.lessons.map((lesson) => [
        lesson.lessonId,
        lesson,
      ]),
    );
    const trialByLesson = new Map(trial.rows.map((row) => [row.lessonId, row]));
    const defaultLanguage = content.defaultContentLanguage;
    const lessons = content.lessons
      .filter((lesson) => completenessByLesson.get(lesson.id)?.studyComplete)
      .map((lesson, index) => {
        const loc =
          lesson.localizations.find(
            (entry) => entry.language === defaultLanguage,
          ) ?? lesson.localizations[0];
        const lessonComplete = completenessByLesson.get(lesson.id);
        const trialRow = trialByLesson.get(lesson.id);
        const exhibits = lesson.exhibits.map((exhibit) => {
          const localized = parseLocalized(exhibit.localized, EXHIBIT_FIELDS);
          return {
            code: exhibit.code,
            type: exhibit.type,
            mediaAssetId: exhibit.mediaAssetId,
            thumbnailAssetId: exhibit.thumbnailAssetId,
            title: pickLocalized(
              localized,
              'title',
              defaultLanguage,
              exhibit.code,
            ),
            description:
              pickLocalized(localized, 'description', defaultLanguage, '') ||
              null,
            triggers: lesson.triggers
              .filter((trigger) => trigger.exhibitCode === exhibit.code)
              .map((trigger) => ({
                language: trigger.language,
                timeSeconds: trigger.timeSeconds,
              })),
          };
        });
        return {
          id: lesson.id,
          code: lesson.code,
          index: index + 1,
          title: loc?.title ?? lesson.code,
          description: loc?.description ?? null,
          videoAssetId: loc?.videoAssetId ?? null,
          videoDurationSeconds: loc?.videoDurationSeconds ?? null,
          textHtml: loc?.textHtml ?? null,
          learningPoints: lesson.learningPoints
            .filter((lp) => lp.language === defaultLanguage)
            .map((lp) => ({
              code: lp.code,
              title: lp.title,
              source: lp.source,
              timeSeconds: lp.timeSeconds,
            })),
          exhibits,
          readings: lesson.readings
            .filter((reading) => reading.language === defaultLanguage)
            .map((reading) => ({
              type: reading.type,
              title: reading.title,
              author: reading.author,
              whyRecommended: reading.whyRecommended,
            })),
          knowledgeTest: lessonComplete?.understandingComplete
            ? {
                enabled: lesson.questions.length > 0,
                questions: lesson.questions.map((question) => ({
                  code: question.code,
                  question: question.question,
                })),
              }
            : { enabled: false, questions: [] },
          applicationTest:
            lessonComplete?.understandingComplete && lesson.applicationTest
              ? { scenario: lesson.applicationTest.scenario }
              : null,
          trial:
            trial.enabled && trialRow?.inTrial
              ? {
                  videoCutoffSeconds: trialRow.videoCutoffSeconds,
                  textCutoffLearningPointId: trialRow.textCutoffLearningPointId,
                  status: trialRow.status,
                }
              : null,
        };
      });

    const totalDurationSeconds = lessons.reduce(
      (sum, lesson) => sum + (lesson.videoDurationSeconds ?? 0),
      0,
    );
    const defaultLoc =
      content.localizations.find((loc) => loc.language === defaultLanguage) ??
      content.localizations[0];

    return {
      id: courseId,
      code: content.code,
      slug: content.slug,
      versionLabel,
      category: categoryRef(course.category),
      learningMode: content.learningMode,
      learningLanguages: content.learningLanguages,
      defaultContentLanguage: defaultLanguage,
      coverUrl: course.cover
        ? `/api/backoffice/courses/${courseId}/cover`
        : null,
      title: defaultLoc?.title ?? content.slug,
      shortDescription: defaultLoc?.shortDescription ?? null,
      overview: defaultLoc?.overview ?? null,
      whatYouLearn: defaultLoc?.whatYouLearn ?? [],
      provides: defaultLoc?.provides ?? [],
      localizations: content.localizations,
      lessonCount: lessons.length,
      totalDurationSeconds,
      lessons,
      trial: {
        enabled: trial.enabled,
        available: completeness.steps.trial.complete,
        rows: trial.rows.filter((row) => row.inTrial),
      },
      plans,
      completeness,
    };
  }
}

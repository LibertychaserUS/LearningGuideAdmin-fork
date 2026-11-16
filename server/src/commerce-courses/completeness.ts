/**
 * 课程完成度（PRD §10 / §15 / §20）。
 *
 * 三个步骤：Course Information / Course Content / Trial。
 * 同一套规则用于：编辑器步骤条、Publish 门禁、Export 门禁。
 * 工作区（草稿）与版本快照都归一化成这里的输入形状，避免两套判断。
 */

import { parseTextLearningPoints } from './course-authoring.service';

export interface ContentLessonLocalization {
  language: string;
  title?: string | null;
  description?: string | null;
  videoAssetId?: string | null;
  video?: { id: string } | null;
  videoDurationSeconds?: number | null;
  textHtml?: string | null;
}

export interface ContentExhibitLocalization {
  title?: string | null;
  description?: string | null;
}

/** 展品（PRD 12.4 / 20 #16）。localized 以学习语言为 key。 */
export interface ContentExhibit {
  id?: string;
  code?: string | null;
  type?: string | null;
  mediaAssetId?: string | null;
  media?: { id: string } | null;
  thumbnailAssetId?: string | null;
  thumbnail?: { id: string } | null;
  localized?: Record<
    string,
    ContentExhibitLocalization | null | undefined
  > | null;
}

/** 延伸阅读（PRD 12.6 / 20 #19）。 */
export interface ContentReading {
  type?: string | null;
  title?: string | null;
  author?: string | null;
  whyRecommended?: string | null;
}

export interface ContentLesson {
  id: string;
  code: string;
  sortOrder: number;
  archivedAt?: Date | string | null;
  localizations: ContentLessonLocalization[];
  learningPoints?: Array<{ language: string; source: string }>;
  exhibits?: ContentExhibit[];
  readings?: ContentReading[];
  questions?: Array<{
    question?: string | null;
    referenceAnswer?: string | null;
  }>;
  applicationTest?: {
    scenario?: string | null;
    referenceAnswer?: string | null;
    enabled?: boolean;
  } | null;
}

export interface ContentLocalization {
  language: string;
  title?: string | null;
  shortDescription?: string | null;
  overview?: string | null;
  whatYouLearn?: unknown;
  provides?: unknown;
}

export interface ContentTrialRow {
  lessonId: string;
  status?: string | null;
  videoCutoffSeconds?: number | null;
  textCutoffLearningPointId?: string | null;
}

export interface CompletenessInput {
  categoryId?: string | null;
  learningMode: string;
  learningLanguages: string[];
  localizations: ContentLocalization[];
  lessons: ContentLesson[];
  trialEnabled: boolean;
  trialRows: ContentTrialRow[];
}

export interface LessonCompleteness {
  lessonId: string;
  code: string;
  studyComplete: boolean;
  understandingComplete: boolean;
  missing: string[];
}

export interface StepCompleteness {
  complete: boolean;
  missing: string[];
}

export interface CourseCompleteness {
  steps: {
    courseInformation: StepCompleteness;
    content: StepCompleteness & { lessons: LessonCompleteness[] };
    trial: StepCompleteness;
  };
  completedSteps: number;
  /** Publish 允许不完整，但必须满足：CI 完成 + 至少 1 个 Lesson 的 Study 完成 */
  canPublish: boolean;
  publishBlockers: string[];
}

const MODE_HAS_VIDEO = (mode: string) => mode !== 'TEXT_ONLY';
const MODE_HAS_TEXT = (mode: string) => mode !== 'VIDEO_ONLY';

/** Course Information 与 Lesson 标题/描述始终中英文必填（PRD 11.5 / 20）。 */
const BILINGUAL_LANGUAGES = ['en-GB', 'zh-CN'] as const;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function listLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function videoId(loc: ContentLessonLocalization): string | null {
  return loc.videoAssetId ?? loc.video?.id ?? null;
}

export function computeCompleteness(
  input: CompletenessInput,
): CourseCompleteness {
  const lessons = input.lessons.filter((lesson) => !lesson.archivedAt);

  // ===== Step 1: Course Information =====
  const ciMissing: string[] = [];
  if (!input.categoryId) ciMissing.push('Category is required.');
  if (input.learningLanguages.length === 0)
    ciMissing.push('At least one learning language is required.');
  // Course Information 是元数据，始终中英文并列必填（PRD 11.5 / 20 #1 #6）。
  for (const language of BILINGUAL_LANGUAGES) {
    const loc = input.localizations.find((row) => row.language === language);
    if (!loc) {
      ciMissing.push(`Course information is missing for ${language}.`);
      continue;
    }
    if (!text(loc.title)) ciMissing.push(`Title is required (${language}).`);
    if (!text(loc.shortDescription))
      ciMissing.push(`Short description is required (${language}).`);
    if (!text(loc.overview))
      ciMissing.push(`Overview is required (${language}).`);
    if (listLength(loc.whatYouLearn) < 4)
      ciMissing.push(
        `Add at least 4 items to What you'll learn (${language}).`,
      );
    const providesCount = listLength(loc.provides);
    if (providesCount < 4)
      ciMissing.push(
        `Add at least 4 items to This course provides (${language}).`,
      );
    if (providesCount > 6)
      ciMissing.push(
        `This course provides allows at most 6 items (${language}).`,
      );
  }
  const courseInformation: StepCompleteness = {
    complete: ciMissing.length === 0,
    missing: ciMissing,
  };

  // ===== Step 2: Course Content =====
  const lessonResults: LessonCompleteness[] = lessons.map((lesson) => {
    const studyMissing: string[] = [];
    const understandingMissing: string[] = [];
    const lps = lesson.learningPoints ?? [];

    for (const language of input.learningLanguages) {
      const loc = lesson.localizations.find((row) => row.language === language);
      if (!loc) {
        studyMissing.push(
          `Lesson ${lesson.code}: missing ${language} content.`,
        );
        continue;
      }
      if (MODE_HAS_VIDEO(input.learningMode)) {
        if (!videoId(loc))
          studyMissing.push(
            `Lesson ${lesson.code}: video is required (${language}).`,
          );
        if (!loc.videoDurationSeconds || loc.videoDurationSeconds <= 0) {
          studyMissing.push(
            `Lesson ${lesson.code}: video duration is missing (${language}).`,
          );
        }
        if (
          !lps.some((lp) => lp.language === language && lp.source === 'VIDEO')
        ) {
          studyMissing.push(
            `Lesson ${lesson.code}: add at least 1 video learning point (${language}).`,
          );
        }
      }
      if (MODE_HAS_TEXT(input.learningMode)) {
        if (!text(loc.textHtml))
          studyMissing.push(
            `Lesson ${lesson.code}: text content is required (${language}).`,
          );
        if (
          !lps.some((lp) => lp.language === language && lp.source === 'TEXT')
        ) {
          studyMissing.push(
            `Lesson ${lesson.code}: add at least 1 text learning point (${language}).`,
          );
        }
        // H1 即 LP；至少 1 个 LP，且每个标题下正文非空（PRD 12.5.2 / 20 #14 #15）。
        const parsed = loc.textHtml
          ? parseTextLearningPoints(loc.textHtml)
          : [];
        // 解析器会过滤空标题；完成度侧按原文补判：
        // 存在 H1 但标题文字为空 → Title can't be empty（PRD §20 #15）。
        const h1Count = loc.textHtml
          ? [...loc.textHtml.matchAll(/<h1\b[^>]*>[\s\S]*?<\/h1>/gi)].length
          : 0;
        if (h1Count > parsed.length) {
          studyMissing.push(
            `Lesson ${lesson.code}: Title can't be empty (${language}).`,
          );
        }
        if (parsed.length === 0) {
          studyMissing.push(
            `Lesson ${lesson.code}: No learning points found. Set each learning point title as Heading 1 (H1) (${language}).`,
          );
        }
        for (const point of parsed) {
          if (!point.hasBody) {
            studyMissing.push(
              `Lesson ${lesson.code}: No text under this heading (${language}): ${point.heading}.`,
            );
          }
        }
      }
    }

    // Lesson 标题/描述始终中英文并列必填（PRD 11.5 / 20 #7）；
    // 视频、文本、LP、展品标题与描述等其余内容仍按学习语言校验。
    for (const language of BILINGUAL_LANGUAGES) {
      const loc = lesson.localizations.find((row) => row.language === language);
      if (!loc) {
        studyMissing.push(
          `Lesson ${lesson.code}: title is required (${language}).`,
        );
        studyMissing.push(
          `Lesson ${lesson.code}: description is required (${language}).`,
        );
        continue;
      }
      if (!text(loc.title))
        studyMissing.push(
          `Lesson ${lesson.code}: title is required (${language}).`,
        );
      if (!text(loc.description))
        studyMissing.push(
          `Lesson ${lesson.code}: description is required (${language}).`,
        );
    }

    // 展品：类型、文件、缩略图齐全，且每种学习语言的标题与描述非空。
    // 批量上传留下的 localized 为空 / 无缩略图的行自然命中未完成（PRD 12.4 / 20 #16）。
    for (const [index, exhibit] of (lesson.exhibits ?? []).entries()) {
      const label = `Lesson ${lesson.code}: exhibit ${exhibit.code ?? index + 1}`;
      if (!text(exhibit.type))
        studyMissing.push(`${label}: media type is required.`);
      if (!(exhibit.mediaAssetId ?? exhibit.media?.id))
        studyMissing.push(`${label}: file is required.`);
      if (!(exhibit.thumbnailAssetId ?? exhibit.thumbnail?.id))
        studyMissing.push(`${label}: thumbnail is required.`);
      for (const language of input.learningLanguages) {
        const loc = exhibit.localized?.[language];
        if (!loc || !text(loc.title))
          studyMissing.push(`${label}: title is required (${language}).`);
        if (!loc || !text(loc.description))
          studyMissing.push(`${label}: description is required (${language}).`);
      }
    }

    // Recommended reading：列表为空，或某行缺 Type / Title / Author / Why we recommend it
    // → Study & Exploration Incomplete（PRD 12.6 / 20 #19）。
    const readings = lesson.readings ?? [];
    if (readings.length === 0) {
      studyMissing.push(
        `Lesson ${lesson.code}: Recommended reading list is empty.`,
      );
    } else {
      for (const [index, reading] of readings.entries()) {
        const label = `Lesson ${lesson.code}: recommended reading ${index + 1}`;
        if (!text(reading.type))
          studyMissing.push(`${label}: type is required.`);
        if (!text(reading.title))
          studyMissing.push(`${label}: title is required.`);
        if (!text(reading.author))
          studyMissing.push(`${label}: author is required.`);
        if (!text(reading.whyRecommended))
          studyMissing.push(`${label}: why we recommend it is required.`);
      }
    }

    const questions = lesson.questions ?? [];
    for (const [index, question] of questions.entries()) {
      if (!text(question.question))
        understandingMissing.push(
          `Lesson ${lesson.code}: knowledge question ${index + 1} needs a question.`,
        );
      if (!text(question.referenceAnswer)) {
        understandingMissing.push(
          `Lesson ${lesson.code}: knowledge question ${index + 1} needs a reference answer.`,
        );
      }
    }
    if (lesson.applicationTest && lesson.applicationTest.enabled !== false) {
      if (!text(lesson.applicationTest.scenario)) {
        understandingMissing.push(
          `Lesson ${lesson.code}: application test needs a question.`,
        );
      }
      if (!text(lesson.applicationTest.referenceAnswer)) {
        understandingMissing.push(
          `Lesson ${lesson.code}: application test needs a reference answer.`,
        );
      }
    }

    return {
      lessonId: lesson.id,
      code: lesson.code,
      studyComplete: studyMissing.length === 0,
      understandingComplete: understandingMissing.length === 0,
      missing: [...studyMissing, ...understandingMissing],
    };
  });

  const contentMissing: string[] = [];
  if (lessons.length === 0) contentMissing.push('Add at least 1 lesson.');
  for (const result of lessonResults) {
    if (!result.studyComplete) {
      contentMissing.push(
        `Lesson ${result.code}: Study & Exploration is incomplete.`,
      );
    }
    if (result.understandingComplete === false) {
      contentMissing.push(
        `Lesson ${result.code}: Understanding is incomplete.`,
      );
    }
  }
  const content = {
    complete: contentMissing.length === 0,
    missing: contentMissing,
    lessons: lessonResults,
  };

  // ===== Step 3: Trial =====
  const trialMissing: string[] = [];
  if (input.trialEnabled) {
    const ordered = [...lessons].sort((a, b) => a.sortOrder - b.sortOrder);
    const trialRows = input.trialRows.filter((row) =>
      ordered.some((lesson) => lesson.id === row.lessonId),
    );
    if (ordered.length === 0) {
      trialMissing.push('Add lessons before configuring trial.');
    } else if (trialRows.length === 0) {
      trialMissing.push('Select at least the first lesson for trial.');
    } else {
      const firstIds = ordered
        .slice(0, trialRows.length)
        .map((lesson) => lesson.id);
      const trialIds = trialRows.map((row) => row.lessonId);
      if (!firstIds.every((id) => trialIds.includes(id))) {
        trialMissing.push(
          'Trial lessons must start from Lesson 1 and be consecutive.',
        );
      }
      for (const row of trialRows) {
        if (row.status === 'LOCKED') {
          trialMissing.push('Trial contains a locked lesson.');
        }
        if (row.status === 'RE_CONFIRM') {
          trialMissing.push('Trial cut-off needs re-confirmation.');
        }
        if (
          MODE_HAS_VIDEO(input.learningMode) &&
          (row.videoCutoffSeconds ?? 0) <= 0
        ) {
          trialMissing.push('Video trial cut-off is required.');
        }
        if (
          MODE_HAS_TEXT(input.learningMode) &&
          !row.textCutoffLearningPointId
        ) {
          trialMissing.push('Text trial cut-off is required.');
        }
      }
    }
  }
  const trial: StepCompleteness = {
    complete: trialMissing.length === 0,
    missing: trialMissing,
  };

  const completedSteps = [courseInformation, content, trial].filter(
    (step) => step.complete,
  ).length;

  // ===== Publish gate（PRD §15）=====
  const publishBlockers: string[] = [];
  if (!courseInformation.complete)
    publishBlockers.push('Complete Course Information first.');
  if (!lessonResults.some((result) => result.studyComplete)) {
    publishBlockers.push('Complete at least 1 lesson first.');
  }

  return {
    steps: { courseInformation, content, trial },
    completedSteps,
    canPublish: publishBlockers.length === 0,
    publishBlockers,
  };
}

/** 导出要求三步全部完成（PRD §16）。 */
export function canExport(completeness: CourseCompleteness): boolean {
  return (
    completeness.steps.courseInformation.complete &&
    completeness.steps.content.complete &&
    completeness.steps.trial.complete
  );
}

import type {
  PackageCourse,
  PackageLesson,
  PackageValidationIssue,
  PackageValidationReport,
} from './contracts/manifest';

/**
 * 内容完整性校验（结合 §17.4 口径，但导入/导出仅产生报告、不阻断结构性问题）。
 * 媒体存在性与签名校验由 package service 在解包时完成。
 */
export interface ValidateScope {
  /** 允许只对特定动作分级：import / uat / approve / export。默认 import。 */
  forAction?: 'import' | 'uat' | 'approve' | 'export';
}

export function validateCourseContent(
  course: PackageCourse,
  scope: ValidateScope = {},
): PackageValidationReport {
  const errors: PackageValidationIssue[] = [];
  const warnings: PackageValidationIssue[] = [];
  const err = (code: string, message: string, path?: string) =>
    errors.push({ level: 'error', code, message, path });
  const warn = (code: string, message: string, path?: string) =>
    warnings.push({ level: 'warning', code, message, path });

  const languages = course.learningLanguages ?? [];
  const structureErrors: PackageValidationIssue[] = [];

  // 课程级
  if (!course.cover)
    warn('COURSE_COVER_MISSING', 'course has no cover', 'course.cover');
  for (const lang of languages) {
    const loc = course.localized?.[lang];
    if (!loc) {
      warn(
        'COURSE_LOCALIZATION_MISSING',
        `missing localization for ${lang}`,
        `course.localized.${lang}`,
      );
      continue;
    }
    if (!loc.title || !loc.title.trim())
      err(
        'COURSE_TITLE_MISSING',
        `course title empty (${lang})`,
        `course.localized.${lang}.title`,
      );
    if (!loc.shortDescription?.trim())
      warn('COURSE_SHORT_DESC_MISSING', `short description missing (${lang})`);
    if (!loc.overview?.trim())
      warn('COURSE_OVERVIEW_MISSING', `overview missing (${lang})`);
    if (!loc.whatYouLearn || loc.whatYouLearn.length === 0)
      warn('COURSE_WHAT_YOU_LEARN_MISSING', `whatYouLearn missing (${lang})`);
  }
  if (!course.lessons || course.lessons.length === 0) {
    err('COURSE_NO_LESSONS', 'course has no lessons', 'course.lessons');
  }

  // 课时级
  for (const lesson of course.lessons ?? []) {
    validateLesson(lesson, languages, course.learningMode, {
      err,
      warn,
      structureErrors,
    });
  }
  if (course.trial?.enabled) {
    const knownLessons = new Set((course.lessons ?? []).map((l) => l.code));
    for (const row of course.trial.lessons ?? []) {
      if (!knownLessons.has(row.lessonRef)) {
        err(
          'TRIAL_LESSON_UNKNOWN',
          `trial references unknown lesson ${row.lessonRef}`,
          'course.trial',
        );
      }
    }
  }

  // 分级：结构性错误在任何动作都阻断；其余按 forAction 决定是否升级为 error
  const forAction = scope.forAction ?? 'import';
  const blocking: PackageValidationIssue[] = [];
  const soft: PackageValidationIssue[] = [];
  for (const issue of errors) {
    if (isStructural(issue.code)) blocking.push(issue);
    else if (forAction === 'approve')
      blocking.push({ ...issue, level: 'error' });
    else soft.push({ ...issue, level: 'warning' });
  }
  const allWarnings = [...warnings, ...soft];

  return {
    errors: blocking,
    warnings: allWarnings,
    incomplete: allWarnings.length > 0 || blocking.length > 0,
  };
}

function isStructural(code: string): boolean {
  return (
    code.includes('UNKNOWN') ||
    code.includes('DUPLICATE') ||
    code.includes('REF_MISSING') ||
    code.includes('INVALID_TYPE') ||
    code.includes('TRIGGER')
  );
}

function validateLesson(
  lesson: PackageLesson,
  languages: string[],
  mode: string,
  out: {
    err: (code: string, message: string, path?: string) => void;
    warn: (code: string, message: string, path?: string) => void;
    structureErrors: PackageValidationIssue[];
  },
) {
  const seenLp = new Map<string, Set<string>>();
  const exhibits = lesson.exhibits ?? [];
  const exhibitCodes = new Set(exhibits.map((e) => e.code));
  if (exhibitCodes.size !== exhibits.length) {
    out.err(
      'EXHIBIT_DUPLICATE',
      `duplicate exhibit code in ${lesson.code}`,
      `lessons.${lesson.code}.exhibits`,
    );
  }
  for (const ex of exhibits) {
    if (!ex.localized || Object.keys(ex.localized).length === 0) {
      out.err(
        'EXHIBIT_NO_LOCALIZED',
        `exhibit ${ex.code} has no localized content`,
        `lessons.${lesson.code}.exhibits.${ex.code}`,
      );
    }
    if ((ex.type === 'VIDEO' || ex.type === 'MODEL3D') && !ex.thumbnail) {
      out.warn(
        'THUMBNAIL_MISSING',
        `exhibit ${ex.code} (${ex.type}) requires a thumbnail`,
        `lessons.${lesson.code}.exhibits.${ex.code}`,
      );
    }
  }

  const needsVideo = mode === 'VIDEO_ONLY' || mode === 'VIDEO_AND_TEXT';
  const needsText = mode === 'TEXT_ONLY' || mode === 'VIDEO_AND_TEXT';

  for (const lang of languages) {
    const loc = lesson.localized?.[lang];
    if (!loc) {
      out.warn(
        'LESSON_LOCALIZATION_MISSING',
        `lesson ${lesson.code} missing localization ${lang}`,
        `lessons.${lesson.code}.localized.${lang}`,
      );
      continue;
    }
    if (!loc.title?.trim())
      out.err(
        'LESSON_TITLE_MISSING',
        `lesson ${lesson.code} title empty (${lang})`,
        `lessons.${lesson.code}.localized.${lang}.title`,
      );

    if (needsVideo) {
      if (!loc.video) {
        out.err(
          'LESSON_VIDEO_MISSING',
          `lesson ${lesson.code} requires a video (${lang})`,
          `lessons.${lesson.code}.localized.${lang}.video`,
        );
      } else {
        const seen = new Set<string>();
        for (const lp of loc.video.learningPoints ?? []) {
          if (seen.has(lp.code))
            out.err(
              'LEARNING_POINT_DUPLICATE',
              `duplicate learning point ${lp.code} (${lesson.code}/${lang})`,
              `lessons.${lesson.code}.localized.${lang}.video`,
            );
          seen.add(lp.code);
          // null = 明确“无时间源”（C7）；只拒绝非数字/负值，不把 null 当 0。
          if (
            lp.timeSeconds !== null &&
            (typeof lp.timeSeconds !== 'number' || lp.timeSeconds < 0)
          ) {
            out.err(
              'LEARNING_POINT_INVALID_TIME',
              `learning point ${lp.code} invalid time`,
              `lessons.${lesson.code}.localized.${lang}.video`,
            );
          }
        }
        if (
          !loc.video.learningPoints ||
          loc.video.learningPoints.length === 0
        ) {
          out.warn(
            'LESSON_VIDEO_NO_LP',
            `lesson ${lesson.code} video has no learning points (${lang})`,
            `lessons.${lesson.code}.localized.${lang}.video`,
          );
        }
        for (const trg of loc.video.exhibitTriggers ?? []) {
          if (!exhibitCodes.has(trg.exhibitRef)) {
            out.err(
              'TRIGGER_EXHIBIT_UNKNOWN',
              `trigger references unknown exhibit ${trg.exhibitRef} (${lesson.code}/${lang})`,
              `lessons.${lesson.code}.localized.${lang}.video.exhibitTriggers`,
            );
          }
        }
      }
    }

    if (needsText) {
      if (!loc.text?.html?.trim()) {
        out.err(
          'LESSON_TEXT_MISSING',
          `lesson ${lesson.code} requires text (${lang})`,
          `lessons.${lesson.code}.localized.${lang}.text`,
        );
      } else if (
        !loc.text.learningPoints ||
        loc.text.learningPoints.length === 0
      ) {
        out.warn(
          'LESSON_TEXT_NO_LP',
          `lesson ${lesson.code} text has no learning points (${lang})`,
          `lessons.${lesson.code}.localized.${lang}.text`,
        );
      }
    }

    seenLp.set(lang, new Set());
  }

  // 推荐阅读
  for (const [lang, rows] of Object.entries(lesson.recommendedReading ?? {})) {
    for (const r of rows ?? []) {
      if (!r.title?.trim() || !r.type) {
        out.err(
          'READING_INVALID',
          `recommended reading invalid (${lesson.code}/${lang})`,
          `lessons.${lesson.code}.recommendedReading.${lang}`,
        );
      }
    }
  }
}

import { computeCompleteness, type CompletenessInput } from './completeness';

function baseInput(
  overrides: Partial<CompletenessInput> = {},
): CompletenessInput {
  return {
    categoryId: 'cat-1',
    learningMode: 'VIDEO_AND_TEXT',
    learningLanguages: ['en-GB'],
    localizations: [
      {
        language: 'en-GB',
        title: 'Course',
        shortDescription: 'Short',
        overview: 'Overview',
        whatYouLearn: ['a', 'b', 'c', 'd'],
        provides: ['1', '2', '3', '4'],
      },
      {
        language: 'zh-CN',
        title: '课程',
        shortDescription: '简介',
        overview: '概述',
        whatYouLearn: ['甲', '乙', '丙', '丁'],
        provides: ['一', '二', '三', '四'],
      },
    ],
    lessons: [
      {
        id: 'lesson-1',
        code: 'L001',
        sortOrder: 1,
        localizations: [
          {
            language: 'en-GB',
            title: 'Lesson 1',
            description: 'Description',
            videoAssetId: 'video-1',
            videoDurationSeconds: 120,
            textHtml: '<h1>H</h1><p>Body</p>',
          },
          {
            language: 'zh-CN',
            title: '课时 1',
            description: '课时简介',
          },
        ],
        learningPoints: [
          { language: 'en-GB', source: 'VIDEO' },
          { language: 'en-GB', source: 'TEXT' },
        ],
        exhibits: [
          {
            id: 'exhibit-1',
            code: 'E001',
            type: 'IMAGE',
            mediaAssetId: 'media-1',
            thumbnailAssetId: 'thumb-1',
            localized: {
              'en-GB': { title: 'Exhibit', description: 'Description' },
            },
          },
        ],
        readings: [
          {
            type: 'BOOK',
            title: 'Reading',
            author: 'Author',
            whyRecommended: 'Why',
          },
        ],
        questions: [{ question: 'Q', referenceAnswer: 'A' }],
        applicationTest: { scenario: 'S', referenceAnswer: 'A', enabled: true },
      },
    ],
    trialEnabled: true,
    trialRows: [
      {
        lessonId: 'lesson-1',
        status: 'READY',
        videoCutoffSeconds: 60,
        textCutoffLearningPointId: 'lp-1',
      },
    ],
    ...overrides,
  };
}

describe('computeCompleteness', () => {
  it('marks all 3 steps complete', () => {
    const result = computeCompleteness(baseInput());
    expect(result.steps.courseInformation.complete).toBe(true);
    expect(result.steps.content.complete).toBe(true);
    expect(result.steps.trial.complete).toBe(true);
    expect(result.completedSteps).toBe(3);
    expect(result.canPublish).toBe(true);
  });

  it('blocks publish when Course Information is incomplete', () => {
    const result = computeCompleteness(
      baseInput({
        localizations: [
          {
            language: 'en-GB',
            title: 'Course',
            shortDescription: '',
            overview: 'Overview',
            whatYouLearn: ['a'],
            provides: ['1'],
          },
        ],
      }),
    );
    expect(result.steps.courseInformation.complete).toBe(false);
    expect(result.canPublish).toBe(false);
    expect(result.publishBlockers.join(' ')).toContain('Course Information');
  });

  it('allows publish with only one completed lesson study', () => {
    const result = computeCompleteness(
      baseInput({
        lessons: [
          baseInput().lessons[0],
          {
            id: 'lesson-2',
            code: 'L002',
            sortOrder: 2,
            localizations: [],
          },
        ],
      }),
    );
    expect(result.canPublish).toBe(true);
    expect(result.steps.content.complete).toBe(false);
  });

  it('requires trial lessons to be consecutive', () => {
    const result = computeCompleteness(
      baseInput({
        lessons: [
          baseInput().lessons[0],
          {
            id: 'lesson-2',
            code: 'L002',
            sortOrder: 2,
            localizations: baseInput().lessons[0].localizations,
            learningPoints: [
              { language: 'en-GB', source: 'VIDEO' },
              { language: 'en-GB', source: 'TEXT' },
            ],
          },
        ],
        trialRows: [
          { lessonId: 'lesson-2', status: 'READY', videoCutoffSeconds: 60 },
        ],
      }),
    );
    expect(result.steps.trial.complete).toBe(false);
  });

  // ---- PRD 12.4 / 20 #16：展品信息不全 → Study & Exploration Incomplete ----
  it('marks Study & Exploration incomplete when an exhibit misses type, file, thumbnail, or localized text', () => {
    const base = baseInput();
    const lesson = {
      ...base.lessons[0],
      exhibits: [
        {
          id: 'exhibit-2',
          code: 'E002',
          type: null,
          mediaAssetId: null,
          thumbnailAssetId: null,
          localized: {},
        },
      ],
    };
    const result = computeCompleteness(baseInput({ lessons: [lesson] }));
    const row = result.steps.content.lessons[0];
    expect(row.studyComplete).toBe(false);
    const missing = row.missing.join(' ');
    expect(missing).toContain('exhibit E002');
    expect(missing).toContain('media type');
    expect(missing).toContain('file');
    expect(missing).toContain('thumbnail');
    expect(missing).toContain('title is required (en-GB)');
    expect(missing).toContain('description is required (en-GB)');
  });

  // ---- PRD 12.6 / 20 #19：Recommended reading ----
  it('marks Study & Exploration incomplete when recommended reading list is empty', () => {
    const base = baseInput();
    const lesson = { ...base.lessons[0], readings: [] };
    const result = computeCompleteness(baseInput({ lessons: [lesson] }));
    const row = result.steps.content.lessons[0];
    expect(row.studyComplete).toBe(false);
    expect(row.missing.join(' ')).toContain('Recommended reading');
  });

  it('marks Study & Exploration incomplete when a recommended reading row misses a required field', () => {
    const base = baseInput();
    const lesson = {
      ...base.lessons[0],
      readings: [
        { type: 'BOOK', title: 'Reading', author: '', whyRecommended: 'Why' },
      ],
    };
    const result = computeCompleteness(baseInput({ lessons: [lesson] }));
    const row = result.steps.content.lessons[0];
    expect(row.studyComplete).toBe(false);
    expect(row.missing.join(' ')).toContain('author');
  });

  // ---- PRD 12.5.2 / 20 #14 #15：H1 即 LP，LP 下面必须有正文 ----
  it('marks text Study incomplete when an H1 learning point has no body', () => {
    const base = baseInput();
    const lesson = {
      ...base.lessons[0],
      localizations: base.lessons[0].localizations.map((loc) =>
        loc.language === 'en-GB'
          ? { ...loc, textHtml: '<h1>Heading</h1>' }
          : loc,
      ),
    };
    const result = computeCompleteness(baseInput({ lessons: [lesson] }));
    const row = result.steps.content.lessons[0];
    expect(row.studyComplete).toBe(false);
    expect(row.missing.join(' ')).toContain('No text under this heading');
  });

  // ---- PRD §20 #15：H1 存在但标题文字为空 → Title can't be empty ----
  it("marks text Study incomplete when an H1 title is empty", () => {
    const base = baseInput();
    const lesson = {
      ...base.lessons[0],
      localizations: base.lessons[0].localizations.map((loc) =>
        loc.language === 'en-GB'
          ? { ...loc, textHtml: '<h1> </h1><p>Body</p>' }
          : loc,
      ),
    };
    const result = computeCompleteness(baseInput({ lessons: [lesson] }));
    const row = result.steps.content.lessons[0];
    expect(row.studyComplete).toBe(false);
    expect(row.missing.join(' ')).toContain("Title can't be empty");
  });

  it('marks text Study incomplete when the text has no H1 learning point', () => {
    const base = baseInput();
    const lesson = {
      ...base.lessons[0],
      localizations: base.lessons[0].localizations.map((loc) =>
        loc.language === 'en-GB'
          ? { ...loc, textHtml: '<p>Body only</p>' }
          : loc,
      ),
    };
    const result = computeCompleteness(baseInput({ lessons: [lesson] }));
    const row = result.steps.content.lessons[0];
    expect(row.studyComplete).toBe(false);
    expect(row.missing.join(' ')).toContain('No learning points found');
  });

  // ---- PRD 11.5 / 20：Course Information 与 Lesson 标题/描述中英并列必填 ----
  it('requires English and Chinese Course Information regardless of learning languages', () => {
    const base = baseInput();
    const result = computeCompleteness(
      baseInput({
        localizations: base.localizations.filter(
          (loc) => loc.language === 'en-GB',
        ),
      }),
    );
    expect(result.steps.courseInformation.complete).toBe(false);
    expect(result.steps.courseInformation.missing.join(' ')).toContain('zh-CN');
  });

  it('requires English and Chinese lesson title/description regardless of learning languages', () => {
    const base = baseInput();
    const lesson = {
      ...base.lessons[0],
      localizations: base.lessons[0].localizations.filter(
        (loc) => loc.language === 'en-GB',
      ),
    };
    const result = computeCompleteness(baseInput({ lessons: [lesson] }));
    const row = result.steps.content.lessons[0];
    expect(row.studyComplete).toBe(false);
    expect(row.missing.join(' ')).toContain('zh-CN');
  });
});

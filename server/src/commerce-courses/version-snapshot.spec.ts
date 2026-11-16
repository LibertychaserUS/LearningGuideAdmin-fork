import { canExport, computeCompleteness } from './completeness';
import {
  snapshotToCompletenessInput,
  type VersionSnapshot,
} from './version-snapshot';

/**
 * 发布 / 导出前门禁：两条路径都用 snapshotToCompletenessInput + computeCompleteness
 * （publishing.service exportLatest 用 canExport 拦截）。
 * 快照里的展品与推荐阅读必须一并带入完成度判断，否则草稿能拦住、发布/导出仍放行。
 */
function completeSnapshot(): VersionSnapshot {
  return {
    formatVersion: 3,
    capturedAt: '2026-11-16T00:00:00.000Z',
    course: {
      code: 'COURSE-1',
      slug: 'course-1',
      categoryPath: ['cat-1'],
      coverAssetId: null,
      learningMode: 'VIDEO_AND_TEXT',
      defaultContentLanguage: 'en-GB',
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
              textLearningPoints: null,
            },
            {
              language: 'zh-CN',
              title: '课时 1',
              description: '课时简介',
              videoAssetId: null,
              videoDurationSeconds: null,
              textHtml: null,
              textLearningPoints: null,
            },
          ],
          exhibits: [
            {
              code: 'E001',
              type: 'IMAGE',
              mediaAssetId: 'media-1',
              thumbnailAssetId: 'thumb-1',
              sourceText: null,
              localized: {
                'en-GB': { title: 'Exhibit', description: 'Description' },
              },
            },
          ],
          learningPoints: [
            {
              language: 'en-GB',
              code: 'V1',
              title: 'Video point',
              source: 'VIDEO',
              timeSeconds: 10,
              anchorHeading: null,
              sortOrder: 1,
            },
            {
              language: 'en-GB',
              code: 'T1',
              title: 'H',
              source: 'TEXT',
              timeSeconds: null,
              anchorHeading: 'H',
              sortOrder: 2,
            },
          ],
          triggers: [],
          readings: [
            {
              language: 'en-GB',
              type: 'BOOK',
              title: 'Reading',
              author: 'Author',
              whyRecommended: 'Why',
              sortOrder: 1,
            },
          ],
          questions: [
            {
              code: 'Q1',
              question: 'Q',
              referenceAnswer: 'A',
              sortOrder: 1,
              enabled: true,
            },
          ],
          applicationTest: {
            scenario: 'S',
            referenceAnswer: 'A',
            enabled: true,
          },
        },
      ],
    },
  };
}

const noTrial = { trialEnabled: false, trialRows: [] };

describe('snapshotToCompletenessInput (publish / export gate)', () => {
  it('allows export when the snapshot is complete', () => {
    const completeness = computeCompleteness(
      snapshotToCompletenessInput(completeSnapshot(), noTrial),
    );
    expect(completeness.steps.content.complete).toBe(true);
    expect(canExport(completeness)).toBe(true);
  });

  it('blocks export when a snapshot exhibit is incomplete', () => {
    const snapshot = completeSnapshot();
    snapshot.course.lessons[0].exhibits = [
      {
        code: 'E002',
        type: '',
        mediaAssetId: null,
        thumbnailAssetId: null,
        sourceText: null,
        localized: {},
      },
    ];
    const completeness = computeCompleteness(
      snapshotToCompletenessInput(snapshot, noTrial),
    );
    const row = completeness.steps.content.lessons[0];
    expect(row.studyComplete).toBe(false);
    expect(row.missing.join(' ')).toContain('exhibit E002');
    expect(canExport(completeness)).toBe(false);
  });

  it('blocks export when the snapshot recommended reading list is empty', () => {
    const snapshot = completeSnapshot();
    snapshot.course.lessons[0].readings = [];
    const completeness = computeCompleteness(
      snapshotToCompletenessInput(snapshot, noTrial),
    );
    const row = completeness.steps.content.lessons[0];
    expect(row.studyComplete).toBe(false);
    expect(row.missing.join(' ')).toContain('Recommended reading');
    expect(canExport(completeness)).toBe(false);
  });
});

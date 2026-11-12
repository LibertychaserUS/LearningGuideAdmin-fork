import type { Localized } from '../lib/i18n/localized';

export type StepCompleteness = { complete: boolean; missing: string[] };

export type LessonCompleteness = {
  lessonId: string;
  code: string;
  studyComplete: boolean;
  understandingComplete: boolean;
  missing: string[];
};

export type CourseCompleteness = {
  steps: {
    courseInformation: StepCompleteness;
    content: StepCompleteness & { lessons: LessonCompleteness[] };
    trial: StepCompleteness;
  };
  completedSteps: number;
  canPublish: boolean;
  publishBlockers: string[];
};

export type CourseLocalization = {
  language: string;
  title: string;
  shortDescription: string | null;
  overview: string | null;
  whatYouLearn: unknown;
  provides: unknown;
};

export type LessonLocalization = {
  language: string;
  title: string;
  description: string | null;
  textHtml: string | null;
  videoAssetId?: string | null;
  video: {
    id: string;
    originalName?: string | null;
    size?: number | null;
    mimeType?: string | null;
    extension?: string | null;
    createdAt?: string | null;
  } | null;
  videoDurationSeconds: number | null;
};

export type ExhibitMedia = {
  id: string;
  kind?: string;
  originalName?: string;
  mimeType?: string;
  extension?: string;
  size?: number;
};

export type Exhibit = {
  id: string;
  code: string;
  type: string;
  mediaAssetId?: string | null;
  thumbnailAssetId?: string | null;
  sourceText?: string | null;
  media: ExhibitMedia | null;
  thumbnail: ExhibitMedia | null;
  localized: Localized<'title' | 'description'>;
};

export type Reading = { type: string; title: string; author: string | null; whyRecommended: string | null; language?: string };
export type Question = { id?: string; code: string; question: string; referenceAnswer: string | null; enabled?: boolean };
export type ApplicationTest = { scenario: string; referenceAnswer: string | null; enabled?: boolean };

export type Lesson = {
  id: string;
  code: string;
  sortOrder: number;
  localizations: LessonLocalization[];
  exhibits: Exhibit[];
  readings: Reading[];
  questions: Question[];
  applicationTest: ApplicationTest | null;
  learningPoints: Array<{
    id?: string;
    language: string;
    code: string;
    title: string;
    source: string;
    timeSeconds: number | null;
    sortOrder?: number;
    anchorHeading?: string | null;
  }>;
  triggers?: Array<{ id?: string; language: string; exhibitId: string; timeSeconds: number }>;
};

export type CoursePlan = {
  id: string;
  name: string;
  termMonths: number;
  amountMinor: number;
  currency: string;
  stripeLookupKey: string | null;
  stripeProductId: string | null;
  stripePriceId: string | null;
  lastSyncedAt: string | null;
  syncError: string | null;
};

export type TrialRow = {
  lessonId: string;
  code: string;
  index: number;
  title: string;
  videoDurationSeconds: number | null;
  inTrial: boolean;
  videoCutoffSeconds: number | null;
  textCutoffLearningPointId: string | null;
  textCutoffCode: string | null;
  status: 'READY' | 'RE_CONFIRM' | 'LOCKED';
  learningPoints: Array<{ id: string; language: string; code: string; title: string }>;
  videoCutoffByLanguage?: Record<string, number | null> | null;
  textCutoffByLanguage?: Record<string, string | null> | null;
};

export type TrialSettings = {
  enabled: boolean;
  learningMode: string;
  learningLanguages: string[];
  rows: TrialRow[];
};

/** 课程分类：name 是稳定键，localized 是各语言显示名（通用多语言模板，见 lib/i18n/localized.ts）。 */
export type CourseCategory = {
  id: string;
  name: string;
  localized: Localized<'name' | 'description'>;
};

export type CourseDetail = {
  id: string;
  code: string;
  slug: string;
  learningMode: string;
  learningLanguages: string[];
  defaultContentLanguage: string;
  categoryId: string | null;
  category?: CourseCategory | null;
  cover?: { id: string } | null;
  subtitle: string | null;
  lifecycleStatus: string;
  liveStatus: string;
  liveVersionId: string | null;
  hasDraft: boolean;
  trialEnabled: boolean;
  localizations: CourseLocalization[];
  lessons: Lesson[];
  plans: CoursePlan[];
  trialRows: Array<{ lessonId: string; status: string; videoCutoffSeconds: number | null; textCutoffLearningPointId: string | null }>;
  completeness: CourseCompleteness;
};

export type CourseVersion = {
  id: string;
  versionNo: number;
  versionLabel: string;
  versionSeries: number;
  versionMinor: number;
  sourceEnvironment: string | null;
  sourceVersionLabel: string | null;
  wentLiveAt: string | null;
  exportedAt: string | null;
  createdAt: string;
  isLive: boolean;
};

export type HistoryItem = {
  id: string;
  time: string;
  operator: string;
  action: string;
  versionNo: number | null;
  detail: unknown;
};

export type HistoryPage = { items: HistoryItem[]; total: number; page: number; pages: number };

export type CourseSummary = {
  id: string;
  code: string;
  slug: string;
  title: string;
  subtitle: string | null;
  category: CourseCategory | null;
  learningMode: string;
  learningLanguages: string[];
  lessonCount: number;
  lifecycleStatus: string;
  liveStatus: string;
  liveVersionId: string | null;
  liveVersionLabel?: string | null;
  liveVersionWentLiveAt?: string | null;
  hasDraft: boolean;
  trialEnabled: boolean;
  published: boolean;
  updatedAt: string;
};

export type CourseList = {
  courses: CourseSummary[];
  total: number;
  page: number;
  pages: number;
  counts: {
    total: number;
    draft: number;
    published: number;
    online: number;
    hidden: number;
    offline: number;
    notPublished: number;
  };
};

export type PreviewLesson = {
  id: string;
  code: string;
  index: number;
  title: string;
  description: string | null;
  videoAssetId: string | null;
  videoDurationSeconds: number | null;
  textHtml: string | null;
  learningPoints: Array<{ code: string; title: string; source: string; timeSeconds: number | null }>;
  exhibits: Array<{ code: string; type: string; mediaAssetId: string | null; title: string; description: string | null }>;
  readings: Array<{ type: string; title: string; author: string | null; whyRecommended: string | null }>;
  knowledgeTest: { enabled: boolean; questions: Array<{ code: string; question: string }> };
  applicationTest: { scenario: string } | null;
  trial: { videoCutoffSeconds: number | null; textCutoffLearningPointId: string | null; status: string } | null;
};

export type PreviewCourse = {
  id: string;
  code: string;
  slug: string;
  versionLabel: string | null;
  category: CourseCategory | null;
  learningMode: string;
  learningLanguages: string[];
  defaultContentLanguage: string;
  coverUrl: string | null;
  title: string;
  shortDescription: string | null;
  overview: string | null;
  whatYouLearn: unknown;
  provides: unknown;
  localizations: CourseLocalization[];
  lessonCount: number;
  totalDurationSeconds: number;
  lessons: PreviewLesson[];
  trial: { enabled: boolean; available: boolean; rows: TrialRow[] };
  plans: CoursePlan[];
  completeness: CourseCompleteness;
};

export type PortalPreviewLink = {
  url: string;
  token: string;
  expiresAt: string;
  source: 'draft' | 'version';
  courseId: string;
  versionId: string | null;
};

/** Admin 自建 Portal 风格预览页读取的投影详情（与 Portal v1 投影同构）。 */
export type PortalPreviewDetail = {
  id: string;
  slug: string;
  code: string;
  title: string;
  subtitle: string | null;
  shortDescription: string | null;
  description: string | null;
  category: string | null;
  /** 分类各语言显示名（通用多语言模板），缺的语言按模板规则回退到 category。 */
  categoryLocalized: Localized<'name' | 'description'>;
  level: string | null;
  tags: unknown;
  coverUrl: string | null;
  learningMode: string | null;
  learningLanguages: string[];
  defaultContentLanguage: string | null;
  whatYouLearn: unknown;
  provides: unknown;
  lessonCount: number;
  totalDurationSeconds: number;
  trial?: { enabled: boolean; lessonIds: string[] };
  plans: Array<{
    id: string;
    name: string;
    termMonths: number;
    amountMinor: number;
    currency: string;
    lookupKey: string | null;
    trialEligible: boolean;
  }>;
  sections: Array<{
    id: string;
    title: string;
    lessons: Array<{
      id: string;
      title: string;
      summary: string | null;
      durationSeconds: number | null;
      isPublic: boolean;
      trial?: {
        videoCutoffSeconds: number | null;
        textCutoffLearningPointId: string | null;
        textCutoffCode: string | null;
      } | null;
      contents: Array<{
        id: string;
        title?: string;
        type: string;
        mode?: string;
        url?: string;
        html?: string;
        nodes?: Array<{ id: string; title: string; triggerTime?: number; url?: string; type?: string }>;
      }>;
    }>;
  }>;
  preview: { source: 'draft' | 'version'; versionLabel: string | null };
};

export type EnvironmentInfo = {
  label: string;
  publicSiteUrl: string;
  versionNumberingMode: 'sandbox' | 'production';
  stripeConfigured: boolean;
};

export type PopularCourseItem = {
  courseId: string;
  sortOrder: number;
  code: string;
  title: string;
  category: CourseCategory | null;
  liveStatus: string;
  trialEnabled: boolean;
  coverUrl: string | null;
  invalid: boolean;
};

export type PopularCourses = {
  items: PopularCourseItem[];
  publishedAt: string | null;
  publishedBy: string | null;
};

export type BannerLocalizedEntry = {
  headline?: string;
  subheading?: string;
  buttonLabel?: string;
};

export type DiscoveryBanner = {
  enabled: boolean;
  courseId: string | null;
  localized: Record<string, BannerLocalizedEntry> | null;
  publishedAt: string | null;
  publishedBy: string | null;
  invalid: boolean;
  course: {
    id: string;
    code: string;
    title: string;
    liveStatus: string;
    trialEnabled: boolean;
    coverUrl: string | null;
  } | null;
};

export function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((item) =>
          typeof item === 'string' ? item : (item as { title?: string; text?: string } | null)?.title ?? (item as { text?: string } | null)?.text ?? '',
        )
        .filter(Boolean)
    : [];
}

export function providerItems(value: unknown): Array<{ type: string; title: string }> {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === 'string') return { type: 'custom', title: item };
    const record = item as { type?: string; title?: string; text?: string };
    return { type: record.type ?? 'custom', title: record.title ?? record.text ?? '' };
  });
}

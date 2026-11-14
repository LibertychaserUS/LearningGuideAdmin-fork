import { DEFAULT_LOCALE, isLocale, type Locale } from "./config";
import { t } from "./messages";

/**
 * 后端错误是写死的单语言句子（大多中文，少数英文），会被各模块直接显示。
 * 所有请求出口都经过这里，保证用户读到的错误是当前页面的语言：
 *   1. 句子已经是当前语言 → 原样显示；
 *   2. 下表有对应译文 → 显示译文；
 *   3. 否则显示通用提示，原文只进控制台。绝不把另一种语言的句子显示给用户。
 * 新增后端中文报错时要在这里加译文，tests/i18n-guard.test.ts 会扫描后端源码检查。
 */
export const SERVER_MESSAGES: ReadonlyArray<readonly [zh: string, en: string]> = [
  ["测试版本已变化，请刷新后重试", "The test release has changed. Refresh and try again."],
  ["课程在你打开后已被他人修改，请刷新后查看最新内容。", "This course was changed by someone else after you opened it. Refresh to see the changes."],
  ["LLM 上游生成失败", "The model could not complete this response."],
  ["LLM 上游连接中断", "The model connection was interrupted."],
  ["所选知识库版本没有可用正文", "The selected release has no usable course content."],
  ["向量检索无法连接", "The knowledge search service could not be reached."],
  ["所选知识库版本不存在", "The selected release does not exist."],
  ["知识库版本不属于当前课程", "The release does not belong to this course."],
  ["AI 回答连接中断，请重试", "AI response was interrupted"],
  ["AI 回答未完成，请重试", "AI response was not completed"],
  ["AI 响应格式错误，请重试", "Invalid AI stream event"],
  ["服务器内部错误", "Internal server error."],
  ["文件大小超过 15MB 限制", "The file is larger than the 15 MB limit."],
  ["请求内容过大，请拆分文档后重试", "The request is too large. Split the document and try again."],
  ["数据校验失败", "The data could not be validated."],
  ["数据已存在（唯一约束冲突）", "This record already exists."],
  ["请求的资源不存在", "The requested item does not exist."],
  ["关联记录不存在，违反外键约束", "A linked record does not exist."],
  ["字段值超出允许长度", "A value is longer than allowed."],
  ["未授权访问", "You are not authorised."],
  ["课程不存在", "The course does not exist."],
  ["所属课程不存在", "The course this belongs to does not exist."],
  ["该课程 AI 导师未开放", "AI Tutor is not available for this course."],
  ["该课程尚未发布可用版本", "This course has no published version yet."],
  ["该课程没有可用的测试或上线版本", "This course has no test or live version."],
  ["该课程没有可用的测试或上线版本；请先在 Knowledge 模块 Releases 页创建版本", "This course has no test or live version. Create one on the Releases tab in Knowledge."],
  ["AI 回答达到输出上限，内容未完成", "The AI answer reached its length limit and is incomplete."],
  ["发布版本不存在或不属于该课程", "The release does not exist or does not belong to this course."],
  ["发布版本不存在", "The release does not exist."],
  ["该版本为上线版本（Live），不可删除", "This is the live version and cannot be deleted."],
  ["releaseId 为必填项", "releaseId is required."],
  ["revisionNotes 为必填项", "Revision notes are required."],
  ["apiKey 密文格式非法", "The stored API key is not valid."],
  ["未选择文件（multipart 字段名须为 file）", "No file was selected."],
  ["未选择图片", "No image was selected."],
  ["图片不存在", "The image does not exist."],
  ["图片不能超过 5MB", "The image cannot be larger than 5 MB."],
  ["仅支持 PNG、JPEG、GIF、WebP 图片", "Only PNG, JPEG, GIF and WebP images are supported."],
  ["文档转换结果为空", "The document converted to nothing."],
  ["DOCX 文件包含过多内容", "The DOCX file has too much content."],
  ["DOCX 解压内容超过安全限制", "The unpacked DOCX is larger than the safety limit."],
  ["页面不存在", "The page does not exist."],
  ["排序列表必须为该课程全部页面的完整排列", "The order must list every page of this course."],
  ["本期仅同步课程与课时标题，正文内容同步已禁用", "Only course and lesson titles are synced for now. Content sync is off."],
  ["该课程不在同步映射表中", "This course is not in the sync mapping."],
  ["标签名称不能为空", "The tag name cannot be empty."],
  ["原始素材 ZIP 中找不到 Excel（.xlsx）模板文件", "The ZIP has no Excel (.xlsx) template."],
  ["Lessons 工作表没有可导入的课时", "The Lessons sheet has no lessons to import."],
  ["Lessons Sheet 中没有可导入的课时", "The Lessons sheet has no lessons to import."],
  ["操作成功", "Done."],
  ["AI 服务返回空回答，请重试或检查模型配置", "The AI service returned an empty answer. Try again or check the model settings."],
  ["该课程尚未发布知识库版本，请先在 Knowledge 模块 Releases 页创建版本", "This course has no knowledge release yet. Create one on the Releases tab in Knowledge."],
  ["没有检索到当前课程版本的知识证据，请改为课程范围内的问题", "No knowledge was found for this course version. Ask a question within the course."],
  ["课程知识证据超出当前上下文预算，未调用 AI Tutor", "The course knowledge is over the context budget, so AI Tutor was not called."],
  ["未配置可用的 LLM API Key（课程级未设置且 OPENROUTER_API_KEY 缺失）", "No LLM API key is configured for this course or the system."],
  ["该课程尚未发布知识库版本，无法保存或重置 AI 配置（请先创建 Release）", "This course has no knowledge release yet, so its AI settings cannot be saved or reset. Create a release first."],
  ["AI_CONFIG_ENCRYPTION_KEY 未配置或格式错误（需 64 位 hex）", "The AI settings encryption key is missing or invalid."],
  ["响应无法解析", "The response could not be read."],
  ["该课程已存在发布历史版本，拒绝删除；如需删除请先处理历史版本", "This course has released versions and cannot be deleted. Deal with those versions first."],
  ["文件内容不是有效的 .xls 格式（请确认文件类型）", "The file is not a valid .xls file."],
  ["文档转换失败，请检查文件是否损坏或受密码保护", "The document could not be converted. Check that it is not damaged or password protected."],
  ["LaTeX 文件必须为有效的 UTF-8 文本", "The LaTeX file must be valid UTF-8 text."],
  ["DOCX 含图片，请从 Knowledge Pages 课程中导入", "This DOCX contains images. Import it from a course in Knowledge Pages."],
  ["该版本为 AI Tutor 后台测试所选版本，不可删除", "This version is selected for AI Tutor testing and cannot be deleted."],
  ["热门课程只能选择 1–6 门。", "Popular Courses allows 1–6 courses."],
];

/** 带变量的后端句子：同样两种语言都写，正则从中文原文取变量。 */
export const SERVER_MESSAGE_PATTERNS: ReadonlyArray<readonly [zh: RegExp, en: (m: RegExpMatchArray) => string]> = [
  [/^页面「(.+)」的图片无法导出：(.+)$/, (m) => `The image in "${m[1]}" cannot be exported: ${m[2]}`],
  [/^页面「(.+)」的图片不存在：(.+)$/, (m) => `The image in "${m[1]}" is missing: ${m[2]}`],
  [/^不支持的 LLM 模型：(.+)$/, (m) => `Unsupported LLM model: ${m[1]}`],
  [/^不支持的 LLM Provider: (.+)$/, (m) => `Unsupported LLM provider: ${m[1]}`],
  [/^Tag "(.+)" 不存在$/, (m) => `The tag "${m[1]}" does not exist.`],
  [/^知识库服务暂不可用（(.+)）$/, () => "The knowledge service is unavailable right now."],
  [/^Excel 模板结构无法识别：(.+)$/, () => "The Excel template could not be read: expected the Course info and Lessons sheets."],
  [/^Excel 缺少 Sheet：(.+)$/, (m) => `The Excel file is missing sheets: ${m[1]}`],
  [/^LLM 上游返回 (.+)$/, (m) => `The LLM service answered ${m[1]}`],
  [/^请求过于频繁，请稍后再试（每课程每分钟最多 (.+) 次）$/, (m) => `Too many requests. Try again shortly (at most ${m[1]} per course per minute).`],
  [/^格式暂不支持：(.+)（支持 (.+)）$/, (m) => `This format is not supported: ${m[1].replace("未知", "unknown")} (supported: ${m[2]}).`],
  [/^(.+)不存在$/, (m) => `${m[1]} does not exist.`],
];

const HAN = /\p{Script=Han}/u;

/** 非 React 代码（请求层、错误边界）取当前语言的唯一来源：地址栏第一段。 */
export function currentLocale(): Locale {
  const segment = typeof window === "undefined" ? undefined : window.location.pathname.split("/")[1];
  return isLocale(segment) ? segment : DEFAULT_LOCALE;
}

export function serverText(raw: string | null | undefined, locale: Locale = currentLocale()): string {
  const text = (raw ?? "").trim();
  const translated = text ? translate(text, locale) : null;
  if (translated) return translated;
  if (text) console.warn("[i18n] 后端文本没有当前语言的译文:", text);
  return t(locale, "errors.serverGeneric");
}

function translate(text: string, locale: Locale): string | null {
  const isZh = HAN.test(text);
  if (locale === "zh-CN") {
    if (isZh) return text;
    return SERVER_MESSAGES.find(([, en]) => en === text)?.[0] ?? null;
  }
  if (!isZh) return text;
  const exact = SERVER_MESSAGES.find(([zh]) => zh === text);
  if (exact) return exact[1];
  for (const [pattern, en] of SERVER_MESSAGE_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      const out = en(match);
      return HAN.test(out) ? null : out;
    }
  }
  return null;
}

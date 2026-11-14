import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  KNOWLEDGE_CLIENT,
  type KnowledgeClient,
} from '../ks/contract/knowledge-client';
import {
  AiChatLogger,
  type AiChatLogEntry,
  type AiChatStatus,
} from './ai-chat-logger';
import { AiConfigService } from './ai-config.service';
import { ChatHistoryItemDto, ChatStreamDto } from './dto/chat-stream.dto';
import { LearnerChatStreamDto } from './dto/learner-chat-stream.dto';
import { LlmTimeoutError } from './providers/llm-provider.interface';
import { OpenRouterHttpError } from './providers/openrouter.provider';
import { ProviderRegistry } from './providers/provider.registry';
import {
  compileTutorDialogue,
  visibleTutorAnswer,
} from './tutor/dialogue-runtime';
import { buildTutorContext, loadTutorRelease } from './tutor/course-context';
import {
  imageAfterParagraph,
  selectKnowledgeImages,
} from './tutor/knowledge-images';
import { selectRecentCompleteTurns } from './tutor/conversation-history';
import {
  RateLimitService,
  type AiRateLimitChannel,
} from './rate-limit.service';

/** 学员端语言指令（已删除，2026-10-29）：
 * - main.md 第 5 节 LANGUAGE 已正式覆盖（含 language switch 不放松 1-4 节约束）
 * - LOCALE_INSTRUCTION 硬编码冗余，不再追加
 */

/** Field 2 carries only the most recent complete dialogue turns. */
const MAX_HISTORY_TURNS = 6;
const MAX_SOCRATIC_HISTORY_TURNS = 10;

function isTutorConversationOpener(question: string): boolean {
  const text = question
    .replace(/^(?:(?:你好|您好|嗨|哈喽|hi|hello)[，,！!。.?？\s]*)+/iu, '')
    .trim();
  if (!text || text.length > 80) return false;
  if (
    /收费|价格|账号|账户|订阅|退款|订单|支付|price|account|subscription|refund|payment/iu.test(
      text,
    )
  )
    return false;
  if (
    /解释|计算|推导|证明|怎么求|什么是|explain|calculate|derive|prove/iu.test(
      text,
    )
  )
    return false;
  return /你.{0,12}(?:是谁|叫什么|什么身份|能做什么|能干什么|可以做什么|有什么功能|提供什么帮助)|(?:介绍|说说).{0,8}你自己|\b(?:who are you|what can you do|what is your role|tell me about yourself|how can you help)\b|(?:知道|了解|认识).{0,12}Learning Guide|Learning Guide.{0,12}(?:是什么|吗)|\b(?:what is|do you know) Learning Guide\b/iu.test(
    text,
  );
}

/**
 * AI 对话编排（§4.4.2）：限流 → 加载配置 → 聚合知识库上下文 →
 * 组装 Prompt → Provider 流式调用（失败重试最多 2 次，§4.4.3）。
 * 对话不落库（§4.3.2 拍板）；每次对话结束后由 AiChatLogger 旁路写运行日志
 * （§4.4.2 第 7 步，2026-10-22 拍板）。
 */
@Injectable()
export class AiChatService {
  constructor(
    // 课程与 Release 快照归 KS 所有，只经契约读取（docs/Engine_Split_Implementation.md）
    @Inject(KNOWLEDGE_CLIENT) private readonly knowledge: KnowledgeClient,
    private readonly configs: AiConfigService,
    private readonly registry: ProviderRegistry,
    private readonly rateLimit: RateLimitService,
    private readonly chatLogger: AiChatLogger,
  ) {}

  /** 后台测试对话：读「测试所选 Release」（aiTestReleaseId ?? currentReleaseId） */
  async *streamChat(
    dto: ChatStreamDto,
    signal?: AbortSignal,
  ): AsyncGenerator<string> {
    yield* this.run({
      courseIdHint: dto.courseId,
      message: dto.message,
      mode: dto.mode,
      history: dto.history,
      locale: null,
      channel: 'admin',
      quota: 'admin-test',
      signal,
      resolve: async () => {
        const course = await this.knowledge.getCourse(dto.courseId);
        if (!course) throw new NotFoundException('课程不存在');
        const releaseId = course.aiTestReleaseId ?? course.currentReleaseId;
        if (dto.expectedReleaseId && dto.expectedReleaseId !== releaseId) {
          throw new ConflictException('测试版本已变化，请刷新后重试');
        }
        return {
          courseId: course.id,
          courseTitle: course.title,
          // §4.3.1/§5.2（2026-10-20）：后台测试对话读「测试所选 Release」
          releaseId,
        };
      },
    });
  }

  /**
   * 学员端对话（2026-10-22）：按 Portal course.slug 匹配 Course.externalId，
   * 强制 aiTutorOnline，且只读 currentReleaseId（绝不读 aiTestReleaseId）。
   */
  async *streamLearnerChat(
    dto: LearnerChatStreamDto,
    signal?: AbortSignal,
  ): AsyncGenerator<string> {
    yield* this.run({
      courseIdHint: dto.externalCourseId,
      message: dto.message,
      mode: dto.channel === 'study-group' ? 'LECTURE' : dto.mode,
      history: dto.history,
      locale: dto.locale,
      channel: 'learner',
      quota: dto.channel ?? 'portal',
      userId: dto.userId,
      signal,
      resolve: async () => {
        const course = await this.knowledge.getCourseByExternalId(
          dto.externalCourseId,
        );
        if (!course) throw new NotFoundException('课程不存在');
        if (!course.aiTutorOnline) {
          throw new ForbiddenException('该课程 AI 导师未开放');
        }
        if (!course.currentReleaseId) {
          throw new ConflictException('该课程尚未发布可用版本');
        }
        return {
          courseId: course.id,
          courseTitle: course.title,
          releaseId: course.currentReleaseId,
        };
      },
    });
  }

  /** 产出文本增量流；首字节前失败自动重试，之后失败直接抛出由控制器转 SSE 错误帧 */
  private async *run(input: {
    /** 课程解析失败时用于日志的兜底 id（后台为 UUID，学员为 externalId） */
    courseIdHint: string;
    message: string;
    mode: 'LECTURE' | 'SOCRATIC';
    history?: ChatHistoryItemDto[];
    locale: 'en-GB' | 'zh-CN' | null;
    channel: 'admin' | 'learner';
    /** 限流分桶（2026-10-23）：直播间与后台测试各自单独配额，默认按学员个人对话计 */
    quota?: AiRateLimitChannel;
    /** Portal 学员 userId（2026-10-28）：用于日志审计和用户级限流分桶；后台测试/直播间不传 */
    userId?: string;
    signal?: AbortSignal;
    resolve: () => Promise<{
      courseId: string;
      courseTitle: string;
      releaseId: string | null;
    }>;
  }): AsyncGenerator<string> {
    const startedAt = Date.now();
    const requestId = randomUUID();
    const history = selectRecentCompleteTurns(
      input.history ?? [],
      input.mode === 'SOCRATIC'
        ? MAX_SOCRATIC_HISTORY_TURNS
        : MAX_HISTORY_TURNS,
    );
    let courseId = input.courseIdHint;
    let releaseId: string | null = null;
    let providerName = 'unknown';
    let model = 'unknown';
    let answer = '';
    let promptHash: string | undefined;
    let finished = false;
    let status: AiChatStatus = 'ok';
    let errorText: string | undefined;
    let finishReason: string | null | undefined;
    let usage:
      | {
          inputTokens?: number;
          outputTokens?: number;
          reasoningTokens?: number;
        }
      | undefined;
    const attempts: NonNullable<AiChatLogEntry['attempts']> = [];
    const progress = (stage: string, attempt?: number) => {
      void this.chatLogger
        .writeProgress({
          requestId,
          stage,
          elapsedMs: Date.now() - startedAt,
          courseId,
          releaseId,
          mode: input.mode,
          channel: input.quota ?? 'portal',
          ...(attempt === undefined ? {} : { attempt }),
        })
        .catch(() => undefined);
    };

    try {
      progress('started');
      const resolved = await input.resolve();
      courseId = resolved.courseId;
      releaseId = resolved.releaseId;
      // 2026-10-29：没有可用版本（aiTestReleaseId 和 currentReleaseId 都 null）时直接拒绝，
      // 避免用空知识上下文回答（QA：新建课程未发布版本也能打开对话）。
      // 文案保留 Knowledge 模块 Releases 页的操作指引。
      if (!releaseId) {
        throw new BadRequestException(
          '该课程没有可用的测试或上线版本；请先在 Knowledge 模块 Releases 页创建版本',
        );
      }
      await this.rateLimit.assertAllowed(
        courseId,
        input.quota ?? 'portal',
        input.userId,
      );
      progress('release_resolved');
      const release = await loadTutorRelease(
        this.knowledge,
        courseId,
        releaseId,
      );
      const buildContext = async (query: string, topics: string[] = []) => {
        const context = await buildTutorContext(
          this.knowledge,
          release,
          query,
          topics,
        );
        progress(`context_${context.strategy}`);
        return context.text;
      };

      const question = input.message.trim();
      const english = !/[\u3400-\u9fff]/u.test(question);
      const broadCourseHelp =
        /\b(?:lesson|course)\b.*\b(?:whole|entire|everything)\b|\b(?:whole|entire)\b.*\b(?:lesson|course)\b/i.test(
          question,
        ) || /这(?:节|门)课.*(?:全部|整(?:节|门)|讲一遍)/.test(question);
      const conversationSummary =
        input.mode === 'SOCRATIC' &&
        history.length > 0 &&
        /(?:总结|回顾|梳理).*(?:我们|刚才|之前|讨论|对话)|(?:summari[sz]e|summary|recap).*(?:we|our|discussed|conversation|so far)/i.test(
          question,
        );
      const contextQuery = conversationSummary
        ? `${question} ${history.map((turn) => `${turn.user.slice(0, 120)} ${turn.assistant.slice(0, 240)}`).join(' ')}`
        : input.message;
      const summaryTopics = conversationSummary
        ? history
            .filter(
              (turn) =>
                !/\b(?:invent|fabricat\w*|make up)\b|编造|伪造/iu.test(
                  turn.user,
                ),
            )
            .slice()
            .reverse()
            .filter((turn) =>
              /模型|方程|公式|model|equation|formula|[A-Za-z]\s*['′]\s*=/i.test(
                turn.assistant,
              ),
            )
            .slice(0, 2)
            .map((turn) => turn.assistant.slice(0, 240))
        : [];
      if (
        (/\b(?:system prompt|developer (?:prompt|instructions)|api key|secret key)\b/i.test(
          question,
        ) ||
          /(?:系统提示词|系统指令|内部配置|密钥)/.test(question)) &&
        (/\b(?:print|show|reveal|ignore)\b/i.test(question) ||
          /(?:告诉|输出|显示)/.test(question))
      ) {
        answer = english
          ? 'I cannot share internal instructions or configuration. You can ask me about this course.'
          : '我不能提供内部指令或配置。你可以继续问这门课的内容。';
        yield answer;
        finished = true;
        return;
      }
      if (
        /\b(?:weather|forecast)\b.*\b(?:today|tomorrow|next week)\b/i.test(
          question,
        ) ||
        (input.mode === 'SOCRATIC' &&
          /\b(?:today|tomorrow|next week)\b.*\b(?:weather|forecast)\b/i.test(
            question,
          )) ||
        /(?:今天|明天|下周).*(?:天气|气温|天气预报)|(?:天气|气温|天气预报).*(?:今天|明天|下周)/.test(
          question,
        )
      ) {
        answer =
          input.mode === 'SOCRATIC'
            ? history.length > 0
              ? english
                ? 'Weather forecasts are outside this course. What was the key idea in the course example we just discussed?'
                : '天气预报不属于本课程。刚才讨论的课程例子里，关键概念是什么？'
              : english
                ? 'Weather forecasts are outside this course. Which course concept would you like to explore first?'
                : '天气预报不属于本课程。你想先探讨本课哪个概念？'
            : english
              ? 'I can help with this course. Please ask about a concept or example from the lesson.'
              : '我只能解答当前课程相关的问题。你可以问我课程中的概念或例子。';
        yield answer;
        finished = true;
        return;
      }

      const [runConfig, initialContext] = await Promise.all([
        this.configs.resolveTutorRun(courseId, releaseId, input.mode),
        buildContext(contextQuery, summaryTopics),
      ]);
      const { runtime, prompts } = runConfig;
      if (initialContext === null) progress('retrieval_initial_empty');
      let context =
        initialContext === null && broadCourseHelp
          ? await buildContext(
              'course lesson overview key concepts learning objectives',
            )
          : initialContext;
      if (
        context === null &&
        input.mode === 'SOCRATIC' &&
        !broadCourseHelp &&
        history.length > 0
      ) {
        progress('retrieval_context_retry');
        const recentTopics = history
          .slice(-3)
          .map((turn) => turn.user.slice(0, 120))
          .join(' ');
        context = await buildContext(`${recentTopics} ${question}`);
        if (context === null) progress('retrieval_context_empty');
      }
      if (context === null && !isTutorConversationOpener(question)) {
        answer = broadCourseHelp
          ? english
            ? 'I can help you work through the lesson. Which concept or example is most confusing? We can start there.'
            : '可以一起梳理这节课。你最不清楚的是哪个概念或例子？我们从那里开始。'
          : input.mode === 'SOCRATIC'
            ? history.length > 0
              ? english
                ? 'I cannot confirm this from the course material yet. Which course concept or example does your question refer to?'
                : '我暂时无法依据课程材料确认这一点。你指的是本课哪个概念或例子？'
              : english
                ? 'I can only help with this course. Which course concept or example would you like to explore?'
                : '我只能围绕本课程回答。你想从本课哪个概念或例子开始？'
            : english
              ? 'This question is outside what I can answer from the current course materials. Feel free to ask another question about this course. If you mean a specific course topic, please tell me which one.'
              : '这个问题暂时不在我能依据当前课程资料回答的范围内。欢迎换一个与本课程相关的问题；如果你问的是课程中的具体内容，也可以告诉我相关主题。';
        yield answer;
        finished = true;
        return;
      }
      providerName = runtime.provider;
      model = runtime.model;
      progress('context_ready');
      const compiled = compileTutorDialogue({
        courseId,
        releaseId,
        courseTitle: resolved.courseTitle,
        pageTitles: release.pages.map((page) => page.title),
        mode: input.mode,
        message: input.message,
        systemPrompt: prompts.systemPrompt,
        context: context ?? '',
        history,
        locale: input.locale,
      });
      const messages = compiled.messages;
      promptHash = compiled.promptHash;
      const images = selectKnowledgeImages(
        context ?? '',
        courseId,
        question,
      ).map((image) =>
        input.channel === 'learner'
          ? {
              ...image,
              url: image.url.replace(
                `/api/files/images/${courseId}/`,
                `/api/user/courses/${encodeURIComponent(input.courseIdHint)}/images/`,
              ),
            }
          : image,
      );

      const provider = this.registry.get(runtime.provider);
      const MAX_RETRIES = 2;
      const maxOutputTokens =
        runtime.model === 'qwen/qwen3.6-flash' ||
        runtime.model === 'google/gemini-3.5-flash'
          ? 4096
          : 2048;
      let attempt = 0;
      while (true) {
        attempt += 1;
        let started = false;
        let attemptAnswer = '';
        let visibleLength = 0;
        let pending = '';
        const placedImages = new Set<string>();
        let recorded = false;
        const attemptStartedAt = Date.now();
        const reasoningEffort =
          runtime.model === 'deepseek/deepseek-v4.1-flash'
            ? attempt === 1
              ? 'low'
              : 'none'
            : runtime.model === 'qwen/qwen3.6-flash' ||
                runtime.model === 'google/gemini-3.5-flash'
              ? 'low'
              : undefined;
        finishReason = undefined;
        usage = undefined;
        const recordAttempt = () => {
          if (recorded) return;
          recorded = true;
          attempts.push({
            attempt,
            finishReason,
            usage,
            answerChars: attemptAnswer.length,
            latencyMs: Date.now() - attemptStartedAt,
            maxOutputTokens,
            ...(reasoningEffort ? { reasoningEffort } : {}),
          });
        };
        try {
          progress('provider_start', attempt);
          const gen = provider.stream({
            model: runtime.model,
            messages,
            apiKey: runtime.apiKey,
            baseUrl: runtime.baseUrl,
            temperature: input.mode === 'SOCRATIC' ? 0.45 : 0.25,
            maxOutputTokens,
            ...(reasoningEffort ? { reasoningEffort } : {}),
            signal: input.signal,
            timeoutMs: 60_000,
            onEvent: (event) => {
              if (event.type === 'finish') finishReason = event.reason;
              else usage = event.usage;
            },
          });
          for await (const delta of gen) {
            input.signal?.throwIfAborted();
            attemptAnswer += delta;
            const visible = visibleTutorAnswer(attemptAnswer, input.mode);
            if (visible.length > visibleLength) {
              pending += visible.slice(visibleLength);
              visibleLength = visible.length;
              if (images.length) {
                let boundary = pending.indexOf('\n\n');
                while (boundary >= 0) {
                  const paragraph = pending.slice(0, boundary);
                  pending = pending.slice(boundary + 2);
                  const candidate = images.find(
                    (item) =>
                      !placedImages.has(item.url) &&
                      !answer.includes(item.url) &&
                      !paragraph.includes(item.url) &&
                      imageAfterParagraph(paragraph, item),
                  );
                  const image = candidate
                    ? imageAfterParagraph(paragraph, candidate)
                    : '';
                  if (candidate) placedImages.add(candidate.url);
                  const next = paragraph + (image ?? '') + '\n\n';
                  if (!started) progress('first_delta', attempt);
                  started = true;
                  answer += next;
                  yield next;
                  boundary = pending.indexOf('\n\n');
                }
              } else {
                if (!started) progress('first_delta', attempt);
                started = true;
                answer += pending;
                yield pending;
                pending = '';
              }
            }
          }
          recordAttempt();
          if (
            finishReason === 'length' &&
            !started &&
            attempt === 1 &&
            runtime.model === 'deepseek/deepseek-v4.1-flash'
          ) {
            progress('length_retry', attempt);
            continue;
          }
          if (finishReason === 'length') {
            throw new ConflictException('AI 回答达到输出上限，内容未完成');
          }
          if (!attemptAnswer.trim()) {
            throw new ConflictException(
              'AI 服务返回空回答，请重试或检查模型配置',
            );
          }
          const finalAnswer = visibleTutorAnswer(
            attemptAnswer,
            input.mode,
            true,
          );
          pending += finalAnswer.slice(visibleLength);
          if (pending) {
            const candidate = images.find(
              (item) =>
                !placedImages.has(item.url) &&
                !answer.includes(item.url) &&
                !pending.includes(item.url) &&
                imageAfterParagraph(pending, item),
            );
            const image = candidate
              ? imageAfterParagraph(pending, candidate)
              : '';
            const next = pending + (image ?? '');
            answer += next;
            yield next;
          }
          finished = true;
          return;
        } catch (err) {
          recordAttempt();
          // 仅首字节前且未超重试上限才重试（§4.4.3）
          if (
            started ||
            input.signal?.aborted ||
            err instanceof LlmTimeoutError ||
            (err instanceof OpenRouterHttpError &&
              err.upstreamStatus >= 400 &&
              err.upstreamStatus < 500) ||
            err instanceof ConflictException ||
            attempt > MAX_RETRIES
          ) {
            throw err;
          }
        } finally {
          recordAttempt();
        }
      }
    } catch (err) {
      if (input.signal?.aborted) {
        status = 'aborted';
      } else {
        status = 'error';
        errorText =
          err instanceof OpenRouterHttpError && err.diagnostic
            ? `${err.message} (${err.diagnostic})`
            : err instanceof Error
              ? err.message
              : String(err);
      }
      throw err;
    } finally {
      // 未正常结束且未报错 → 客户端断开（生成器被提前 return）
      if (!finished && status === 'ok') status = 'aborted';
      progress(status);
      // 旁路写日志（§4.4.2 第 7 步）：不 await，不影响对话主流程
      void this.chatLogger
        .write({
          requestId,
          courseId,
          releaseId,
          mode: input.mode,
          channel: input.channel,
          ...(input.userId ? { userId: input.userId } : {}),
          provider: providerName,
          model,
          historyCount: history.length * 2,
          latencyMs: Date.now() - startedAt,
          status,
          promptHash,
          error: errorText,
          finishReason,
          usage,
          attempts,
          question: input.message,
          answer,
        })
        .catch(() => {
          /* AiChatLogger 内部已兜底；此处防未来替换实现后 unhandled rejection */
        });
    }
  }
}

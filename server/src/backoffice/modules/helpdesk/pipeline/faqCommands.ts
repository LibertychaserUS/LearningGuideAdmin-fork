import type { FaqActor } from '../faqs/faqContracts';
import { createPgFaqGraphRepository } from '../faqs/faqGraphRepository';
import {
  createFaqGraphService,
  type FaqGraphService,
} from '../faqs/faqGraphService';
import { createPgFaqRepository, type SqlDb } from '../faqs/faqRepository';
import { createFaqService, type FaqService } from '../faqs/faqService';
import type {
  CommandContext,
  FaqCommand,
  FaqCommandBus,
} from './faqCommandBus';

/**
 * 卡库的写入命令（第 0 阶段：BackOffice 改卡与问题树）。每个命令在流水线给的事务里，用已有的服务做事：
 * 规则、校验、版本检查都还在原来的服务里（一处实现），这里只把它们放进同一个事务、同一条链。
 * 改了什么由流水线按修订表数，命令不用自己报。
 * 以后的命令（bundle.import.apply、candidate.accept）用同样的写法，一个命令里调几个服务都行。
 */

export type FaqCommandDeps = {
  /** 当前发布的版本号（读发布快照，不在写事务里）。 */
  releaseVersion: () => Promise<number | null>;
};

/** 处理器的输入：谁 + 原样的请求（服务自己校验，一次报全）。 */
type Call<T> = { employee: FaqActor } & T;

type Result<F extends (...args: never[]) => Promise<unknown>> = Awaited<
  ReturnType<F>
>;

export function createFaqCommands(deps: FaqCommandDeps) {
  /** 绑在本事务上的服务（每个命令新建，便宜：只是闭包）。 */
  function services(db: SqlDb) {
    const graph = createPgFaqGraphRepository(db);
    return {
      faqs: createFaqService({
        repository: createPgFaqRepository(db),
        releaseVersion: deps.releaseVersion,
        liveParents: (id) => graph.liveParents(id),
      }),
      graph: createFaqGraphService({ graph }),
    };
  }

  function command<I, O>(
    name: string,
    run: (input: I, ctx: CommandContext) => Promise<O>,
  ): FaqCommand<I, O> {
    return { name, lock: 'shared', parse: (raw) => raw as I, run };
  }

  return {
    cardCreate: command<
      Call<{ body: unknown; idempotencyKey?: string }>,
      Result<FaqService['create']>
    >('card.create', (i, ctx) =>
      services(ctx.db).faqs.create(i.employee, i.body, i.idempotencyKey),
    ),

    cardUpdate: command<
      Call<{ faqId: string; body: unknown }>,
      Result<FaqService['update']>
    >('card.update', (i, ctx) =>
      services(ctx.db).faqs.update(i.employee, i.faqId, i.body),
    ),

    cardArchive: command<
      Call<{ faqId: string; body: unknown }>,
      Result<FaqService['archive']>
    >('card.archive', (i, ctx) =>
      services(ctx.db).faqs.archive(i.employee, i.faqId, i.body),
    ),

    edgeCreate: command<
      Call<{ faqId: string; body: unknown }>,
      Result<FaqGraphService['createEdge']>
    >('edge.create', (i, ctx) =>
      services(ctx.db).graph.createEdge(i.employee, i.faqId, i.body),
    ),

    edgeUpdate: command<
      Call<{ edgeId: string; body: unknown }>,
      Result<FaqGraphService['updateEdge']>
    >('edge.update', (i, ctx) =>
      services(ctx.db).graph.updateEdge(i.employee, i.edgeId, i.body),
    ),

    edgeDelete: command<
      Call<{ edgeId: string }>,
      Result<FaqGraphService['deleteEdge']>
    >('edge.delete', (i, ctx) =>
      services(ctx.db).graph.deleteEdge(i.employee, i.edgeId),
    ),

    edgeReorder: command<
      Call<{ faqId: string; body: unknown }>,
      Result<FaqGraphService['reorder']>
    >('edge.reorder', (i, ctx) =>
      services(ctx.db).graph.reorder(i.employee, i.faqId, i.body),
    ),

    phrasingAdd: command<
      Call<{
        faqId: string;
        body: unknown;
        source?: Parameters<FaqGraphService['addPhrasing']>[3];
      }>,
      Result<FaqGraphService['addPhrasing']>
    >('phrasing.add', (i, ctx) =>
      services(ctx.db).graph.addPhrasing(i.employee, i.faqId, i.body, i.source),
    ),

    phrasingDelete: command<
      Call<{ phrasingId: string }>,
      Result<FaqGraphService['deletePhrasing']>
    >('phrasing.delete', (i, ctx) =>
      services(ctx.db).graph.deletePhrasing(i.employee, i.phrasingId),
    ),
  };
}

export type FaqCommands = ReturnType<typeof createFaqCommands>;

/**
 * BackOffice 页面用的卡库服务：读照旧直接走服务；写全部经流水线，执行者 = 登录员工，起因 = ui。
 * 控制器不知道流水线：模块提供的就是这两个对象，接口与 FaqService / FaqGraphService 完全相同。
 *
 * 这里不用 {...service} 展开：每个方法都要写明是读还是写。服务以后加了方法，这里编译不过，
 * 逼着决定它走不走流水线，不会有写入悄悄绕过去。
 */
export function backOfficeFaqServices(deps: {
  bus: FaqCommandBus;
  commands: FaqCommands;
  faqs: FaqService;
  graph: FaqGraphService;
}): { faqs: FaqService; graph: FaqGraphService } {
  const { bus, commands, faqs, graph } = deps;

  async function write<I extends { employee: FaqActor }, O>(
    command: FaqCommand<I, O>,
    input: I,
  ): Promise<O> {
    const { result } = await bus.execute(command, input, {
      actor: { employeeId: input.employee.employeeId },
      cause: { kind: 'ui' },
    });
    return result;
  }

  return {
    faqs: {
      // 读
      list: (...args) => faqs.list(...args),
      get: (...args) => faqs.get(...args),
      revisions: (...args) => faqs.revisions(...args),
      published: (...args) => faqs.published(...args),
      publishedOne: (...args) => faqs.publishedOne(...args),
      // 写
      create: (employee, body, idempotencyKey) =>
        write(commands.cardCreate, { employee, body, idempotencyKey }),
      update: (employee, faqId, body) =>
        write(commands.cardUpdate, { employee, faqId, body }),
      archive: (employee, faqId, body) =>
        write(commands.cardArchive, { employee, faqId, body }),
    },
    graph: {
      // 读
      edges: (...args) => graph.edges(...args),
      edgeRevisions: (...args) => graph.edgeRevisions(...args),
      phrasings: (...args) => graph.phrasings(...args),
      tree: (...args) => graph.tree(...args),
      // 写
      createEdge: (employee, faqId, body) =>
        write(commands.edgeCreate, { employee, faqId, body }),
      updateEdge: (employee, edgeId, body) =>
        write(commands.edgeUpdate, { employee, edgeId, body }),
      deleteEdge: (employee, edgeId) =>
        write(commands.edgeDelete, { employee, edgeId }),
      reorder: (employee, faqId, body) =>
        write(commands.edgeReorder, { employee, faqId, body }),
      addPhrasing: (employee, faqId, body, source) =>
        write(commands.phrasingAdd, { employee, faqId, body, source }),
      deletePhrasing: (employee, phrasingId) =>
        write(commands.phrasingDelete, { employee, phrasingId }),
    },
  };
}

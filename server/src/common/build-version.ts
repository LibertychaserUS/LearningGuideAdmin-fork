import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 前端构建身份（2026-10-31）。
 *
 * 背景：入口 index.html 曾经被 `immutable` 缓存一年（a908079 之前的
 * `useStaticAssets` 对整个目录生效），于是普通 F5 不会重新校验文档，必须
 * Ctrl+F5 或开无痕才能拿到新前端。服务端头已修好，但已经落进浏览器的那份
 * 一年缓存无法被覆盖 —— 只能靠一次性强刷清掉。
 *
 * 这里给前端一个"我是哪一版"的自述标识：对 index.html 取哈希即可，
 * 因为 Vite 把内容哈希写进了 script/link 的文件名，任何前端改动都会改变
 * index.html。客户端轮询该值并在变化时自动 reload，从此不再需要强刷。
 *
 * 不使用 APP_VERSION：Admin 服务没有配置该变量，且构建哈希天然与产物一致，
 * 不会出现"版本号写了但产物没更新"的漂移。
 */
export const VERSION_PATH = '/version.json';

export function readBuildVersion(clientDir: string): string | null {
  try {
    const html = readFileSync(join(clientDir, 'index.html'));
    return createHash('sha256').update(html).digest('hex').slice(0, 16);
  } catch {
    // 没有前端产物时（纯 API 角色）返回 null，接口保持可用。
    return null;
  }
}

/** 入口文档与版本标识都不允许被任何层缓存。 */
export function setNoStore(res: {
  setHeader: (name: string, value: string) => unknown;
}): void {
  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  );
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

/**
 * 把构建标识注入入口文档。
 *
 * 为什么不单靠首次轮询取基线：标签页被恢复（会话还原、休眠唤醒）时，首次轮询
 * 可能已经发生在发布之后，那会把新版本误当成"我加载的版本"，于是永远不刷新。
 * 由服务端在 HTML 里写明"你拿到的是哪一版"才是准的。
 */
export function withBuildMeta(html: string, version: string | null): string {
  if (!version) return html;
  // 已经注入过就不重复（例如浏览器把文档重新提交给服务端的情况）。
  if (html.includes(BUILD_META_NAME)) return html;
  const tag = `<meta name="${BUILD_META_NAME}" content="${version}" />`;
  return html.includes('</head>')
    ? html.replace('</head>', `  ${tag}\n  </head>`)
    : `${tag}\n${html}`;
}

export const BUILD_META_NAME = 'lg-build';

/**
 * 注册 GET /version.json。必须在 SPA catch-all 之前调用，
 * 否则会被前端回退路由先匹配走。
 */
export function registerVersionRoute(
  express: {
    get: (
      path: string,
      handler: (req: unknown, res: VersionResponse) => void,
    ) => unknown;
  },
  version: string | null,
): void {
  express.get(VERSION_PATH, (_req, res) => {
    setNoStore(res);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ version }));
  });
}

export interface VersionResponse {
  setHeader: (name: string, value: string) => unknown;
  end: (body: string) => unknown;
}

/**
 * 找不到的前端静态文件一律 404（2026-10-31）。
 *
 * 之前 SPA 回退路由会把任何没命中的路径都回成 index.html（200、text/html）。
 * 发布时新旧实例会短暂并存：新 index.html 引用的 `/assets/index-<新哈希>.js`
 * 若落到还没下线的旧实例上，旧实例没有这个文件，于是把 HTML 当成 JS 回给浏览器，
 * 浏览器拒绝执行（MIME 不对），整页空白。反过来，开着的旧页面去取旧哈希文件、
 * 新实例上已经没有了，也一样。
 *
 * 回 404 之后浏览器能明确知道"脚本没取到"，入口文档里的启动守护
 *（client/index.html 的 lg-boot-guard）会自动稍等再重新加载一次，而不是停在白屏。
 * 只拦静态资源形态的路径：/assets/ 下的一切，以及 .js/.mjs/.css/.map 结尾的路径；
 * 前端路由（/zh-CN/help-desk/:ticketId 等）不带这些后缀，不受影响。
 * /api 一律放行：这个路由注册在 Nest 控制器之前，不能挡住像 /api/files/x.css 这样的下载。
 */
export const MISSING_ASSET_PATTERN =
  /^(?!\/api(?:\/|$))(?:\/assets\/|.*\.(?:m?js|css|map)$)/i;

export function isStaticAssetPath(path: string): boolean {
  return MISSING_ASSET_PATTERN.test(path);
}

export function registerMissingAssetRoute(express: {
  get: (
    path: RegExp,
    handler: (req: unknown, res: MissingAssetResponse) => void,
  ) => unknown;
}): void {
  express.get(MISSING_ASSET_PATTERN, (_req, res) => {
    // 404 也不许缓存：几秒后新实例上就有这个文件了。
    setNoStore(res);
    res.status(404);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Not found');
  });
}

export interface MissingAssetResponse extends VersionResponse {
  status: (code: number) => unknown;
}

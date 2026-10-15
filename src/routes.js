/**
 * 宿主半边的 HTTP 路由：给客户端图谱面板供数据。
 *
 * ⚠️ 安全（照 dsh-balance-pill 的实测结论）：`/plugins/<包名>/...` 这类路由
 * **不经过** `client-connection` 的会话 cookie 校验（那条只覆盖 `/api` 与 WebSocket）。
 * 所以端点必须**自己做两道检查**：
 *   1. 只接受回环来源（remoteAddress 是 127.0.0.1 / ::1）
 *   2. 若带 Origin，必须与 Host 同源
 *
 * 本模块是纯函数式（handler 由 createRoutes 造出来），便于测试直接喂假 req/res。
 */

import { buildSnapshot, nodeDetail, countStats } from './graph.js'

/** 路由前缀。客户端半边用同样的常量，改这里要一起改。 */
export const ROUTE_BASE = '/plugins/dsh-ai-memory'

/**
 * 力导向 Worker 的**包内分块**文件名。
 *
 * ✅ 关键发现：**不需要自建路由**。DSH 的 client-modules 本来就按需服务包内的
 * `client.<name>.js` 分块（`dsh-client-modules/lib/index.js:169` 的正则
 * `^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$`，以及 `chunkRequest()` / `chunkResponse()`）。
 * 实测：`GET /plugins/dsh-ai-memory/client.graph-worker.js?rev=<客户端 bundle 的 rev>`
 * 返回 200 与正确的源码。
 *
 * 所以 worker 只要（a）命名符合上面那个正则、（b）放在包目录下，
 * 就能被 DSH 自己的分块路由服务 —— **不必本插件再注册一条路由**。
 * 这比自建路由更好：走的是官方通道，rev 与客户端 bundle 同源，升级时不会漂。
 *
 * ⚠️ `?rev=` 必须带，且值是**本插件客户端 bundle 的 rev**（宿主按 mtime/ctime/size 算的那个）。
 * 客户端半边从自己的模块 URL 里取出这个 rev 再拼给 Worker —— 见 `lib/client.js` 的
 * `resolveWorkerUrl()`。
 */
export const WORKER_FILE = 'client.graph-worker.js'

/**
 * 判断请求是否来自本机回环地址。
 * @param {string|undefined} address - `req.socket.remoteAddress`。
 * @returns {boolean} 是否只可能是本机。
 */
export function isLoopback(address) {
  if (typeof address !== 'string') return false
  if (address === '::1' || address === '127.0.0.1') return true
  // IPv4-mapped IPv6：Node 在双栈监听下的常见形态。
  return address.startsWith('::ffff:') && address.slice(7) === '127.0.0.1'
}

/**
 * 比较 Origin 与 Host 是否指向同一个 authority。
 * @param {string} origin - 请求的 Origin 头。
 * @param {unknown} host - 请求的 Host 头。
 * @returns {boolean} 是否同源。
 */
export function originMatchesHost(origin, host) {
  if (typeof host !== 'string' || host === '') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * 造一组路由处理器。
 *
 * @param {object} lib - openLibrary() 的产物。
 * @param {{maxNodes?: number}} [opts] - 选项。
 * @returns {object[]} `{ kind, path, handler }` 数组，可直接交给 webServer.register。
 */
export function createRoutes(lib, opts = {}) {
  const maxNodes = Number.isInteger(opts.maxNodes) ? opts.maxNodes : 500

  /**
   * 统一的安全检查 + JSON 响应包装。
   * @param {object} req - 请求。
   * @param {object} res - 响应。
   * @param {(url: URL) => object} produce - 产生响应体。
   * @returns {void}
   */
  const guarded = (req, res, produce) => {
    const deny = (code, reason) => {
      res.statusCode = code
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ ok: false, error: reason }))
    }

    if (!isLoopback(req.socket?.remoteAddress)) {
      deny(403, '只接受本机回环请求')
      return
    }
    const origin = req.headers?.origin
    if (typeof origin === 'string' && origin !== '' && !originMatchesHost(origin, req.headers?.host)) {
      deny(403, 'Origin 与 Host 不同源')
      return
    }

    let payload
    try {
      payload = produce(new URL(req.url ?? '/', 'http://localhost'))
    } catch (err) {
      deny(500, `读取记忆库失败：${err.message}`)
      return
    }
    res.statusCode = 200
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(payload))
  }

  return [
    {
      kind: 'exact',
      path: `${ROUTE_BASE}/snapshot`,
      handler: (req, res) => {
        guarded(req, res, (url) => {
          const { state } = lib.load()
          const snap = buildSnapshot(state, {
            includeRetired: url.searchParams.get('retired') === '1',
            maxNodes,
          })
          return { ok: true, ...snap }
        })
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_BASE}/node`,
      handler: (req, res) => {
        guarded(req, res, (url) => {
          const id = url.searchParams.get('id') ?? ''
          const { state } = lib.load()
          const detail = nodeDetail(state, id)
          if (detail === null) return { ok: false, error: `找不到判断 ${id}` }
          return { ok: true, node: detail }
        })
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_BASE}/stats`,
      handler: (req, res) => {
        guarded(req, res, () => {
          const { state, problems } = lib.load()
          return { ok: true, stats: countStats(state), problems }
        })
      },
    },
  ]
}

/**
 * Host-side HTTP routes: supply data to the client graph panel.
 *
 * ⚠️ Security (per dsh-balance-pill's field conclusion): routes of the form
 * `/plugins/<package>/...` do **not** pass through `client-connection`'s session
 * cookie check (that covers only `/api` and the WebSocket). Endpoints must
 * therefore **check two things themselves**:
 *   1. accept loopback origins only (remoteAddress is 127.0.0.1 / ::1)
 *   2. when an Origin is present, it must be same-origin with Host
 *
 * This module is functional (handlers are built by createRoutes), so tests can
 * feed it fake req/res objects directly.
 */

import { buildSnapshot, nodeDetail, countStats } from './graph.js'

/** Route prefix. The client side uses the same constant; change both together. */
export const ROUTE_BASE = '/plugins/dsh-ai-memory'

/**
 * In-package chunk file name of the force-directed worker.
 *
 * ✅ Key finding: **no route of our own is needed**. DSH's client-modules already
 * serves in-package `client.<name>.js` chunks on demand (the regex
 * `^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$` at
 * `dsh-client-modules/lib/index.js:169`, plus `chunkRequest()` /
 * `chunkResponse()`). Measured:
 * `GET /plugins/dsh-ai-memory/client.graph-worker.js?rev=<client bundle rev>`
 * returns 200 with the correct source.
 *
 * So the worker is served by DSH's own chunk route as long as (a) its name
 * matches that regex and (b) it sits in the package directory — the plugin does
 * **not** register a route of its own. That is better than a custom route: it
 * uses the official channel, shares the client bundle's rev, and will not drift
 * on upgrade.
 *
 * ⚠️ `?rev=` is mandatory and must be **this plugin's client bundle rev** (the
 * one the host computes from mtime/ctime/size). The client side reads that rev
 * out of its own module URL and appends it for the worker — see
 * `resolveWorkerUrl()` in `lib/client.js`.
 */
export const WORKER_FILE = 'client.graph-worker.js'

/**
 * Test whether a request comes from a local loopback address.
 * @param {string|undefined} address - `req.socket.remoteAddress`.
 * @returns {boolean} Whether the address can only be local.
 */
export function isLoopback(address) {
  if (typeof address !== 'string') return false
  if (address === '::1' || address === '127.0.0.1') return true
  // IPv4-mapped IPv6: the common shape under Node's dual-stack listening.
  return address.startsWith('::ffff:') && address.slice(7) === '127.0.0.1'
}

/**
 * Compare whether Origin and Host refer to the same authority.
 * @param {string} origin - Request Origin header.
 * @param {unknown} host - Request Host header.
 * @returns {boolean} Whether they are same-origin.
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
 * Build the route handlers.
 *
 * @param {object} lib - Product of openLibrary().
 * @param {{maxNodes?: number}} [opts] - Options.
 * @returns {object[]} `{ kind, path, handler }` array, ready for webServer.register.
 */
export function createRoutes(lib, opts = {}) {
  const maxNodes = Number.isInteger(opts.maxNodes) ? opts.maxNodes : 500

  /**
   * Shared security check plus JSON response wrapper.
   * @param {object} req - Request.
   * @param {object} res - Response.
   * @param {(url: URL) => object} produce - Produces the response body.
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

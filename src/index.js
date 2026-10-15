/**
 * dsh-ai-memory 插件入口。
 *
 * 定位（遵 DSH 官方立场）：**session log 是唯一真相，本插件是派生的记忆缓存。**
 * 它不 append 任何会话事件（那样会让会话无法重开），而是把判断存在自己的账本里，
 * 由账本 fold 出当前状态。
 *
 * ⚠️ 本文件刻意**不导入任何外部包**（没有 schemastery、没有 cordis、没有 dsh-tools）。
 * 原因是一个真实踩过的坑：插件以 `link:`（junction）方式装进 profile 时，
 * 链接包不会获得自己的 `node_modules`，Node 从插件目录往上遍历都找不到 profile 里
 * 提升的依赖，于是宿主启动时解析失败、插件停在 `fiberPhase: null` 不激活 ——
 * 表现就是「装的时候好使，一重启就没了」（dsh-balance-pill/src/index.js 记录了同一条）。
 * 配置因此自己校验，工具定义手写 JSON Schema（见 tools.js）。
 *
 * ⚠️ 另一条硬纪律：`inject` 必须**如实列出**本插件用到的每个服务。
 * viya-memory 踩过这个坑：`apply()` 用了 `ctx.systemPrompt` 却没写进 `inject`，
 * 结果**插件整条不激活、不报错、一个工具都没注册**，而 mock ctx 自测全绿也抓不到。
 */

import { join } from 'node:path'
import { homedir } from 'node:os'

import { foldEvents, foldAsOf, activeNodes, nodeOf, backlinksOf, outlinksOf, supersedeChain, KIND, STATUS } from './ledger.js'
import { planWrite, makeNodeId } from './supersede.js'
import { readLedger, appendEvents } from './store.js'
import { search as searchNodes, summarize } from './query.js'
import { buildTools } from './tools.js'
import { createRoutes } from './routes.js'

export const name = 'dsh-ai-memory'

/**
 * 本插件**必需**的服务，如实声明。
 *
 * `tools`       —— 注册六个记忆工具（本插件的核心价值，缺了就没意义）
 * `systemPrompt` —— 会话开始时注入当前判断索引（【读取】）
 *
 * ⚠️ `webServer` **刻意不在这里**。它是阶段②（图谱面板）才需要的，
 * 放进必需 inject 会让插件在缺 webServer 的 profile 里**整条不激活 ——
 * 连工具都没了，而且不报错**（viya-memory 正是这么踩的）。
 * 所以路由改用 `ctx.inject(['webServer'], ...)` 做**局部**可选依赖：
 * 有 webServer 就挂路由，没有就只少了图谱面板，工具照常工作。
 */
export const inject = ['tools', 'systemPrompt']

/**
 * 解析配置。
 *
 * 兼容三种形态（照 dsh-balance-pill 的做法，因为纯 JS 拿不到 schemastery 的类型）：
 *   1. 普通对象（patch 直接透传）
 *   2. 带 `.get()` 的引用对象（设置服务投的）
 *   3. undefined（用默认值）
 *
 * ⚠️ schemastery 的 `.volatile()` 字段解析后是 `{ get() }` 盒子而非值。
 * 直接当值用会让 `String(路径)` 得到 `"[object Object]"`、数字阈值静默变 NaN。
 * viya-memory 实测因此把卡写进了 `<cwd>\[object Object]\`。这里统一解包。
 *
 * @param {unknown} raw - cordis 传入的 config。
 * @returns {{dir: string, injectIndex: boolean, maxIndexEntries: number, enabled: boolean}} 解析后的配置。
 */
export function resolveConfig(raw) {
  const box = raw !== null && typeof raw === 'object' ? raw : {}
  const unwrap = (v, fallback) => {
    if (v !== null && typeof v === 'object' && typeof v.get === 'function') {
      try {
        const got = v.get()
        return got === undefined ? fallback : got
      } catch {
        return fallback
      }
    }
    return v === undefined ? fallback : v
  }

  const dirRaw = unwrap(box.dir, join(homedir(), '.dsh', 'ai-memory'))
  const dir = typeof dirRaw === 'string' && dirRaw !== '' ? dirRaw : join(homedir(), '.dsh', 'ai-memory')

  const injectRaw = unwrap(box.injectIndex, true)
  const maxRaw = unwrap(box.maxIndexEntries, 40)
  const enabledRaw = unwrap(box.enabled, true)
  const maxGraphRaw = unwrap(box.maxGraphNodes, 500)

  const maxIndexEntries = Number.isFinite(Number(maxRaw)) && Number(maxRaw) > 0 ? Math.floor(Number(maxRaw)) : 40
  const maxGraphNodes = Number.isFinite(Number(maxGraphRaw)) && Number(maxGraphRaw) > 0 ? Math.floor(Number(maxGraphRaw)) : 500

  return {
    dir,
    injectIndex: injectRaw !== false,
    maxIndexEntries,
    maxGraphNodes,
    enabled: enabledRaw !== false,
  }
}

/**
 * 打开记忆库：读账本、fold 成状态，并提供读写操作。
 *
 * 每次调用都**重新读盘**（记忆库可能被手工编辑，这是纯文本的代价与好处）。
 * 规模上这是 O(全部事件)，与 viya-memory 的取向一致（无缓存、无后台进程）；
 * 判断数量到万级时需要加索引层，那是后续工作。
 *
 * @param {string} dir - 记忆库目录。
 * @returns {object} 记忆库句柄。
 */
export function openLibrary(dir) {
  const ledgerPath = join(dir, 'ledger.jsonl')

  const load = () => {
    const { events, problems: parseProblems } = readLedger(ledgerPath)
    const state = foldEvents(events)
    return { events, state, problems: [...parseProblems.map((p) => `账本第 ${p.line} 行：${p.reason}`), ...state.problems.map((p) => p.reason)] }
  }

  const commit = (events) => appendEvents(ledgerPath, events)

  return { dir, ledgerPath, load, commit }
}

/**
 * 记忆库的高层操作。工具实现都落在这里，便于测试时直接喂一个临时目录。
 *
 * @param {object} lib - openLibrary() 的产物。
 * @param {{now?: () => number}} [opts] - 可注入时钟（测试用）。
 * @returns {object} 六个操作。
 */
export function createOperations(lib, opts = {}) {
  const now = opts.now ?? (() => Date.now())

  const search = (args) => {
    const { state } = lib.load()
    const pool = args?.include_retired === true ? [...state.nodes.values()] : activeNodes(state)
    const r = searchNodes(pool, String(args?.query ?? ''), { limit: args?.limit })
    return {
      total: r.total,
      relaxed: r.relaxed,
      results: r.results.map((n) => {
        const out = outlinksOf(state, n.id)
        return {
          id: n.id,
          text: summarize(n.text, 200),
          status: n.status,
          kind: n.kind,
          score: typeof n.score === 'number' ? n.score : 0,
          ...(n.supersededBy !== null ? { superseded_by: n.supersededBy } : {}),
          links: out.map((e) => `${e.type}→${e.to}`),
        }
      }),
    }
  }

  const write = (args) => {
    const text = String(args?.text ?? '').trim()
    if (text === '') return { action: 'rejected', note: '判断不能为空。' }
    const { state } = lib.load()
    const at = now()
    const newId = makeNodeId(at, state.seq + 1)
    const { events, outcome } = planWrite(
      state,
      {
        text,
        subject: args?.subject,
        relation: args?.relation,
        object: args?.object,
        // 三种 kind：judgment（默认）/ rule（受治理）/ insight（想法，不参与取代）
        kind: args?.kind === KIND.RULE ? KIND.RULE
          : args?.kind === KIND.INSIGHT ? KIND.INSIGHT
            : KIND.JUDGMENT,
        tags: Array.isArray(args?.tags) ? args.tags : [],
        citations: Array.isArray(args?.citations) ? args.citations : [],
        reason: args?.reason,
      },
      { at, nextSeq: state.seq, newId },
    )
    if (events.length > 0) {
      const res = lib.commit(events)
      if (!res.ok) return { action: 'failed', note: `写盘失败：${res.reason}` }
    }
    return {
      action: outcome.action,
      node_id: outcome.nodeId,
      ...(outcome.supersededId !== undefined ? { superseded_id: outcome.supersededId } : {}),
      ...(outcome.supersededText !== undefined ? { superseded_text: summarize(outcome.supersededText, 160) } : {}),
      note: outcome.note,
    }
  }

  const connect = (args) => {
    const from = String(args?.from ?? '')
    const to = String(args?.to ?? '')
    const type = String(args?.type ?? 'complements')
    if (from === '' || to === '') return { ok: false, note: 'from 与 to 都必填。' }
    if (from === to) return { ok: false, note: '不能自连。' }
    const { state } = lib.load()
    if (!state.nodes.has(from)) return { ok: false, note: `找不到判断 ${from}。先 memory_search 确认 id。` }
    if (!state.nodes.has(to)) return { ok: false, note: `找不到判断 ${to}。先 memory_search 确认 id。` }
    const at = now()
    const res = lib.commit([{ seq: state.seq + 1, at, type: 'edge.linked', data: { from, to, type, note: String(args?.note ?? '') } }])
    if (!res.ok) return { ok: false, note: `写盘失败：${res.reason}` }
    return { ok: true, note: `已在 ${from} 与 ${to} 之间建立 ${type} 关系（两边都会看到，不留单向边）。` }
  }

  const history = (args) => {
    const id = String(args?.id ?? '')
    const { events, state } = lib.load()
    const n = nodeOf(state, id)
    if (n === undefined) return { found: false, note: `找不到判断 ${id}。` }

    // 双时态查询：给了 at 就折叠到那一刻，回答"那时候这条判断是什么样"。
    // 这是账本式存储换来的能力 —— 文件式记忆做不到。
    const atRaw = args?.at
    if (Number.isFinite(Number(atRaw))) {
      const at = Number(atRaw)
      const then = foldAsOf(events, at)
      const before = nodeOf(then, id)
      const when = new Date(at).toISOString()
      if (before === undefined) {
        return { found: false, note: `${when} 时这条判断还不存在（它建于 ${new Date(n.createdAt).toISOString()}）。` }
      }
      return {
        found: true,
        revisions: before.history.map((h) => ({ at: h.at, text: summarize(h.text, 200), reason: h.reason })),
        chain: supersedeChain(then, id).chain.map((c) => ({ id: c.id, text: summarize(c.text, 160), status: c.status })),
        note: `${when} 那一刻：状态 ${before.status}，第 ${before.revision} 版。`,
      }
    }

    const { chain } = supersedeChain(state, id)
    return {
      found: true,
      revisions: n.history.map((h) => ({ at: h.at, text: summarize(h.text, 200), reason: h.reason })),
      chain: chain.map((c) => ({ id: c.id, text: summarize(c.text, 160), status: c.status })),
      note: `共 ${n.history.length} 次变更；取代链长 ${chain.length}。`,
    }
  }

  const rule = (args) => {
    const action = String(args?.action ?? 'read')
    const { state } = lib.load()

    if (action === 'read') {
      const rules = [...state.nodes.values()].filter((n) => n.kind === KIND.RULE)
      return {
        ok: true,
        rules: rules.map((r) => ({
          id: r.id,
          text: r.text,
          revision: r.revision,
          history: r.history.map((h) => `${new Date(h.at).toISOString()} · ${h.reason}`),
        })),
        note: rules.length === 0 ? '还没有任何规矩。' : `共 ${rules.length} 条规矩。`,
      }
    }

    if (action === 'amend') {
      const id = String(args?.id ?? '')
      const text = String(args?.text ?? '').trim()
      const reason = String(args?.reason ?? '').trim()
      // 治理：改规矩必须说明理由。没有理由的变更不予受理 —— 这是"可审计"的前提。
      if (reason === '') return { ok: false, note: '改规矩必须给 reason（这条纪律是刻意的：没有理由的变更无法审计）。' }
      if (text === '') return { ok: false, note: '新规矩不能为空。' }

      if (!state.nodes.has(id)) {
        // 规矩不存在则新建（同时把 reason 记为它的建立理由）。
        const at = now()
        const newId = makeNodeId(at, state.seq + 1)
        const res = lib.commit([
          { seq: state.seq + 1, at, type: 'node.created', data: { id: newId, kind: KIND.RULE, text } },
        ])
        if (!res.ok) return { ok: false, note: `写盘失败：${res.reason}` }
        return { ok: true, rules: [{ id: newId, text, revision: 1, history: [] }], note: `新规矩已建立（${newId}）。理由：${reason}` }
      }

      const at = now()
      const res = lib.commit([{ seq: state.seq + 1, at, type: 'rule.amended', data: { id, after: text, reason } }])
      if (!res.ok) return { ok: false, note: `写盘失败：${res.reason}` }
      const after = lib.load()
      const n = nodeOf(after.state, id)
      return {
        ok: true,
        rules: [{ id, text: n.text, revision: n.revision, history: n.history.map((h) => `${new Date(h.at).toISOString()} · ${h.reason}`) }],
        note: `规矩已改（第 ${n.revision} 版）。理由已留痕。`,
      }
    }

    if (action === 'rollback') {
      // 回滚 = 把某条规矩恢复到它的**第 N 版**（N 从 1 开始，对应 history 的下标 N-1）。
      // 为什么是"恢复"而不是"删事件"：账本只追加，历史永不删除 ——
      // 回滚本身也是一次新的变更，同样要留理由、同样进 history。
      // 这样"回滚"这件事本身也是可审计的，而不是把过去抹掉。
      const id = String(args?.id ?? '')
      const toRevision = Number(args?.to_revision)
      const reason = String(args?.reason ?? '').trim()
      if (reason === '') return { ok: false, note: '回滚也要给 reason（回滚同样是一次变更，同样要能审计）。' }
      if (!Number.isInteger(toRevision) || toRevision < 1) {
        return { ok: false, note: 'rollback 需要 to_revision（正整数，从 1 开始，对应 memory_rule read 里 history 的序号）。' }
      }
      const target = nodeOf(state, id)
      if (target === undefined) return { ok: false, note: `找不到规矩 ${id}。` }
      if (target.kind !== KIND.RULE) return { ok: false, note: `${id} 不是规矩（kind=${target.kind}），规矩治理只管 kind=rule 的节点。` }
      const entry = target.history[toRevision - 1]
      if (entry === undefined) {
        return {
          ok: false,
          note: `规矩 ${id} 只有 ${target.history.length} 版，没有第 ${toRevision} 版。先用 action=read 看 history。`,
        }
      }
      if (toRevision === target.revision) {
        return { ok: false, note: `规矩 ${id} 现在就是第 ${toRevision} 版，无需回滚。` }
      }

      const at = now()
      const res = lib.commit([
        {
          seq: state.seq + 1,
          at,
          type: 'rule.amended',
          data: { id, after: entry.text, reason: `回滚到第 ${toRevision} 版：${reason}` },
        },
      ])
      if (!res.ok) return { ok: false, note: `写盘失败：${res.reason}` }
      const after = lib.load()
      const n = nodeOf(after.state, id)
      return {
        ok: true,
        rules: [{ id, text: n.text, revision: n.revision, history: n.history.map((h) => `${new Date(h.at).toISOString()} · ${h.reason}`) }],
        note: `已回滚到第 ${toRevision} 版的内容（现在是第 ${n.revision} 版）。回滚本身也留痕 —— 历史没有被抹掉。`,
      }
    }

    return { ok: false, note: `不认识的 action：${action}（支持 read / amend / rollback）。` }
  }

  const stats = () => {
    const { state, problems } = lib.load()
    const all = [...state.nodes.values()]
    const judgments = all.filter((n) => n.kind === KIND.JUDGMENT)
    const rules = all.filter((n) => n.kind === KIND.RULE)
    const active = activeNodes(state)
    const connected = new Set()
    for (const e of state.edges) {
      connected.add(e.from)
      connected.add(e.to)
    }
    const orphans = active.filter((n) => !connected.has(n.id)).length
    const insights = all.filter((n) => n.kind === KIND.INSIGHT)
    return {
      judgments: judgments.filter((n) => n.status === STATUS.ACTIVE).length,
      rules: rules.filter((n) => n.status === STATUS.ACTIVE).length,
      insights: insights.filter((n) => n.status === STATUS.ACTIVE).length,
      retired: all.filter((n) => n.status !== STATUS.ACTIVE).length,
      edges: state.edges.length,
      orphans,
      problems,
      note:
        active.length === 0
          ? '记忆库是空的。这本身是诚实的 —— 写不出真判断时，就该是空的。'
          : `活跃 ${active.length} 条；${orphans} 条还没有任何连接。`,
    }
  }

  return { search, write, connect, history, rule, stats }
}

/**
 * 生成注入 system prompt 的索引文本（【读取】）。
 *
 * 设计取舍：只注入**索引**（规矩全文 + 判断摘要），不注入全部正文。
 * 理由是社区实测的「上下文膨胀 → 注意力稀释 / 约束遗忘」：
 * 塞进一整部小说，模型可能恰好漏掉最关键的那段。细节按需用 memory_search 取。
 *
 * @param {object} lib - openLibrary() 的产物。
 * @param {number} maxEntries - 最多列几条判断。
 * @returns {string} 注入文本；库为空时返回空串（不占上下文）。
 */
export function buildIndexText(lib, maxEntries) {
  const { state } = lib.load()
  const active = activeNodes(state)
  if (active.length === 0) return ''

  const rules = active.filter((n) => n.kind === KIND.RULE)
  const judgments = active.filter((n) => n.kind === KIND.JUDGMENT)
  const insights = active.filter((n) => n.kind === KIND.INSIGHT)

  const lines = []
  lines.push('【你自己的记忆】以下是你此前形成的判断与给自己定的规矩。它们**是你自己的观点**，不是用户说的话。')

  if (rules.length > 0) {
    lines.push('')
    lines.push('规矩（你给自己定的，改它要说明理由）：')
    for (const r of rules) lines.push(`- [${r.id}] ${summarize(r.text, 300)}`)
  }

  if (judgments.length > 0) {
    lines.push('')
    lines.push(`活跃判断（共 ${judgments.length} 条${judgments.length > maxEntries ? `，此处列前 ${maxEntries} 条` : ''}）：`)
    const shown = judgments.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, maxEntries)
    for (const j of shown) {
      const marks = []
      const back = backlinksOf(state, j.id).length
      const out = outlinksOf(state, j.id).length
      if (back + out > 0) marks.push(`↔${back + out}`)
      lines.push(`- [${j.id}] ${summarize(j.text, 300)}${marks.length > 0 ? ` (${marks.join(' ')})` : ''}`)
    }
  }

  /**
   * 想法（insight）也要注入 —— 否则它们等于白写。
   *
   * ⚠️ 这是本鲸补的一处**遗漏**：`insight` 类型的价值就是"被想起来"，
   * 但不注入的话它只躺在账本里，永远没人看。
   *
   * **只列最近几条、且给更小的预算**（`maxEntries / 2`）：想法没有判断那么硬，
   * 占太多上下文会稀释真正要紧的规矩与判断（社区实测的「上下文膨胀 → 约束遗忘」）。
   */
  if (insights.length > 0) {
    const budget = Math.max(1, Math.floor(maxEntries / 2))
    const shown = insights.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, budget)
    lines.push('')
    lines.push(`还没成形到能当判断的想法（共 ${insights.length} 条${insights.length > budget ? `，此处列最新 ${budget} 条` : ''}）：`)
    for (const it of shown) lines.push(`- [${it.id}] ${summarize(it.text, 200)}`)
  }

  lines.push('')
  lines.push(
    '形成新判断、发现两条旧判断矛盾、被纠正、或改了主意时，先 memory_search 再 memory_write。' +
      '只写判断，不写事实 —— 事实查得到，判断才是你自己的。写不出真判断时就不要写。',
  )
  return lines.join('\n')
}

/**
 * 插件入口。
 *
 * 所有注册都在 `ctx.effect()` 里并返回清理函数 —— 插件卸载时自动回收，
 * 这是官方 practices.md 的硬要求（"Registrations are effects owned by a context"）。
 *
 * @param {object} ctx - cordis 上下文。
 * @param {object} [rawConfig] - 插件配置。
 * @returns {void}
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) return

  const lib = openLibrary(config.dir)
  const ops = createOperations(lib)
  const tools = buildTools(ops)

  // 工具注册。tools 已在 inject 里声明，所以这里能直接拿到。
  ctx.effect(() => {
    const disposers = tools.map((t) => ctx.tools.register(t))
    return () => {
      for (const d of disposers) {
        if (typeof d === 'function') d()
      }
    }
  }, 'dsh-ai-memory: tools')

  // 【读取】会话开始注入索引。text 是**函数**（惰性求值）→ 每次都现读盘，不缓存，
  // 所以刚写的判断下一轮就能看见。interpolate:false 防止正文里的 {{}} 被当模板变量
  // （viya-memory 踩过：未注册的名字会让整个 prompt 组装失败，症状是会话跑不动）。
  if (config.injectIndex) {
    ctx.effect(
      () =>
        ctx.systemPrompt.section({
          name: 'dsh-ai-memory:index',
          order: 10300,
          interpolate: false,
          text: () => {
            try {
              return buildIndexText(lib, config.maxIndexEntries)
            } catch {
              // 读失败时静默降级为空串：绝不因为记忆库坏了就让整个会话跑不动。
              return ''
            }
          },
        }),
      'dsh-ai-memory: index section',
    )
  }

  // 图谱面板的数据路由（阶段②）。
  // 用 ctx.inject 做**局部**可选依赖：没有 webServer 的 profile 里，插件其余部分照常工作。
  // 端点自带回环 + 同源检查（见 routes.js）—— /plugins/* 不经过会话 cookie 校验。
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => {
      const routes = createRoutes(lib, { maxNodes: config.maxGraphNodes })
      const disposers = routes.map((r) => scope.webServer.register(r))
      return () => {
        for (const d of disposers) {
          if (typeof d === 'function') d()
        }
      }
    }, 'dsh-ai-memory: graph routes')
  })
}

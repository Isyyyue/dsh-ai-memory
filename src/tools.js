/**
 * 工具定义（零依赖）。
 *
 * ⚠️ 为什么这里**不 import `@deepseek-ai/dsh-tools` 的 defineTool**：
 * 插件以 `link:`（junction）方式装进 profile 时**拿不到自己的 node_modules**
 * （dsh-balance-pill 与 viya-memory 都踩过这个坑，表现为"装的时候好使，一重启就没了"）。
 * 而 `ctx.tools.register()` 只校验定义对象的形状，`parameters` 与 `output.schema`
 * 收的是**原始 JSON Schema**（读 dsh-tools/lib/index.js:2874 的 register 实现确认）。
 * 所以手写 JSON Schema 既合法又零依赖。
 *
 * ⚠️ 一个被测试抓到的真 bug（正是"静默失效"那一类）：
 * `register()` 收的 `parameters` 是**完整 JSON Schema**（内部会 `jsonSchemaToTs(schema.parameters)`
 * 渲染 SDK），**不是** `defineTool` 那种裸属性表。写成裸属性表**不会在 register 时抛错** ——
 * 它被原样塞进 ToolSchema，等到渲染 SDK / 组装 prompt 时才以奇怪的方式坏掉。
 * 所以 `tool()` 负责把作者写的简写（属性表 + `required: true`）编译成
 * `{ type: 'object', properties, required }`。
 *
 * JSON Schema 子集限制（照 dsh-tools 的 assertSupportedJsonSchema）：
 *   支持 type: object / array / string / number / integer / boolean / null
 *   支持 properties / required / additionalProperties / items / enum / const / oneOf
 *   不支持 $ref / patternProperties / 类型数组
 */

/** 六条关系类型。前三种对应规格里的「互补 / 矛盾 / 取代」，后三种是自然扩展。 */
export const LINK_TYPES = Object.freeze([
  'complements', // 互补：两条判断互相补强
  'tensions',    // 矛盾：两条判断互相冲突（但不构成取代）
  'supersedes',  // 取代：新的推翻了旧的（由引擎自动建立）
  'derives',     // 衍生：从对方推出来的
  'depends',     // 依据：我依赖对方成立
  'restates',    // 复述：同一断言
])

/**
 * 造一个工具定义的公共外壳，并把简写参数表编译成 JSON Schema。
 *
 * @param {object} spec - `{ name, description, parameters, schema, render, execute }`。
 *   `parameters` 是属性表：每个值可带 `required: true`。
 * @returns {object} 可交给 ctx.tools.register() 的定义。
 */
function tool(spec) {
  const raw = spec.parameters ?? {}
  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || typeof value !== 'object') continue
    const { required: isRequired, ...rest } = value
    properties[key] = rest
    if (isRequired === true) required.push(key)
  }

  return {
    name: spec.name,
    description: spec.description,
    parameters: { type: 'object', properties, required },
    output: {
      schema: spec.schema,
      render:
        spec.render ??
        ((_args, value) => [
          { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
        ]),
    },
    execute: spec.execute,
  }
}

/** 可选字符串参数。 */
const str = (description) => ({ type: 'string', description })
/** 必填字符串参数。 */
const strReq = (description) => ({ type: 'string', description, required: true })
/** 可选字符串数组参数。 */
const strArray = (description) => ({ type: 'array', items: { type: 'string' }, description })

/**
 * 六个工具的定义。每个都返回**模型可读的 JSON**，且都遵守"确定性、零 LLM"。
 *
 * @param {object} deps - `{ search, write, connect, rule, history, stats }` 六个实现函数。
 * @returns {object[]} 工具定义数组。
 */
export function buildTools(deps) {
  return [
    tool({
      name: 'memory_search',
      description:
        '在已有判断里检索。**写新判断之前必须先调用它**，看是否已有相关判断（可能已有、可能矛盾）。' +
        '中文按二字滑窗检索，英文按词。返回判断原文、状态与相关度。',
      parameters: {
        query: strReq('检索词。空格分隔多个词时默认 AND（都要命中）；放宽为 OR 时结果里会标 relaxed'),
        limit: { type: 'integer', description: '最多返回几条，默认 10' },
        include_retired: { type: 'boolean', description: '是否包含已被取代/撤回的判断（默认否）' },
      },
      schema: {
        type: 'object',
        properties: {
          total: { type: 'integer' },
          relaxed: { type: 'boolean' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: str('判断 id'),
                text: str('判断原文'),
                status: str('active / superseded / withdrawn'),
                kind: str('judgment / rule / insight'),
                score: { type: 'number' },
                superseded_by: str('被谁取代'),
                links: { type: 'array', items: { type: 'string' }, description: '出链' },
              },
              required: ['id', 'text', 'status'],
            },
          },
        },
        required: ['total', 'relaxed', 'results'],
      },
      execute: (args) => deps.search(args),
    }),

    tool({
      name: 'memory_write',
      description:
        '记下一条**判断**（不是事实）。写之前必须先 memory_search。' +
        '如果给出 subject/relation/object 三元组，引擎会做**确定性取代**：' +
        '同 (subject, relation) 键但 object 不同时，新判断自动取代旧判断（旧的退役但保留，可追溯）。' +
        '缺三元组则作为普通判断存入，不参与取代。' +
        '判据是结构性的，**不看文字像不像** —— 这是刻意的（相似度无法区分矛盾与复述）。' +
        '三种 kind：judgment（我会坚持的判断，可被取代）、rule（给自己的约束，受治理）、' +
        'insight（还没成形到能当判断的**想法/观察/疑问** —— 不参与取代，因为强行给它们编三元组只会造假结构）。',
      parameters: {
        text: strReq('判断本身，就是那句话。只写判断，不写事实。'),
        subject: str('可选。三元组主语，如 "svc"、"本项目"'),
        relation: str('可选。三元组关系，如 "port"、"测试框架"'),
        object: str('可选。三元组宾语（可变的那个值），如 "8080"'),
        kind: str('judgment（默认）/ rule（规矩，受治理）/ insight（想法、观察、疑问，不参与取代）'),
        tags: strArray('可选标签'),
        citations: strArray('可选。这条判断的依据出处（会话 id、文件路径等）—— 引用是记忆的一等公民'),
        reason: str('可选。若是取代旧判断，说明为什么改主意'),
      },
      schema: {
        type: 'object',
        properties: {
          action: str('created / supersede / duplicate / rejected / failed'),
          node_id: str('新判断的 id（duplicate 时是既有判断的 id）'),
          superseded_id: str('被取代的旧判断 id'),
          superseded_text: str('被取代的旧判断原文摘要'),
          note: str('人可读的结果说明'),
        },
        required: ['action', 'note'],
      },
      execute: (args) => deps.write(args),
    }),

    tool({
      name: 'memory_connect',
      description:
        '在两条判断之间建一条**双链**。两边都会看到这条关系（不留单向边）。' +
        '关系类型：complements（互补）/ tensions（矛盾）/ derives（衍生）/ depends（依据）/ restates（复述）。' +
        'supersedes 由引擎自动建立，不要手工指定。',
      parameters: {
        from: strReq('起点判断 id'),
        to: strReq('终点判断 id'),
        type: str('关系类型，默认 complements'),
        note: str('可选。说明这两条为什么是这种关系'),
      },
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, note: str('结果说明') },
        required: ['ok', 'note'],
      },
      execute: (args) => deps.connect(args),
    }),

    tool({
      name: 'memory_history',
      description:
        '看一条判断的**演化轨迹**：它改过几次、被谁取代、取代链走到哪儿。' +
        '这是"进化"的证据 —— 能看见来路，而不只是当前状态。',
      parameters: {
        id: strReq('判断 id'),
        at: { type: 'integer', description: '可选。Unix 毫秒时间戳，看"那一刻"这条判断是什么样（双时态查询）' },
      },
      schema: {
        type: 'object',
        properties: {
          found: { type: 'boolean' },
          revisions: {
            type: 'array',
            items: {
              type: 'object',
              properties: { at: { type: 'integer' }, text: str('那一版的内容'), reason: str('为什么改') },
              required: ['at', 'text'],
            },
          },
          chain: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: str(''), text: str(''), status: str('') },
              required: ['id', 'status'],
            },
          },
          note: str(''),
        },
        required: ['found'],
      },
      execute: (args) => deps.history(args),
    }),

    tool({
      name: 'memory_rule',
      description:
        '读、改、或回滚**规矩**（kind: rule）。规矩是给自己的约束，与判断分开治理：' +
        '每次变更都要说明理由，全部留痕、可审计、可回滚。' +
        'action=read 读当前规矩；action=amend 改规矩（必须给 reason）；' +
        'action=rollback 恢复到历史某一版（必须给 reason 与 to_revision）—— ' +
        '回滚本身也是一次新变更，所以**历史不会被抹掉**。',
      parameters: {
        action: strReq('read / amend / rollback'),
        id: str('规矩的 id（amend 与 rollback 时必填；read 时省略则列出全部规矩）'),
        text: str('amend 时的新规矩全文'),
        reason: str('amend 与 rollback 时必填。为什么改/为什么回滚'),
        to_revision: { type: 'integer', description: 'rollback 时恢复到第几版（从 1 开始，对应 read 里 history 的序号）' },
      },
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          rules: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: str(''),
                text: str(''),
                revision: { type: 'integer' },
                history: { type: 'array', items: { type: 'string' }, description: '变更留痕（含回滚）' },
              },
              required: ['id', 'text'],
            },
          },
          note: str(''),
        },
        required: ['ok', 'note'],
      },
      execute: (args) => deps.rule(args),
    }),

    tool({
      name: 'memory_stats',
      description: '记忆库体检：判断数、规矩数、被取代数、双链数、孤立判断、数据问题。只读，不改任何东西。',
      parameters: {},
      schema: {
        type: 'object',
        properties: {
          judgments: { type: 'integer' },
          rules: { type: 'integer' },
          retired: { type: 'integer' },
          edges: { type: 'integer' },
          orphans: { type: 'integer', description: '一条链都没有的判断数' },
          problems: { type: 'array', items: { type: 'string' }, description: '账本里的数据问题' },
          note: str(''),
        },
        required: ['judgments', 'rules', 'retired', 'edges'],
      },
      execute: () => deps.stats(),
    }),
  ]
}

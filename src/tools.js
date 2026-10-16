/**
 * Tool definitions (zero dependencies).
 *
 * ⚠️ Why this file does **not** import `defineTool` from
 * `@deepseek-ai/dsh-tools`: when a plugin is installed into a profile via
 * `link:` (a junction) it gets **no own `node_modules`** (dsh-balance-pill and
 * viya-memory both hit this; the symptom is "works right after install, gone
 * after a restart"). `ctx.tools.register()` only validates the shape of the
 * definition object, and `parameters` / `output.schema` accept **raw JSON
 * Schema** (confirmed by reading the register implementation at
 * dsh-tools/lib/index.js:2874). Hand-written JSON Schema is therefore both
 * valid and dependency-free.
 *
 * ⚠️ A real bug that tests caught, of the "silent failure" kind:
 * `register()` takes `parameters` as a **complete JSON Schema** (it runs
 * `jsonSchemaToTs(schema.parameters)` internally to render the SDK), **not** the
 * bare property table `defineTool` expects. Passing a bare property table does
 * **not** throw at register time — it is stored verbatim into ToolSchema and
 * only breaks later, in strange ways, when the SDK is rendered or the prompt is
 * assembled. So `tool()` compiles the authoring shorthand (property table plus
 * `required: true`) into `{ type: 'object', properties, required }`.
 *
 * JSON Schema subset limits (per dsh-tools' assertSupportedJsonSchema):
 *   supported: type object / array / string / number / integer / boolean / null
 *              properties / required / additionalProperties / items / enum /
 *              const / oneOf
 *   unsupported: $ref / patternProperties / type arrays
 */

/** The six relation types. The first three match the spec's complement / tension / supersession; the rest are natural extensions. */
export const LINK_TYPES = Object.freeze([
  'complements', // both judgments reinforce each other
  'tensions',    // the two conflict (but this is not a supersession)
  'supersedes',  // the new one overturns the old (created by the engine, never by hand)
  'derives',     // one is derived from the other
  'depends',     // this one depends on the other holding
  'restates',    // the same assertion
])

/**
 * Build the common shell of a tool definition and compile the shorthand
 * parameter table into JSON Schema.
 *
 * @param {object} spec - `{ name, description, parameters, schema, render, execute }`.
 *   `parameters` is a property table; each value may carry `required: true`.
 * @returns {object} a definition suitable for ctx.tools.register().
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

/** An optional string parameter. */
const str = (description) => ({ type: 'string', description })
/** A required string parameter. */
const strReq = (description) => ({ type: 'string', description, required: true })
/** An optional array-of-strings parameter. */
const strArray = (description) => ({ type: 'array', items: { type: 'string' }, description })

/**
 * The memory tool definitions. Each returns **model-readable JSON** and each obeys
 * the "deterministic, zero LLM" rule.
 *
 * @param {object} deps - the six implementations: `{ search, write, connect, rule, history, stats }`.
 * @returns {object[]} array of tool definitions.
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
      name: 'memory_persona',
      description:
        '管理正在形成的人格。用 propose 记录从互动中观察到的表达倾向或角色特征；' +
        '只有用户明确反馈后才用 accept 纳入稳定人格，reject 丢弃候选，revise 修订已确认特征。' +
        '候选与确认、拒绝、修订都有历史，防止一次指令把人格无审计地改掉。',
      parameters: {
        action: strReq('read / propose / accept / reject / revise'),
        id: str('accept、reject、revise 时的人格特征 id'),
        text: str('propose 或 revise 时的人格特征描述'),
        evidence: strArray('propose 时的观察依据或会话线索'),
        source_ids: strArray('propose 时引用的已有记忆 id，帮助人格从自己的记忆中生长'),
        confidence: { type: 'number', description: '0 到 1 的初始/修订置信度，默认 0.5' },
        reason: str('accept、reject、revise 时必填；说明反馈或改变原因'),
      },
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          action: str('read / proposed / accept / reject / revised'),
          id: str('人格特征 id'),
          status: str('active / candidate / rejected'),
          active: { type: 'array', items: { type: 'object' } },
          candidates: { type: 'array', items: { type: 'object' } },
          rejected: { type: 'array', items: { type: 'object' } },
          note: str('结果说明'),
        },
        required: ['ok', 'note'],
      },
      execute: (args) => deps.persona(args),
    }),

    tool({
      name: 'memory_reflect',
      description:
        '准备一次自我反思：读取近期的 AI 自己的记忆和当前人格特征，寻找尚未记录的稳定倾向。' +
        '这是只读入口；发现候选后，再用 memory_persona propose，并填写 source_ids。一次性的用户要求不能直接变成人格。',
      parameters: {
        limit: { type: 'integer', description: '最多提供几条近期记忆，默认 8，最大 20' },
      },
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          memories: { type: 'array', items: { type: 'object' } },
          persona: { type: 'array', items: { type: 'object' } },
          instruction: str('反思提示'),
          note: str('结果说明'),
        },
        required: ['ok', 'memories', 'persona', 'instruction'],
      },
      execute: (args) => deps.reflect(args),
    }),

    tool({
      name: 'memory_stats',
      description: '记忆库体检：判断、规矩、人格特征、被取代数、双链数、孤立判断、数据问题。只读，不改任何东西。',
      parameters: {},
      schema: {
        type: 'object',
        properties: {
          judgments: { type: 'integer' },
          rules: { type: 'integer' },
          insights: { type: 'integer' },
          persona: { type: 'integer', description: '已确认人格特征数' },
          persona_candidates: { type: 'integer', description: '待确认人格候选数' },
          persona_rejected: { type: 'integer', description: '已拒绝人格候选数' },
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

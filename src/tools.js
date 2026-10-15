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
 * The six tool definitions. Each returns **model-readable JSON** and each obeys
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
        'Search your existing judgments. **Call this before writing a new judgment**, ' +
        'to see whether something related already exists (it may already exist, or it may conflict). ' +
        'Chinese is tokenized by two-character sliding window; English by word. ' +
        'Returns the judgment text, its status and a relevance score.',
      parameters: {
        query: strReq('Search terms. Space-separated terms default to AND (all must match); when relaxed to OR the result is flagged `relaxed`.'),
        limit: { type: 'integer', description: 'Maximum number of results; defaults to 10.' },
        include_retired: { type: 'boolean', description: 'Include superseded / withdrawn judgments (default: no).' },
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
                id: str('judgment id'),
                text: str('the judgment text'),
                status: str('active / superseded / withdrawn'),
                kind: str('judgment / rule / insight'),
                score: { type: 'number' },
                superseded_by: str('which judgment superseded this one'),
                links: { type: 'array', items: { type: 'string' }, description: 'outgoing links' },
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
        'Record a **judgment** (not a fact). Call memory_search first. ' +
        'Given a subject/relation/object triple, the engine performs **deterministic supersession**: ' +
        'when the (subject, relation) key matches but the object differs, the new judgment supersedes the old one ' +
        '(the old one retires but is kept, so its provenance stays visible). ' +
        'Without a triple the text is stored as an ordinary judgment and takes no part in supersession. ' +
        'The test is structural and **does not look at textual similarity** — deliberately, since similarity ' +
        'cannot separate contradiction from restatement. ' +
        'Three kinds: judgment (a position you will hold, supersedable), rule (a constraint you set for yourself, governed), ' +
        'insight (an **idea / observation / question** not yet settled into a judgment — not superseded, because forcing ' +
        'a triple onto it would fabricate structure that is not there).',
      parameters: {
        text: strReq('The judgment itself, in one sentence. Write a judgment, not a fact.'),
        subject: str('Optional. Triple subject, e.g. "svc", "this project".'),
        relation: str('Optional. Triple relation, e.g. "port", "test framework".'),
        object: str('Optional. Triple object (the value that can change), e.g. "8080".'),
        kind: str('judgment (default) / rule (a constraint, governed) / insight (an idea, observation or question; not superseded).'),
        tags: strArray('Optional tags.'),
        citations: strArray('Optional. Where this judgment came from (session id, file path, …) — citations are first-class here.'),
        reason: str('Optional. When superseding an older judgment, say why you changed your mind.'),
      },
      schema: {
        type: 'object',
        properties: {
          action: str('created / supersede / duplicate / rejected / failed'),
          node_id: str('id of the new judgment (on duplicate, the id of the existing one)'),
          superseded_id: str('id of the judgment this one superseded'),
          superseded_text: str('summary of the superseded judgment'),
          note: str('human-readable explanation of the outcome'),
        },
        required: ['action', 'note'],
      },
      execute: (args) => deps.write(args),
    }),

    tool({
      name: 'memory_connect',
      description:
        'Create a **bidirectional link** between two judgments. Both sides see the relation (no one-way edges). ' +
        'Relation types: complements / tensions / derives / depends / restates. ' +
        'supersedes is created by the engine automatically; do not specify it by hand.',
      parameters: {
        from: strReq('id of the source judgment.'),
        to: strReq('id of the target judgment.'),
        type: str('Relation type; defaults to complements.'),
        note: str('Optional. Why these two are related this way.'),
      },
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, note: str('') },
        required: ['ok', 'note'],
      },
      execute: (args) => deps.connect(args),
    }),

    tool({
      name: 'memory_history',
      description:
        'See one judgment\'s **trajectory**: how many times it changed, what superseded it, and where the ' +
        'supersession chain leads. This is the evidence of evolution — you can see where something came from, ' +
        'not just what it is now.',
      parameters: {
        id: strReq('judgment id'),
        at: { type: 'integer', description: 'Optional. Unix epoch milliseconds; shows what this judgment looked like at that instant (bi-temporal query).' },
      },
      schema: {
        type: 'object',
        properties: {
          found: { type: 'boolean' },
          revisions: {
            type: 'array',
            items: {
              type: 'object',
              properties: { at: { type: 'integer' }, text: str('the text at that revision'), reason: str('why it changed') },
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
        'Read, amend or roll back a **rule** (kind: rule). Rules are constraints you set for yourself and are ' +
        'governed separately from judgments: every change states a reason, everything is on record, auditable and ' +
        'reversible. action=read reads current rules; action=amend changes one (a reason is required); ' +
        'action=rollback restores an earlier revision (a reason and to_revision are required) — ' +
        'a rollback is itself a new change, so **history is never erased**.',
      parameters: {
        action: strReq('read / amend / rollback'),
        id: str('Rule id (required for amend and rollback; omit on read to list every rule).'),
        text: str('On amend, the full new rule text.'),
        reason: str('Required for amend and rollback. Why the change, why the rollback.'),
        to_revision: { type: 'integer', description: 'On rollback, which revision to restore (1-based, indexing the history returned by read).' },
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
                history: { type: 'array', items: { type: 'string' }, description: 'change log (including rollbacks)' },
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
      description: 'Health check on the memory store: judgment count, rule count, superseded count, link count, orphan judgments, data problems. Read-only; changes nothing.',
      parameters: {},
      schema: {
        type: 'object',
        properties: {
          judgments: { type: 'integer' },
          rules: { type: 'integer' },
          retired: { type: 'integer' },
          edges: { type: 'integer' },
          orphans: { type: 'integer', description: 'number of judgments with no links at all' },
          problems: { type: 'array', items: { type: 'string' }, description: 'data problems found in the ledger' },
          note: str(''),
        },
        required: ['judgments', 'rules', 'retired', 'edges'],
      },
      execute: () => deps.stats(),
    }),
  ]
}

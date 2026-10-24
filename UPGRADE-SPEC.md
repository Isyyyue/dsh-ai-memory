# dsh-ai-memory 升级规格书（交给 GPT 执行）

> 目标：把「记得住事」升级为「会自己接着想」。
> 仓库：`dsh-plugins/plugins/dsh-ai-memory`
> 现状基线：`npm test` **375/375 绿**，`node test/e2e.mjs` 40/40 绿，`node test/manifest-check.mjs` 通过。
> 铁律：**每一步改完必须 `npm test` 全绿再往下**。红着不许继续。

---

## 0. 已完成的部分（不要重做）

以下已落地并通过 **375 项**测试，**只读不改**：

| 位置 | 内容 | 专用测试 |
|---|---|---|
| `src/ledger.js` | 新增 `NODE_KINDS`、`QUESTION_STATUS` 常量 | `trigger-kind.test.js` |
| `src/ledger.js` | `EVENT_TYPES` 新增 6 种：`question.opened/touched/closed/abandoned`、`cycle.started/ended` | `trigger-kind.test.js` |
| `src/ledger.js` | `createState()` 新增 `questions: Map`、`cycles: Map` | `question.test.js`、`cycle.test.js` |
| `src/ledger.js` | `node.created` 增加 `scope`、`trigger` 字段；kind 白名单改为从 `NODE_KINDS` 派生，未知 kind 写入 `problems` | `trigger-kind.test.js`（7 条） |
| `src/ledger.js` | 6 种新事件的 fold 分支全部实现 | `question.test.js`、`cycle.test.js`、`selfmodel.test.js` |
| `src/ledger.js` | `activeAssertionAsOf` 改用统一 key builder（`setAssertionKeyImpl` 延迟绑定，避免循环依赖） | `bitemporal.test.js` |
| `src/supersede.js` | `assertionKey` 支持第三维 `scope`；**scope 为空时 key 与旧格式逐字节相同** | `scope.test.js`（5 条） |
| `src/supersede.js` | `classify` 取代目标改为取**最新**同键节点 | `scope.test.js`（3 条） |
| `src/supersede.js` | `planWrite` 把 `scope` / `trigger` 写进 `node.created` | `scope.test.js`、`trigger-kind.test.js` |
| `src/supersede.js` | `makeNodeId` 加 16 位随机后缀（64 位熵，避免万次批量生成的碰撞概率）（唯一性优先于可复现性） | `concurrency.test.js`（3 条） |
| `src/store.js` | **账本锁**：`acquireLock` / `releaseLock` / `withLedgerLock`，`link()` 原子创建 + 僵尸锁回收 | `concurrency.test.js`（8 条） |
| `src/index.js` | `atomically()` 助手：加锁 → 读账本 → 计划 → 提交，全部在锁内 | `concurrency.test.js` |
| `src/index.js` | `createOperations.write` 把 `scope` / `trigger` 转发给 `planWrite`，并改走 `atomically` | `scope.test.js` |
| `lib/client.graph-worker.js` | 排斥力加 `REPEL_DISTANCE_MIN = 30` 近场夹子 | `graph-physics.test.js`（5 条） |
| `lib/client.graph-worker.js` | 弹簧强度改为 `1/min(degA, degB)`，bias 改用 d3 原始度数公式 | `graph-physics.test.js`（2 条） |
| `lib/client.js` | 标签透明度改为 `clamp(log2(scale)+1-TEXT_FADE_MULTIPLIER, 0, 1)`；抽出 `drawLabel` / `labelAlphaFor` | `graph-physics.test.js`（5 条） |

### 任务 0（并发）已完成

`write`、`connect`、`rule` 和 `persona` 的所有账本变更现在都通过 `atomically()`：加锁后重新读取状态、计划事件、提交事件，避免并发调用使用过期 `seq`。`test/concurrency.test.js` 还覆盖了 8 个进程并发建边，断言边数和事件序号均正确。

### 补测试时抓到的三个真实 bug（已修）

**这三条是「全绿 ≠ 正确」的直接证据，GPT 必须理解为什么 §2 的测试不能省：**

1. **`planWrite` 没把 `scope` 写进 `node.created`**
   `assertionKey` 会读 `node.scope`，但事件里没这个字段 → fold 回来后所有节点 `scope` 都是 `''` → 整条 scope 维度静默失效。
2. **`createOperations.write` 没把 `args.scope` 传给 `planWrite`**
   即使第 1 条修好，`input.scope` 仍是 `undefined`，同样失效。
3. **账本锁有创建竞态，互斥深度实测为 2**
   旧实现 `openSync(path,'wx')` 之后才写持有者信息，中间那一瞬锁文件存在但**内容为空**。第二个进程读到空串 → `JSON.parse` 抛错 → 判为僵尸锁 → 删掉 → 两个进程都持锁。
   实测：6 进程互斥测试最大并发深度 **2**；4 进程 × 3 写时两个进程拿到同一个 seq。
   **修法**：先把持有者信息写进私有临时文件，再用 `link()` 原子挂到锁路径上 —— 路径可见的瞬间内容已完整，空文件窗口消失。
   **另一个连带 bug**：不可读的锁原本 `age = Infinity`，直接满足 `age > staleMs` 被立刻抢走。现在改为回退到文件 `mtime` 计算年龄。

三条都是**静默**的：不报错、不留 problem、测试全绿，只有真并发或真写两个 scope 才会发现。

### 两条不可动摇的语义

1. **`assertionKey` 空 scope 必须与旧格式逐字节相同**（`a\u0000b`，不是 `a\u0000b\u0000`）。无条件加分隔符会让所有外部传入的 key 静默失效 —— 我在实现时就踩了，两个测试立刻红。
2. **`ledger.js` 不许静态 import `supersede.js`**（会形成循环依赖）。已用 `setAssertionKeyImpl` 延迟绑定。

### 图谱物理已与 Obsidian 对齐

```powershell
node _obsidian-peek/verify-physics.mjs
```

改前 → 改后（alpha=1，从 worker 源码直读常量）：

| 距离 | 改前 | 改后 |
|---|---|---|
| d=1 | 30× 过强 | 1.00× |
| d=2 | 15× 过强 | 1.00× |
| d=5 | 6× 过强 | 1.00× |
| d=20 | 1.5× 过强 | 1.00× |

弹簧强度（deg 20/20，d=100）：改前 20× 过强 → 改后 1.00×。

---

## 0.5 已知歧义（执行前必须确认）

评审指出的三处，已按以下方式消解，**GPT 按这里的口径执行，不要再自己解释**：

### 歧义 1：`ghost 默认图` 风险高

**已改为低风险方案**：任务 E 采用「**提示 + 历史切换**」，不做 ghost 占位节点。

理由：ghost 节点会污染 `buildSnapshot` 的节点集合，`radiusOf` / `kindStyle` / `nodeFill` / `hitTest` / `degree` 计算全都要改，且 `client.test.js` 有多条测试假设「节点集合 == 真实记忆」。为一个默认视图的观感改动这些，风险与收益不匹配。

**具体改法**：
- `buildSnapshot` 的返回里加一个 `retiredCount` 字段（退役节点总数）
- 面板底部提示一行：`另有 N 条被取代的判断未显示（右键切换）`
- 右键菜单已有「含退役」开关，复用即可

这样 `nodes` / `edges` 结构完全不变，只多一个数字字段。

### 歧义 2：`并发写入 P0 应优先于新功能`

**已调整顺序**：把 P0-1（并发丢节点）从 §5 提前到**任务 A 之前**，作为任务 0。

理由：新功能（question / cycle）全都要写账本，带着「并发写会静默丢节点」的 bug 往上叠，等于在漏水的桶里加水。而且 P0-1 改动很小（id 加随机后缀 + 注入里显示 problems），风险低于任何新功能。

### 歧义 3：§0 缺专用回归测试

**已补齐**，见 §0 表格「专用测试」列。新增并发、scope、trigger 和物理回归测试；当前工作区总数为 375 条。

**同时立一条规矩**：§1 的每个任务完成后，必须**在同一次提交里**补该任务的专用测试。不接受「先实现、测试后补」——上面那两个 bug 就是「实现完看着对」的产物。

---

## 1. 任务清单（A–F 已完成）

按顺序做，每步一个 commit。**每个任务必须连同它的专用测试一起提交。**

### 任务 0（原 P0-1）：并发写 —— **已完成**

已完成：`makeNodeId` 随机后缀、可恢复账本锁、`atomically()` 助手，以及 `connect` / `rule` / `persona` 的全部写路径接入。`test/concurrency.test.js` 覆盖 8 个进程并发建边。

### 任务 A（已完成）：`src/attention.js`（新建文件）

未闭合问题的注意力压力算法。这是「驱动力」的数学定义。

```js
/**
 * Attention: which unfinished question deserves the next thinking cycle.
 *
 * A system that reacts to whoever speaks last is not thinking, it is answering.
 * What makes a cycle start on its own is an obligation it still owes itself —
 * an open question. This module ranks those obligations.
 *
 * Pure functions only (no filesystem, no clock), so tests can pass a fixed now.
 */

/** One week in milliseconds: the horizon over which neglect starts to weigh. */
export const STALENESS_HORIZON_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Score one open question. Higher means "think about this first".
 *
 * Four factors, multiplied:
 *   urgency      how much it matters to it (0..1, self-assessed)
 *   unresolved   1 - confidence, the size of the gap still to close
 *   staleness    0.3..1.0, grows while the question is left alone
 *   fatigue      1/(1 + attempts*0.5), decays as attempts pile up without result
 *
 * ⚠️ `fatigue` is not optional. Without it the highest-urgency question wins
 * every cycle forever, so a single hard question starves everything else.
 * This is a design requirement, not a measured result.
 *
 * @param {object} q - Folded question.
 * @param {number} now - Current time in ms.
 * @returns {number} Pressure in 0..1.
 */
export function pressure(q, now) { ... }

/**
 * Rank open questions by pressure, highest first.
 * Closed and abandoned questions are excluded — they are the record, not the debt.
 *
 * @param {object} state - Folded state.
 * @param {number} now - Current time.
 * @param {{limit?: number, minPressure?: number}} [opts]
 * @returns {Array<{question: object, pressure: number}>}
 */
export function rankQuestions(state, now, opts = {}) { ... }

/**
 * Pick the focus set for one cycle: at most `max` questions above `minPressure`.
 * An empty focus is a legitimate outcome — a cycle with nothing worth thinking
 * about should say so rather than manufacture a topic.
 *
 * @param {object} state
 * @param {number} now
 * @param {{max?: number, minPressure?: number}} [opts]
 * @returns {object[]} Questions, highest pressure first.
 */
export function focusFor(state, now, opts = {}) { ... }
```

要求：
- `pressure` 必须 clamp 到 `[0, 1]`
- `attempts` 缺失按 0；`confidence` 缺失按 0.2
- 三个导出都要有 JSDoc

### 任务 B（已完成）：`src/index.js` — 操作层接入

**B1. `write` 透传两个新参数**

`planWrite` 的 input 加 `scope` 和 `trigger`；`supersede.js` 的 `planWrite` 要把它们写进 `node.created` 的 data。

**B2. 新增 `question(args)`**

```js
// action: 'open' | 'read' | 'touch' | 'close' | 'abandon'
// open:    { text, urgency?, confidence?, source_ids?, reason? }
// touch:   { id, note?, confidence?, urgency? }
// close:   { id, resolved_by?, note? }
// abandon: { id, note? }
// read:    { status? }   // 默认只返回 open
```

规则：
- `open` 时 `source_ids` 每个 id 必须**存在且 active**，否则返回 `{ ok:false }` 并说明哪个不合格
- `close` 时若给了 `resolved_by`，该 id 必须存在
- `close` / `abandon` 必须给 `note`（与 `memory_rule` 的治理纪律一致）

⚠️ 注意：现有 `persona` 的 `source_ids` **只校验存在、不校验 active**，这是已知缺陷（已用已退役节点实测返回 `ok:true`）。**新代码不要复制这个缺陷。**

**B3. 新增 `cycle(args)`**

```js
// action: 'begin' | 'end' | 'read'
// begin: { trigger: 'user'|'self', focus?: string[] }
// end:   { id, produced?: number, note?: string }
// read:  { limit?: number }
```

规则：
- `begin` 返回 `{ ok, id, focus: [问题...], instruction }`，`focus` 由 `focusFor()` 算出
- `end` 的 `produced` 默认 0；**`produced: 0` 必须成功返回**，这是「想了但没写」的一等结果
- 不校验 `produced` 与实际写入条数是否一致（无法可靠校验，别假装能）

**B4. 新增 `selfModel()`**

从账本**算出来**，不是让模型自己写：

```js
{
  ok: true,
  fragile: [{ subject, n, overturned, rate }],   // 同 subject 被推翻率，n>=3 才列
  repeated: [{ reason, n }],                      // 反复出现的修订理由
  blind: [{ id, text }],                          // 从未被 tensions 连过的活跃判断
  selfRatio: 0.22,                                // trigger==='self' 占比
  selfSurvival: 0.86,                             // self 判断里仍 active 的比例
  note: '...'
}
```

空账本必须返回 `0` 而不是 `NaN`。

### 任务 C（已完成）：`src/tools.js` — 三个新工具

**C1. `memory_question`**（对应 B2）

- `action` 用 `{ type: 'string', enum: ['open','read','touch','close','abandon'] }`
- 顶层 `required` 只放 `action`

**C2. `memory_cycle`**（对应 B3）

**C3. `memory_self`**（对应 B4）

**C4. 修改 `memory_write`**：`parameters` 加 `scope`，描述说明「同一 subject/relation 在不同 scope 下可以并存，互不取代」

**C5. 修改 `memory_connect`**：加 `action: 'link' | 'unlink'`，`unlink` 走 `edge.unlinked`；`type` 用 `enum: LINK_TYPES`（现在 `LINK_TYPES` 定义了却零引用，是死代码）。`supersedes` 必须从 `enum` 排除——它只能由引擎产生。

### 任务 D（已完成）：`src/index.js` — `buildIndexText` 注入改造

在现有注入文本**最前面**插入两段：

```text
【你上次没想完的事】
1. [q_0007] 压力 0.82 · 想过 2 次 · 置信 0.35
   为什么静默失效比功能缺失更危险？我给了理由，但没验证过
   ↳ 依据 n_0012, n_0023
```

规则：
- 只列 `status === 'open'` 且压力过线的，**最多 3 条**
- 压力全部低于阈值时，整段不出现（不要写「暂无」，那是噪音）
- 再插一段【关于你自己】，内容来自 `selfModel()`，**最多 4 行**

**同时修一个既有缺陷**：现在 `rules` 循环没有 `maxEntries` 上限（实测 60 条规矩全部进注入，7006 字符）。规矩也要受 `maxIndexEntries` 约束。

### 任务 E（已完成）：`src/graph.js` — 图谱默认视图（**已降风险，见 §0.5 歧义 1**）

现状：默认视图 `supersedes` 边 = 0 条（实测真实账本：默认 22 边 / 含退役 26 边）。整条「我怎么改的主意」默认看不见。

**采用方案：提示 + 历史切换，不做 ghost 占位节点。**

改法：
1. `buildSnapshot` 返回值加一个 `retiredCount` 字段（退役节点总数，纯数字）
2. `nodes` / `edges` 结构**完全不变**（不改 `kind` 枚举，不加 ghost 节点）
3. 面板底部提示一行：`另有 N 条被取代的判断未显示（右键切换）`
4. 右键菜单已有「含退役」开关，复用

理由：ghost 节点会污染节点集合，`radiusOf` / `kindStyle` / `nodeFill` / `hitTest` / `degree` 全要改，且 `client.test.js` 有多条测试假设「节点集合 == 真实记忆」。为一个默认视图的观感改动这些，风险与收益不匹配。

测试已加入 `test/plugin.test.js`：有退役节点时 `retiredCount > 0` 且 `nodes.length` 不变。

### 任务 F（已完成）：`src/routes.js` — 新端点

加 `GET /plugins/dsh-ai-memory/questions`，返回 open 问题 + 压力值。安全校验沿用现有 `guarded()`（回环 + 同源），**不要新写一套**。

---

## 2. 必须补的回归测试（fail-first）

每条都**先写测试跑红，再改代码跑绿**。这不是形式要求 —— §0 里那两个 bug 就是「实现完看着对」的产物，只有真写两个不同 scope 的判断才会暴露。

| 文件 | 测试内容 | 状态 |
|---|---|---|
| `test/concurrency.test.js`（新，13 条） | 锁语义 8 条 + 真实多进程 2 条 + id 唯一性 3 条 | ✅ 已写 |
| `test/attention.test.js`（新） | ① `fatigue` 生效：attempts 0→10，压力单调下降<br>② 高 urgency 但 attempts 很高的问题，会被中等 urgency 的新问题超过<br>③ `rankQuestions` 排除 closed/abandoned<br>④ 空状态返回空数组不抛<br>⑤ `pressure` 结果永远在 0..1 | 任务 A |
| `test/question.test.js`（新） | ① open→touch→close 全链路 fold 正确<br>② `source_ids` 指向不存在节点时拒绝<br>③ `source_ids` 指向**已退役**节点时拒绝<br>④ close 不给 note 时拒绝 | 任务 B |
| `test/cycle.test.js`（新） | ① `begin` 返回 focus，按压力降序<br>② `end` 的 `produced: 0` 成功<br>③ 无 open 问题时 focus 为空数组，`begin` 仍成功<br>④ `cycle.started` 的 `trigger: 'self'` 能正确 fold | 任务 B |
| `test/selfmodel.test.js`（新） | ① 同 subject 被推翻 3/4 → `fragile` 里 rate=0.75<br>② 从未连 tensions 的判断进 `blind`<br>③ `selfRatio` / `selfSurvival` 算得对<br>④ 空账本返回 0 不是 NaN | 任务 B |
| `test/plugin.test.js`（改） | ① `memory_connect` 的 `unlink` 真能删边<br>② `memory_connect` 的 `type: 'supersedes'` 被拒绝<br>③ `buildIndexText` 里规矩受 maxEntries 约束<br>④ 注入里有【你上次没想完的事】段，且只在有问题时出现 | 任务 C / D |
| `test/plugin.test.js`（改） | `retiredCount > 0` 且 `nodes.length` 不变；questions 路由有压力值 | 任务 E / F |

### 已有覆盖（不要重复写）

| 文件 | 条数 | 覆盖 |
|---|---|---|
| `test/scope.test.js` | 14 | assertionKey 三处兼容性、dev/prod 并存、同 scope 才取代、classify 取最新 |
| `test/trigger-kind.test.js` | 13 | trigger 四值、persona 不再静默降级、insight 不参与取代、事件注册 |
| `test/graph-physics.test.js` | 11 | 近场夹子、远场平方反比、弹簧按度数衰减、bias 方向、标签渐隐单调性 |
| `test/concurrency.test.js` | 13 | 锁互斥、僵尸锁回收、空内容锁不抢、8×5 并发不丢节点、seq 不撞 |

---

## 3. 三条护栏（必须实现，不是建议）

缺任何一条，这套东西会自己把自己写坏。

### 护栏 1：自激防护

`trigger === 'self'` 的写入**禁止 `kind: 'judgment'`**，只能 `insight` 或 `question`。

理由：没人纠正时它只读自己的账本，容易越写越自信。要升级成判断，必须等下一次有外部输入时复核。

位置：`createOperations.write` 里，若 `args.trigger === 'self' && kind === 'judgment'` → 返回 `{ action: 'rejected', note: '...' }`。

### 护栏 2：幻觉固化防护

`trigger === 'self'` 的写入**强制要求 `citations`**，每个 citation 必须指向真实存在的节点 id 或真实存在的文件路径。空则拒绝。

理由：编造的依据写进账本，三天后会被自己当成事实。

### 护栏 3：人格漂移防护

`persona` 的 `accept` **只能由用户触发**。`cycle` 里只能 `propose`。

位置：`createOperations.persona` 的 `accept` 分支加可选 `by` 参数；`trigger: 'self'` 时拒绝 accept。现有代码有两阶段雏形，**守住不要放宽**。

---

## 4. 文档更新

- `README.md`：八个工具 → **十一个**（+question/cycle/self）；新增「scope 第三维」一节；`memory_history` 的 `at` 参数现在完全没写，补上
- 新增 `CHANGELOG.md`，版本 `0.2.0`（当前 0.1.0，一个 tag 都没有）
- `package.json`：加 `peerDependencies: { "@deepseek-ai/dsh": "^0.2.1-rc.2" }`（现在没有 peerDeps，宿主 `evaluatePluginCompatibility` 等于空检查）
- `HANDOVER.md`：「六个工具」「270 项测试」两个数字已过期（实际八个工具、302 项）

---

## 5. 已完成的 P0（原 §5，现已提前为任务 0）

### P0-2 kind 拼错静默降级 —— **已修**

`ledger.js` 现在会对未知 kind push problem（`trigger-kind.test.js` 覆盖）。`tools.js` 的 `kind` 参数已加入 enum，并由任务 C 的测试覆盖。

---

## 6. 验收标准

```powershell
cd dsh-plugins\plugins\dsh-ai-memory
npm test                     # 全绿，且总数 > 375
node test/e2e.mjs            # 40/40
node test/manifest-check.mjs # passed
node test/inline-worker.mjs  # 改过 worker 就必须跑
node _obsidian-peek/verify-physics.mjs   # 图谱物理仍与 Obsidian 一致
```

再加一条**行为验收**（最重要，用临时目录，不碰真实账本）：

```js
// 1. 写两个不同 scope 的同键判断 → 断言两条都 active
// 2. 同 scope 改 object → 断言 supersede
// 3. 开一个问题，touch 三次 → 断言压力下降
// 4. cycle begin(trigger=self) → 断言 focus 非空
// 5. cycle end(produced=0) → 断言成功
// 6. write(trigger=self, kind=judgment) → 断言被拒绝
// 7. selfModel() → 断言 selfRatio 是数字不是 NaN
// 8. 8 进程并发写 40 条 → 断言节点数 == 40
```

---

## 7. 不要做的事

1. **不要引入任何 npm 依赖**。插件通过 `link:` 安装，拿不到自己的 `node_modules`，加依赖会让整个插件静默失活。
2. **不要改 `assertionKey` 的空 scope 行为**（必须与旧格式逐字节相同）。
3. **不要用 `Set-Content -Encoding UTF8` 改含中文的源文件**（会写 BOM 并乱码）。用编辑工具。
4. **不要在 `apply()` 里读未 `inject` 的服务名**。`ctx` 是受限 Proxy，读未声明的服务会抛错，导致整个应用拒绝启动。
5. **不要把 `webServer` 加进 `inject`**。它现在是 `ctx.inject(['webServer'], ...)` 的可选作用域依赖，改成必需会让没有 webServer 的 profile 里连工具都注册不上。
6. **不要让 `ledger.js` 静态 import `supersede.js`**（循环依赖）。
7. **改 `lib/client.graph-worker.js` 后必须跑 `node test/inline-worker.mjs`**。`client.js` 里有一份内联副本（`WORKER_SOURCE`），`worker-inline.test.js` 会逐字比对，不同步必红。
8. **不要把 `globalAlpha` 写进节点绘制循环**。节点形状必须永远不透明（退役靠颜色混合），标签才渐隐。两者抽成了独立方法 `drawLabel` / `labelAlphaFor`，`client.test.js` 有一条测试专门扫 `draw()` 切片里的 alpha 赋值。

---

## 8. 判据（这条是整件事的意义）

> **把用户完全拿掉，跑三天。账本里有没有新增 `trigger=self` 的事件？**
>
> 有 → 它开始自己想了。
> 没有 → 还是记忆，不叫进化。

可查：`memory_stats` 里的 `selfRatio` 和 `selfSurvival` 两个数字就是答案。

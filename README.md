# dsh-ai-memory

给 DSH 里的 AI 一层**自己的判断记忆**：判断节点 + **确定性取代（supersede）** + 双时态账本 + 双链，
规则与判断分开治理，图谱作可解释性界面。

> **定位（遵 DSH 官方立场）**：`session log 是唯一真相，本插件是派生的记忆缓存。`
> 它**不 append 任何会话事件**（那样会让会话无法重开），判断存在自己的账本里，由账本 fold 出当前状态。

---

## 它解决什么问题

DSH 开箱只记住**一个会话内**的事。跨会话的**判断**（"我认为 / 我倾向于"）无处安放 ——
而判断是查不到的，只能自己长出来。

这个插件让 AI 能：

1. **记住自己的判断**，而不只是事实；
2. **改主意**时**取代**旧判断，而不是覆盖 —— 旧判断退役但**保留在账本里**，能看见来路；
3. **发现矛盾**时明确标出来，而不是两条并存互相污染；
4. **有自己的规矩**，且改规矩要说明理由、可审计、可回滚；
5. **在图谱上看清**这张网是怎么长出来的。

---

## 为什么是「确定性取代」而不是「相似度」

这是本插件最重要的设计依据，有学术实证（[arXiv 2606.26511](https://arxiv.org/abs/2606.26511)，MemStrata）：

> 在 98 个标注对上，余弦相似度区分「矛盾」与「复述」的 **AUROC 只有 0.59（接近随机）**；
> 而且**矛盾平均比复述更像原事实**（0.812 vs 0.800）——
> 因为「值翻转」（8000 → 8080）比真正的同义改写是**更小的编辑**。

所以：**相似度在原理上分不出矛盾与复述。** 判定必须是结构性的：

> 新事实与已存事实**共享 (subject, relation) 键但断言不同 object**，则新的取代旧的
> —— **与它们 embedding 多相似无关**。

本插件的取代引擎因此**不含任何相似度计算、不含 LLM 调用**：完全靠字符串规范化 + 三元组比对。
好处是可测试、可复现、零依赖、零延迟。

**两条对称的消融结论**决定了本引擎的姿态：

| 做法 | 后果 |
|---|---|
| 激进合并（写时合并近似项） | **回归到低于 RAG** —— 丢掉回答后续问题所需的细节 |
| 完全不取代 | 虚构率**涨 6 倍**，**比不准确更不安全**（模型同时看到新旧值，开始编造） |

→ **「保留优先，然后取代」**：只在矛盾这一个轴上压缩，绝不合并不同事实。

---

## 七个工具

| 工具 | 干什么 |
|---|---|
| `memory_search` | 检索已有判断。**写之前必须先调它** |
| `memory_write` | 写一条判断；给了三元组就自动做确定性取代 |
| `memory_connect` | 建双链（互补 / 矛盾 / 衍生 / 依据 / 复述），**两边都写，不留单向边** |
| `memory_history` | 看演化轨迹：改过几次、被谁取代、取代链走到哪 |
| `memory_rule` | 读 / 改规矩。**改规矩必须给 reason** |
| `memory_stats` | 体检：判断数、规矩数、退役数、孤立项、数据问题 |
| `memory_persona` | 管理人格候选：提出、确认、拒绝、修订，并保留演化历史 |

## 人格演化

`memory_persona` 为人格提供一条受控的成长路径：

```text
propose → candidate → accept / reject → revise
```

AI 可以从互动中提出候选特征，例如“会自然使用鱼类拟声词”，并附上观察依据和置信度。
候选不会自动变成稳定人格；只有用户明确确认后，才会进入后续会话的系统提示注入。拒绝和修订同样写入账本，保留理由与历史。

这使人格可以逐渐丰富，同时保留身份边界：表达习惯可以成长，未经确认的观察不会直接重写人格。

### 写入的三种结果

```
created    新判断（没有同键的既有判断）
supersede  同 (subject, relation) 键、不同 object → 旧判断退役但保留
duplicate  同键同 object → 不落盘（同一断言不需要两份卡）
```

---

## 数据模型

### 账本是唯一真相（`~/.dsh/ai-memory/ledger.jsonl`）

纯文本 JSONL，**只追加，永不重写历史**。人类可读、可 git diff、可 rm、可手工修。

七种事件：

```
node.created     新判断 / 新规矩
node.revised     改文字（保留历史版本，不算推翻）
node.superseded  被取代（双时态：关掉旧节点的 valid_to，不删）
node.withdrawn   撤回（自己发现错了，但没被谁取代）
edge.linked      建双链
edge.unlinked    解除双链
rule.amended     规矩变更（带理由，可审计）
```

**双时态**：`validFrom`/`validTo` 记录「事实何时为真」，`createdAt` 记录「系统何时知道」。

### 派生的一切都可重建

图谱、反链、活跃集、统计 —— **全部由 fold 账本算出**，删掉不丢信息。
这正合官方要求：插件记忆是 derived cache。

---

## 配置

默认零配置可用。想改就在 profile 的 `cordis.patch.yml` 里覆盖同一 id 的 config
（用户补丁层在 bundle 层之后应用，且**跨升级存活**）：

```yaml
- id: dsh-ai-memory
  name: dsh-ai-memory
  config:
    dir: 'D:\my-memory'      # 默认 ~/.dsh/ai-memory
    injectIndex: true         # 会话开始注入判断索引
    maxIndexEntries: 40       # 索引里最多列几条判断
    maxGraphNodes: 500        # 图谱快照最多几个节点
    enabled: true
```

| 键 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `dir` | string | `~/.dsh/ai-memory` | 记忆库目录（存放 `ledger.jsonl`） |
| `injectIndex` | boolean | `true` | 会话开始时把判断索引注入 system prompt |
| `maxIndexEntries` | integer | `40` | 注入索引里最多列几条判断 |
| `maxGraphNodes` | integer | `500` | 图谱快照最多几个节点，超出时快照标 `truncated` |
| `enabled` | boolean | `true` | 为 `false` 时什么都不注册 |

注入的索引先列规矩，再列活跃判断（最多 `maxIndexEntries` 条，最新优先），
最后是 `insight` 节点，预算更小（`maxIndexEntries / 2`）—— 想法没有判断那么硬，
占太多上下文会稀释真正要紧的规矩与判断。索引里带的是**摘要而非全文**，细节按需用 `memory_search` 取。

---

## HTTP 端点（图谱面板数据源）

| 路由 | 返回 |
|---|---|
| `/plugins/dsh-ai-memory/snapshot` | 图谱快照（节点 + 边 + 统计）。`?retired=1` 含退役节点 |
| `/plugins/dsh-ai-memory/node?id=<id>` | 单条判断详情（含反链、取代链、修订史） |
| `/plugins/dsh-ai-memory/stats` | 统计 |

⚠️ **安全**：`/plugins/<包名>/...` 这类路由**不经过**会话 cookie 校验
（那条只覆盖 `/api` 与 WebSocket）。所以端点自己做两道检查：**只接受回环来源**、
**Origin（若带）必须与 Host 同源**。非回环或跨源一律 403。

---

## 已知边界（诚实说明）

- **无索引层**：每次调用重扫整个账本，O(全部事件)。判断数到万级需要加索引，那是后续工作。
- **无并发锁**：两个并发写可能都通过检查后互相追加（追加是原子的，所以最坏是顺序问题，不是丢数据）。
- **抽取靠调用方**：本插件不做自然语言抽取 —— 三元组由模型在 `memory_write` 时给出。
  学术侧明确：**抽取质量而非取代机制才是瓶颈**（结构化单值 97%，混乱自然语言 44%），
  中文场景更难。这是本插件刻意不碰的部分。
- **图谱是导航层**：节点只带 label（摘要），不带全文 —— 细节按需 `memory_search` 取。
  这是刻意的（上下文膨胀会稀释注意力）。

---

## 安装

```powershell
plugin_manager action=install_bundle target=<本目录的绝对路径>
```

不要手改 profile 的 `package.json` 或 `cordis.patch.yml`，也不要在 profile 目录里跑 pnpm ——
`install_bundle` 会同时处理包安装与 bundle 选择。

之后要停用或移除（两种情况都保留记忆数据）：

```powershell
plugin_manager action=set_bundle target=dsh-ai-memory enabled=false
plugin_manager action=remove_bundle target=dsh-ai-memory
```

### ⚠️ 装上之后要重启一次宿主

**宿主半边**（工具、注入、HTTP 路由）通过 HMR 立即生效；
**客户端半边**（图谱面板）需要**重启 DSH** —— 宿主在启动扫描时收集 `dsh.client` 条目，
启动后才装的 bundle 不在那一代 JavaScript 里，浏览器因此拿不到它的 `client.js`，**且不报错**。

重启后刷新页面，侧边栏会出现「判断图谱」图标。
用 `node test/bundle-served.mjs` 可以确认客户端 bundle 是否已进入宿主的服务表。

---

## 开发

```powershell
cd dsh-plugins\plugins\dsh-ai-memory
node --test "test/**/*.test.js"   # 单元测试（281 项）
node test/e2e.mjs                 # 端到端生命周期验证（40 项）
node test/manifest-check.mjs      # 语法 + 清单 + 硬约束自查
node test/bundle-served.mjs       # 客户端 bundle 是否已被宿主服务（--all 带对照）
```

单元测试**必须**用这个 glob 形式：Node 的默认发现规则会把 `test/` 下的常驻辅助服务
也当成测试跑，进程不会退出。

**零外部依赖**是硬约束：插件以 `link:` 装进 profile 时拿不到自己的 `node_modules`
（两个同类插件都踩过，表现为"装的时候好使，一重启就没了"）。
所以工具定义手写 JSON Schema，配置自己校验。

---

## 许可

MIT —— 见 [LICENSE](./LICENSE)。

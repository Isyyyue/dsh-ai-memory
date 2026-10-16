# dsh-ai-memory

给 DeepSeek Harness（DSH）里的 AI 一套可以持续积累、修正和解释的长期记忆。

这个插件记录的不是完整聊天记录，而是 AI 在互动中形成的判断、规则、想法和人格特征。它把这些内容保存为一个可追溯的 JSONL 账本，再从账本中计算当前状态、演化历史和关系图谱。

插件的目标是让 AI 保持连续性：它可以记住自己曾经相信什么，知道后来为什么改变，也可以在保持核心身份的同时逐渐丰富自己的表达方式。

> DSH 的会话日志仍然是会话事实的唯一来源。本插件是派生的长期记忆缓存，不会向会话日志追加事件。

## 它解决什么问题

DSH 默认主要记住当前会话里的内容。跨会话之后，AI 很难继续使用自己以前形成的判断，也无法区分“我现在这样想”和“我以前曾经这样想过”。

这个插件提供四类长期信息：

- **判断**：AI 对项目、问题或世界形成的观点；
- **规则**：AI 给自己设定的约束，例如写判断前必须先检索；
- **想法**：还没有成熟到可以当作判断的观察、疑问和灵感；
- **人格特征**：从互动中逐渐形成的表达习惯和角色倾向。

这些信息都会保留来源和变化历史，而不是只留下最后一个结果。

## 人格如何成长

人格演化采用“候选—反馈—确认”的流程：

```text
观察到一种倾向
        ↓
提出人格候选（candidate）
        ↓
用户确认 / 拒绝
        ↓
成为稳定特征，或被记录为已拒绝
        ↓
随着新反馈继续修订
```

例如，AI 可以先提出：

> “我似乎可以自然地使用‘噗’、‘咕噜’等鱼类拟声词。”

在用户确认之前，这只是候选，不会直接改变稳定人格。确认之后，它才会被注入后续会话；如果以后发现表达太机械，也可以带着理由修订。这样可以让 AI 仍然是“大肥鱼”，但逐渐形成更丰富、更自然的词汇和语气，而不是永远机械地重复一个口头禅。

所有提出、确认、拒绝和修订都会写入账本，因此可以回答：

- 这个人格特征是什么时候出现的？
- 它是根据什么观察形成的？
- 为什么被确认或拒绝？
- 它后来是怎样变化的？

## 七个工具

| 工具 | 用途 |
| --- | --- |
| `memory_search` | 检索已有判断。写新判断前应先调用它。 |
| `memory_write` | 写入判断，并在三元组冲突时确定性取代旧判断。 |
| `memory_connect` | 在两条记忆之间建立双向关系。 |
| `memory_history` | 查看判断的修订和取代历史。 |
| `memory_rule` | 读取、修改或回滚 AI 给自己的规则。 |
| `memory_persona` | 提出、确认、拒绝和修订人格特征。 |
| `memory_stats` | 检查记忆数量、孤立项和账本问题。 |

## 确定性取代

当新判断和旧判断共享同一个 `(subject, relation)`，但 `object` 不同时，插件会把它们视为同一问题的新答案：

```text
(服务, 端口, 8000)
        ↓ 被新判断取代
(服务, 端口, 8080)
```

旧判断会被标记为 `superseded`，但不会删除。新判断、取代事件和关系边都会保留在账本中，因此既能回答“现在是什么”，也能回答“以前是什么、为什么变了”。

插件不使用向量相似度或 LLM 来决定取代关系。相似度可以帮助检索，却不能可靠地区分复述和矛盾；取代关系必须建立在明确的结构化键上。

## 数据模型

账本默认位于：

```text
~/.dsh/ai-memory/ledger.jsonl
```

它是只追加的 JSONL 文件，包含以下事件：

- `node.created`：建立判断、规则或想法；
- `node.revised`：修订文字；
- `node.superseded`：判断被新判断取代；
- `node.withdrawn`：主动撤回判断；
- `edge.linked` / `edge.unlinked`：建立或解除关系；
- `rule.amended`：修改规则；
- `persona.proposed`：提出人格候选；
- `persona.accepted` / `persona.rejected`：确认或拒绝候选；
- `persona.revised`：修订已确认的人格特征。

当前状态、检索结果、关系图谱和统计信息都由账本重新折叠得到。删除派生数据不会丢失历史。

## 安装

在 DSH 环境中执行：

```powershell
plugin_manager action=install_bundle target=<本目录的绝对路径>
```

不要手动修改 profile 中的 `package.json` 或 `cordis.patch.yml`。安装完成后重启一次 DSH，让客户端图谱面板完成启动扫描；然后刷新页面，侧边栏会出现“判断图谱”。

停用或移除插件：

```powershell
plugin_manager action=set_bundle target=dsh-ai-memory enabled=false
plugin_manager action=remove_bundle target=dsh-ai-memory
```

这两个操作都不会删除记忆账本。

## 配置

默认情况下无需配置。需要自定义时，可以在 profile 的 `cordis.patch.yml` 中覆盖插件配置：

```yaml
- id: dsh-ai-memory
  name: dsh-ai-memory
  config:
    dir: 'D:\my-memory'
    injectIndex: true
    maxIndexEntries: 40
    maxGraphNodes: 500
    enabled: true
```

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `dir` | `~/.dsh/ai-memory` | 账本目录 |
| `injectIndex` | `true` | 是否在会话开始注入记忆索引 |
| `maxIndexEntries` | `40` | 注入的判断数量上限 |
| `maxGraphNodes` | `500` | 图谱快照节点上限 |
| `enabled` | `true` | 是否注册插件 |

注入内容是摘要，不是整本账本。已确认的人格会单独列出；待确认的人格候选会明确标记为候选，不会被伪装成稳定身份。

## HTTP 端点

图谱面板使用以下回环端点：

| 路由 | 返回内容 |
| --- | --- |
| `/plugins/dsh-ai-memory/snapshot` | 图谱节点、边和统计 |
| `/plugins/dsh-ai-memory/node?id=<id>` | 单条记忆详情和演化链 |
| `/plugins/dsh-ai-memory/stats` | 记忆库统计和数据问题 |

这些端点只接受回环请求，并检查跨源请求的 `Origin`，不会直接暴露给网络中的其他主机。

## 开发与验证

项目要求 Node.js 22 或更高版本，并且运行时不依赖外部 npm 包：

```powershell
npm test
node test/e2e.mjs
node test/manifest-check.mjs
node test/bundle-served.mjs
```

单元测试使用以下 glob 形式：

```powershell
node --test "test/**/*.test.js"
```

不要使用 Node.js 的默认测试发现方式，否则 `test/` 下的辅助服务可能会被当成测试进程启动。

## 已知边界

- 当前每次操作都会重新扫描账本，数据量达到数万条后需要增加索引；
- 并发写入仍然需要上层协调；
- 人格候选由调用方提出，插件负责保存、确认和演化，不负责从自然语言中自动抽取全部特征；
- 图谱是导航和解释界面，节点只显示摘要，完整内容需要通过检索获取；
- 没有 DSH 浏览器环境时，只能验证代码和数据层，不能完成客户端视觉验证。

## 许可

MIT，详见 [LICENSE](./LICENSE)。

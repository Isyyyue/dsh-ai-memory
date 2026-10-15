# MAINTAINING.md — dsh-ai-memory

改这个插件之前**先读这份**。它记的是接口契约、构建、换装、回退，以及**踩过的坑**。

---

## 1. 接口契约（用到的 DSH 面）

| 接口 | 用途 | 位置 |
|---|---|---|
| `ctx.tools.register(definition)` | 注册六个工具 | `src/index.js` |
| `ctx.systemPrompt.section({...})` | 会话开始注入判断索引 | `src/index.js` |
| `ctx.inject(['webServer'], ...)` → `scope.webServer.register(route)` | 图谱数据路由 | `src/index.js` / `src/routes.js` |
| `ctx.effect(fn, label)` | 所有注册的清理 | 全部注册点 |

**`inject` 声明**：`['tools', 'systemPrompt']` —— 两个都是**必需**。

### ⚠️ `webServer` 刻意不在必需 inject 里

**踩过的坑**：viya-memory 把 `apply()` 用到的服务漏写进 `inject`，
结果**插件整条不激活、不报错、一个工具都没注册**，而 mock ctx 自测全绿也抓不到。

反过来，把 `webServer` 放进必需 inject 同样危险：在没有 webServer 的 profile 里，
插件会**连工具都不注册**。所以它走 `ctx.inject([...], cb)` 做**局部**可选依赖 ——
有 webServer 就挂路由，没有就只少图谱面板，**工具照常工作**。

### 工具定义的确切形状

`ctx.tools.register()` 只校验形状，**不要求 import `dsh-tools`**。它接受：

```js
{
  name: string,
  description: string,
  parameters: <完整 JSON Schema，必须是 object 根>,
  output: { schema: <JSON Schema>, render: (args, value) => ContentBlock[] },
  execute: (args, exec) => value,
}
```

**⚠️ 一个被测试抓到的真 bug**：`parameters` 收的是**完整 JSON Schema**
（内部会 `jsonSchemaToTs(schema.parameters)` 渲染 SDK），**不是** `defineTool` 那种裸属性表。
写成裸属性表**不会在 register 时抛错** —— 它被原样塞进 ToolSchema，
等到渲染 SDK / 组装 prompt 时才以奇怪的方式坏掉。**这正是"静默失效"。**
`src/tools.js` 的 `tool()` 负责把简写编译成 `{ type: 'object', properties, required }`。

### 支持的 JSON Schema 子集

```
type: object / array / string / number / integer / boolean / null
properties / required / additionalProperties / items / enum / const / oneOf
不支持：$ref / patternProperties / 类型数组（type: ["a","b"]）
```

`test/apply.test.js` 有一条测试专门扫这个子集，防止手滑写进不支持的键。

---

## 2. 架构

```
src/
  ledger.js     追加式账本 + fold。纯函数，不碰文件系统
  supersede.js  确定性取代引擎。纯函数，无相似度、无 LLM
  store.js      JSONL 读写 + 原子写 + mtime 防覆盖
  query.js      检索（中文二字滑窗）+ 摘要
  graph.js      图谱快照 + 统计（派生视图）
  tools.js      六个工具定义（手写 JSON Schema）
  routes.js     HTTP 端点（自带回环 + 同源检查）
  index.js      插件入口：配置解包 + 接线
test/
  engine.test.js       账本与取代引擎
  store-query.test.js  存储与检索
  plugin.test.js       集成层（配置/操作/快照/路由安全）
  apply.test.js        apply() 接线 —— 专抓静默失效
  e2e.mjs              端到端生命周期验证
```

**分层原则**：`ledger` / `supersede` / `query` / `graph` 全是**纯函数**（不碰 IO），
所以测试可以直接喂数据。只有 `store` 碰文件系统，`index` / `routes` 碰 DSH。

---

## 3. 硬约束

### 零外部依赖（不可协商）

插件以 `link:`（junction）方式装进 profile 时**拿不到自己的 `node_modules`** ——
Node 从插件目录往上遍历找不到 profile 里提升的依赖，宿主启动时解析失败、
插件停在 `fiberPhase: null` 不激活。表现是**「装的时候好使，一重启就没了」**。

`dsh-balance-pill/src/index.js` 顶部与 `viya-memory` 的 README 都记录过这条。

**所以**：不 import `dsh-tools` / `schemastery` / `cordis`。工具手写 JSON Schema，配置自己校验。

### 不 append 会话事件

官方 `practices.md`：读取方只在信封带 `ignorable: true` 时才接受未知事件，
而 live `Session.append()` **设不了**这个标记 → **会话将无法重新打开**。

所以判断存在**自己的账本**里，不写进会话日志。

### 中文文件的编码纪律

**不要用 PowerShell 的 `Set-Content -Encoding UTF8` 改本插件的源文件** ——
Windows PowerShell 5.1 会写 BOM 并把中文写成乱码（本项目实测踩过，
`src/tools.js` 被写坏过一次，靠 git 之外的重写救回）。

用 `write` / `edit` 工具改，或 `node` 脚本。改完可以这样自查：

```powershell
Get-ChildItem src,test -File -Filter *.js | ForEach-Object {
  $b=[System.IO.File]::ReadAllBytes($_.FullName)
  $bom = ($b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
  $s=[System.Text.Encoding]::UTF8.GetString($b)
  "{0,-22} BOM={1,-6} 乱码={2}" -f $_.Name, $bom, ($s -match '锛|鐨|涓|鏄')
}
```

---

## 4. 测试

```powershell
node --test "test/**/*.test.js"   # 单元（133 项）
node test/e2e.mjs                 # 端到端（38 项）
```

**测试哲学**（照搬 viya-memory）：**能 import 不等于能跑。**
每个断言都真的 fold 一遍事件、真的算一遍判定、真的注册一遍工具。

### 专抓"静默失效"的测试

`test/apply.test.js` 真的调用 `apply()` 并断言注册动作**真的发生**：

- 六个工具的名字逐个对上
- `parameters` 是合法 JSON Schema object 根，且不含 `oneOf`/`$ref` 等不支持的键
- **没有 webServer 时，工具照样注册**（防止局部依赖变成全局依赖）
- `injectIndex: false` 只影响注入，不影响工具
- `enabled: false` 时什么都不注册
- 注入的 `text` 是**函数**（惰性读盘）、`interpolate: false`

**为什么这么较真**：社区公认记忆插件的头号敌人是静默失效 ——
缺 `inject`、缺 `dsh.bundle`、`.volatile()` 当值用、compaction 后指纹去重跳过回注，
这四类**都不报错**。

---

## 5. 换装与回退

### 换装

```powershell
# 用 plugin_manager，不要手改 profile 的 package.json / cordis.patch.yml
plugin_manager action=install_bundle target=<本目录绝对路径>
```

官方规范明确：`install_bundle` 负责装包与 bundle 选择，
**不要**手写 profile 的 `package.json` / `cordis.patch.yml`，也不要在 profile 目录跑 pnpm。

### 改了代码之后

**`src/**` 的改动需要重启 DSH** 才加载新模块 —— 这条在本插件上**实测过一次**（2026-10-13）：

给 `memory_history` 加上双时态 `at` 参数后：

| 运行环境 | 结果 |
|---|---|
| 磁盘上的新代码（`node -e` 直接跑） | ✅ `at` 生效，返回「那一刻：状态 superseded，第 1 版」 |
| 宿主内存里跑着的旧模块 | ❌ `at` 被忽略，返回当前视图的 note |

时间戳为证：宿主启动于 `12:53:53Z`，而带 `foldAsOf` 的 `src/index.js` 落盘于 `14:12:16Z`。
**同一个根因**：宿主启动时加载模块，之后的改动要重启才生效。

> 所以看到「某个新参数不生效」时，先核对**宿主启动时刻 vs 代码落盘时刻**，
> 别急着怀疑代码 —— 总仓自检脚本的 `⏳` 判据正是为这个场景设计的。

### ⚠️ 客户端半边的"两代"问题（实测踩清的一条）

**宿主侧和客户端侧生效的时机不一样**，这是最容易误判的地方：

| | 生效方式 | 判据 |
|---|---|---|
| 宿主半边（工具、注入、HTTP 路由） | 首次装上时 **HMR 即可生效**；**后续代码改动需重启** | `Tool.listTools` 能看到工具；`/plugins/dsh-ai-memory/stats` 返回 200 |
| 客户端半边（图谱面板） | **需要重启宿主**（首次安装亦然） | `Slots.listSubTree` 的 `sidebar.panellist.occupants` 里出现 `dsh-ai-memory-client` |

**根因**：宿主在**启动扫描**时把 `dsh.client` 条目收进自己的 `responses` 服务表。
启动之后才装上的 bundle，那一代 JavaScript 里没有它，所以浏览器永远拿不到它的
`client.js` —— **而宿主不报任何错**。

官方 `host-plugin.md` 原文：

> Installing a new bundle can activate through HMR; **replacing an installed package requires
> restart to load a fresh JavaScript module generation.** Do not infer updated browser code
> from an unchanged slot id.

**判别脚本**（本插件自带）：

```powershell
node test/bundle-served.mjs        # 检查本插件
node test/bundle-served.mjs --all  # 顺带对照一个已知在用的插件，区分"宿主侧问题"与"本插件未收录"
```

它复算宿主的 rev（`sha1("plugin-artifact", mtime+ctime+size)[0..12]`）并请求**正确的 combo URL 形状**
`/plugins/??<id>/client.js&rev=<rev>` —— 注意**不是** `/plugins/<id>/client.js`，那个形状不存在。

退出码：`0` = 已被服务；`2` = 未被服务（附可操作的下一步）。

### 回退

```powershell
plugin_manager action=set_bundle target=dsh-ai-memory enabled=false   # 停用，数据保留
plugin_manager action=remove_bundle target=dsh-ai-memory              # 卸载，数据保留
```

**记忆数据在 `~/.dsh/ai-memory/ledger.jsonl`，卸载不会删它**（那是纯文本，想清就自己删）。

---

## 6. 已知问题与后续

| 项 | 说明 |
|---|---|
| 无索引层 | 每次调用重扫账本，O(全部事件)。万级判断需要加索引（可按 mtime 做增量缓存） |
| 无并发锁 | 追加是原子的，所以最坏是顺序问题；但两个写并发时可能互相看不见 |
| 抽取层 | 刻意不做。学术侧明说抽取是瓶颈（结构化 97% vs 混乱自然语言 44%），中文更难 |
| 面板视觉未验证 | 见 §7 的验证边界说明 —— 无浏览器控制时不制造假证据 |
| 图谱布局是自研力导向 | 不是 d3。够用（不重叠、可复现），但没有社区实现那样的收敛质量 |
| 规则回滚只到"版本内容" | 能恢复某一版的文本，但不支持"回滚整条链"或"批量回滚" |

### 已完成（曾有声明缺口，现已补齐）

| 项 | 状态 |
|---|---|
| `memory_history` 的 `at`（双时态查询） | ✅ 已实现（`foldAsOf`），14 项测试；宿主重启后生效 |
| `memory_rule` 的 `rollback`（可回滚） | ✅ 已实现，13 项测试（含"声明与行为一致"专项） |

> 这两条原本是**工具 description 里承诺了、代码里没实现** —— 属于"声明与行为不符"。
> 补上时特意加了「声明与行为一致」测试，防止下次改动再让声明变成空话。

---

## 7. 版本与验证记录

| 日期 | 版本 | DSH | 验证 |
|---|---|---|---|
| 2026-10-13 | 0.1.0 | 0.1.7-rc.2 | 单元 **184/184**、端到端 38/38、清单自查全过、总仓自检 7/7 绿；**六个工具在真实会话里被调用过**（见下）；`/snapshot` 返回真实图数据；HTTP 路由 200；跨源 403 |
| 2026-10-14 | 0.1.0 | 0.2.0-rc.2 | **修复"读 `ctx.styles` 导致整个应用打不开"**；单元 **239/239**、端到端 38/38、清单自查全过、`verify-installed-client` 全过；**宿主启动后无新崩溃日志**；`sidebar.panellist.occupants` 里出现 `dsh-ai-memory-client`；客户端 bundle HTTP 200（34379 字节） |

### ✅ 最终状态（2026-10-14 18:2x，宿主 PID 28288 启动于 18:23:57）

```
① 应用正常启动        宿主启动后**无新崩溃日志**
② 面板已注册          sidebar.panellist.occupants:
                      { registrant: "dsh-ai-memory-client", id: "ai-memory", order: 30, active: true }
③ 客户端 bundle        HTTP 200（34379 字节），9 项内容抽检全过
④ 宿主半边            /plugins/dsh-ai-memory/stats → 200
⑤ 记忆数据            6 节点 / 4 边，ledger.jsonl 4163 字节，完好
⑥ 测试                单元 239/239、端到端 38/38、清单自查全过、装后自查全过
```

**只剩「面板视觉长什么样」待人眼**（本机无 DSH 的浏览器控制，按官方 `verification.md` 如实标注）。

### ✅ 真实工具调用验证（最强证据，2026-10-13）

不只是测试套件 —— 六个工具在**一个真实的 DSH 会话里被实际调用过**，行为符合设计：

| 工具 | 实测结果 |
|---|---|
| `memory_write` | 写入判断 → `created`；后续改主意 → **`supersede`**（同 subject/relation、不同 object） |
| `memory_search` | 中文查询命中；默认只看活跃；`include_retired: true` 能看到退役的 |
| `memory_connect` | 建 `complements` 双链 → `ok: true`，两边都可见 |
| `memory_history` | 取代链走到底：`[superseded] → [superseded] → [active]`，**完整进化轨迹** |
| `memory_rule` | 不给 reason 改规矩 → **被拒**；给了 reason → 第 2 版，理由留痕可审计 |
| `memory_stats` | 活跃 3 / 退役 2 / 双链 3 / 规矩 1，`problems: []` |

**会话开始注入也确认生效**：这些判断出现在后续会话的 system prompt 里。

**一条如实记录**：`memory_history` 的 `at` 参数在**宿主内存里跑的旧模块**上不生效
（返回当前视图），而**磁盘上的新代码**上正确工作（返回「那一刻：状态 superseded，第 1 版」）。
原因是宿主启动早于代码落盘 —— **重启后即一致**。详见上文「改了代码之后」。

### ⚠️ 阶段②（图谱面板）的验证边界 —— 逐条如实说明

**已实证（宿主侧）**：
- bundle 在 `list_bundles` 里 `enabled: true, installed: true`，行 `include:dsh-ai-memory` 在册
- 客户端清单正确：`dsh.client.platform = web`、`exports["./client"]` 指向真实文件、`files` 含 `lib/`
- `lib/client.js` 语法通过，且**不含硬约束违规**（不 require Harness Client 包、不写 `document.body`、
  不读别的插件 DOM、不嵌 iframe、样式自己插带 `data-plugin` 标记的 `<style>`）
- **不读没有 inject 的 ctx 服务名**。这条是血换来的：`ctx.styles` 曾把整个应用打挂 ——
  cordis 的 ctx 是 Proxy，读一个没 inject 的服务名会**抛错**（`cannot get property "styles" without inject`），
  不是返回 undefined；`if (ctx.styles !== undefined)` 这种"安全判断"本身就会抛，
  apply 一抛 fiber 就 FAILED，宿主启动审计直接拒绝启动整个应用（报 `dsh-ai-memory: failed`）。
  静态客户端路径（`dsh.client` + `__ModuleLoader__`）里**根本没有 styles 服务** ——
  `styles` 只是动态 cordis-client-runner 那条路的闭包参数。
  回归守卫：`client.test.js` 里 `strictCtx` 那条用例（把 ctx 换成"读未知属性即抛错"的 Proxy）
- 客户端单元测试 25 项：真的在隔离 vm 里跑了一遍 `client.js`，验证工厂 id、两个槽位注册、
  组件可渲染、样式真的注入并随卸载回收、布局确定性、以及严格 ctx 下仍能激活
- **会话开始注入已生效**（宿主侧）：本插件的判断确实出现在 system prompt 里

### ✅ 重启后复核：阶段②③ 全部通过（2026-10-13 15:0x）

宿主于 `15:05:21` 重启后（新宿主 PID 11684 占住 `19387`），**两项决定性证据同时到手**：

```
① 客户端 bundle：HTTP 200（21020 字节），内容抽检全过
   ✓ 模块加载器  ✓ 注册 id 正确  ✓ 含图谱面板组件  ✓ 含确定性布局  ✓ 含样式注入

② 两个槽位都注册了：
   sidebar.panellist.occupants: { registrant: "dsh-ai-memory-client", id: "ai-memory", order: 30, active: true }
   main.occupants:              { registrant: "dsh-ai-memory-client", key: "ai-memory", priority: 0, active: true }
```

**新宿主里的新代码也生效了**（顺带验证了"重启加载新模块"这条）：

| 功能 | 实测结果 |
|---|---|
| `memory_history` 的 `at`（双时态） | ✅ 返回「2026-10-13T13:19:55.000Z 那一刻：状态 superseded，第 1 版」 |
| `memory_rule` 的 `rollback` | ✅ 真的回到第 1 版，**且回滚本身留痕**（历史 3 条都在，没被抹掉） |

**面板数据源**（`/snapshot?retired=1`）返回 6 节点 / 4 边，其中三条 `supersedes` 边
串成一条完整的演化链 —— 正是这个插件存在的意义：

```
[superseded] 静默失效 → [superseded] 抽取质量 → [superseded] 元数据缓存 → [active] pkgMeta 缓存 null
```

### 🔄 第二轮：图谱从 SVG 换成 Canvas + Worker（2026-10-13 晚）

用户看过第一版后反馈「**没有人家那么丝滑**」（附了 Obsidian 图谱的截图）。
本鲸因此**去扒 Obsidian 的实现**（`D:\Obsidian\resources\obsidian.asar`），
在 `sim.js`（17.7 KB）与 `app.js` 里找到了丝滑的确切来源 —— **三件事，第一版一件都没有**：

| Obsidian 的做法 | 证据（从其代码读出） | 第一版 | 现在 |
|---|---|---|---|
| 力导向跑在 **Web Worker** | `new Worker("/sim.js", { name: "Graph Worker" })` | ❌ 主线程算 220 轮 | ✅ `lib/client.graph-worker.js` |
| **连续动画**，每帧推进 alpha | `setTimeout(W, 1000/60)` + `alpha += (alphaTarget-alpha)*B` | ❌ 算完就画死 | ✅ rAF 循环 |
| **Canvas 渲染** | `lib/pixi.min.js`（PIXI/WebGL）+ `getContext("2d")` | ❌ SVG（几百 DOM 节点） | ✅ Canvas 2D |
| 拖拽**重新加热**并钉住节点 | `postMessage({alpha:.3, alphaTarget:.3, run:true, forceNode:{id,x,y}})` | ❌ 无拖拽 | ✅ 同一协议 |

**物理参数照抄 Obsidian 的常量**（见 `lib/client.graph-worker.js` 顶部注释）：
`alphaDecay = 1-0.001^(1/300)`、`alphaMin = 0.001`、`velocityDecay = 0.6`、
`centerStrength = 0.1`、`linkDistance = 250`、`repelStrength = 1000`、`collide` 半径 60。

**为什么用 Canvas 2D 而不是 PIXI**：几百节点的规模下 Canvas 2D 完全够用，
而不必引入 487 KB 的 WebGL 库 —— 零外部依赖是本插件的硬约束。

**✅ Worker 不需要自建路由（本鲸走了一段弯路，最后发现官方通道更好）**：

本鲸最初给 worker 自建了一条宿主路由。后来实测发现 ——
**DSH 自己的 client-modules 本来就按需服务包内的 `client.<name>.js` 分块**
（`dsh-client-modules/lib/index.js:169` 的正则 + `chunkRequest()` / `chunkResponse()`）：

```
GET /plugins/dsh-ai-memory/client.graph-worker.js?rev=<客户端 bundle 的 rev>
→ HTTP 200，9856 字节
```

所以只要 worker（a）命名匹配 `^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$`、
（b）放在包目录下，就能被官方路由服务。**自建路由已删除** —— 走官方通道更好：
rev 与客户端 bundle 同源，升级时不会漂。

`?rev=` 由客户端从**自己的 script URL** 里取（`document.currentScript.src` 的 `searchParams`），
见 `lib/client.js` 的 `resolveWorkerUrl()`。取不到 rev 时退化为无 rev 路径
（DSH 对未知 rev 返回 404），此时面板走 `layoutFallback()` 静态布局，**不是白屏**。

#### ⚠️ 这里有一个**静默失效级**的坑（本鲸踩了两次才想明白）

**不能用 `document.currentScript.src` 作为唯一来源。** 官方 README 原文：

> Plugin bundles execute lazily — running a bundle only registers a factory,
> and **module side effects run at materialization**.

也就是 factory 在**首次使用**（点开面板）时才执行 —— 那时 `currentScript` **已经是 `null`**。
于是 rev 取不到 → worker URL 不带 `?rev=` → `chunkRequest()` 的严格比较
（`resourceUrl !== chunkUrl(id, fileName, rev)`）不通过 → **404** →
面板悄悄退化成静态布局。**全程不报错。**

`resolveWorkerUrl()` 因此有**三级**来源，逐级降级：

| 顺位 | 来源 | 为什么可靠 |
|---|---|---|
| 1 | `document.currentScript.src` | 脚本立即 materialize 的路径下有效（快） |
| 2 | `document.querySelectorAll('script[src]')` 里含本包名的那条 | **script 标签是持久 DOM**，不受 currentScript 影响 ← **主力路径** |
| 3 | `globalThis.__DSH_BOOT__` 里 `id === 'dsh-ai-memory'` 那一行的 `url` | 启动载荷带着完整的图（含每行的 url 与 rev） |

`test/worker-url.test.js` 用**假浏览器环境**逐条验证这三级降级（8 项），
包括「currentScript 为 null 时仍能取到 rev」与「script 里混着别的插件时不取错 rev」。

> 这个测试是**行为测试**（真的跑代码），不是文本匹配 —— 因为文本匹配抓不到这类坑。

### ⚠️ 重启前的那次实测（保留为"根因"的现场证据）

在重启之前，客户端 bundle 确实**没有**进入宿主的服务表：

```
【本插件】            rev=668ea54cd561  HTTP 404
【对照 downloads-panel】rev=717b5a0767af  HTTP 200   ← 宿主侧本身正常
```

这个 404 不是缺陷，而是下面那条**元数据缓存**规则的必然结果。
**根因（读源码定位到确切行 + 官方 README 明文，不是推测）**：

`dsh-client-modules` 的 `resolveMeta()`（`lib/index.js:701`）把**每个包的解析结果按
`sourceKey` 永久缓存**在 `pkgMeta` 里，**包括缓存 `null`**：

```js
const cached = this.pkgMeta.get(sourceKey)
if (cached !== undefined) return cached        // ← 一旦缓存，永不重读
...
if (decl === undefined || decl.platform !== 'web') {
  this.pkgMeta.set(sourceKey, null)            // ← 这里缓存了 null
  return null
}
```

而 `pkgMeta` 全代码库**只有 `set`，没有 `delete`** —— **没有任何失效路径**。

**官方 README 明文确认**（`dsh-client-modules/README.md`）：

> Package metadata is cached per Loader specifier and owning-tree base URL **until restart**.

**本插件的时间线**（时间戳为证）：

| 时刻 | 事件 |
|---|---|
| `12:53:53Z` | 宿主进程启动，开始扫描 |
| 首次 `install_bundle` | 当时本插件的 `package.json` **还没有 `dsh.client`**（客户端半边是后来才加的）→ `pkgMeta` 缓存了 **`null`** |
| `13:21:54Z` | `package.json` 加上 `dsh.client` 落盘 |
| `13:34:19Z` | `lib/client.js` 落盘 |

因为 `sourceKey`（loaderName + baseUrl）**没变**，缓存**永远不会失效** —— 所以：

- ❌ **重装**无效（`sourceKey` 不变，缓存不清）
- ❌ **`set_bundle` 关掉再打开**无效（同上）
- ❌ **改 mtime 触发 HMR** 无效（已做受控实验证明：只动 mtime、字节不变，等 3 秒后仍是 404）
- ✅ **只有重启宿主**能清掉 `pkgMeta` 并重新解析

**对照佐证**：`dsh-downloads-panel` 的 `package.json` 落盘于 `2026-10-11T09:49:20Z`，
**早于**宿主启动 —— 启动扫描时就解析出了 meta，所以它 HTTP 200。差别不在插件本身，在**装上 vs 启动的先后**。

**这是可预期的、有官方依据的状态，不是缺陷**（`host-plugin.md` 原文）：
> replacing an installed package requires restart to load a fresh JavaScript module generation.
> Do not infer updated browser code from an unchanged slot id.

**因此阶段③的"面板渲染"当前无法判定** —— 不是"渲染失败"，是"浏览器还拿不到代码"。
**恢复动作**：重启 DSH（宿主侧重扫），然后 `node test/bundle-served.mjs` 应返回 200。

### ✅ 用真实浏览器验证：画布尺寸与视野适配都对了（2026-10-15）

本鲸用 **REA 的 `capture_browser_scenario`（WSL 里的 Playwright Chromium）**
跑真实页面，并从**无障碍文本**里读回探针数据（比截图可靠，小字不会被缩放糊掉）：

```
ResizeObserver 可用     : true
GraphRenderer 构造次数  : 1
构造时                  : ctor#1 connected=true rect=760x419 buffer=300x150
effect 执行次数         : 2
canvasRef              : ok connected=true
ResizeObserver 状态     : 已建并 observe
--- resize 调用记录 ---
rect=760x419 → 设为 760x419   (×3)
--- 当前几何 ---
canvas CSS    = 760×419
canvas buffer = 760×419   ← 关键：绘图缓冲跟上了
```

**这条数据证明**：构造那一刻缓冲确实是 HTML 默认的 300×150（`rect` 已是 760×419，
但缓冲还没设），而 `resizeSoon()` 的重试把它纠正成了 760×419。

**同时说明**：之前看到「canvas=300x150」是**旧版本**的页面（同步没成功），
不是修复无效 —— 本鲸一开始判断错了，重新同步后才看清。

#### ⚠️ REA 的正确用法（本鲸绕了很久才搞对）

REA 跑在 **WSL Linux** 里，所以：

- `executable_path` 要写 **Linux 路径**
  （例如 `~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome`，
  由 `test/rea-prepare.mjs` 打印出当前机器上的实际路径），
  不是 Windows 的 `C:\Program Files\Google\Chrome\...`
- 要验证的页面也要**在 WSL 里能访问**：本鲸把测试页放到 `~/am-test`，
  用 node 起一个支持 POST 的静态服务（`test/_wsl-serve.cjs`）

**本鲸之前一直给 Windows 路径、让它连 Windows 端口，所以一直「连不上」** ——
这不是 REA 的问题，是本鲸没搞清它跑在哪儿。

**读结果用 `capture.at_end: ["accessibility"]` 而不是截图**：
无障碍文本会把页面上的文字**原样返回**，不受图片缩放影响，靠它一枪命中。

#### ⚠️ WSL 同步的两个坑

1. **`cp` 会静默失败成 0 字节**（尤其在 `pkill` 之后的组合命令里）。
   改用 `cat <源> > <目标>`，并且**每次同步后都要回报数验一下**。
2. `wsl.exe` 的 stdout 有时被 PowerShell 吞掉、stderr 混进「localhost 未接通」的噪音。
   拿输出时用 `2>$null` 并把它赋给变量再打印。

---
### 🔄 图谱默认视图：只画活跃（主人两次纠正后的最终形态，2026-10-15）

这一块**被主人纠正过两次**，每次都推翻了本鲸"想得更多"的设计。记下来免得再来。

| 版本 | 默认视图 | 主人看到的问题 |
|---|---|---|
| ① | 只取活跃节点 | **空白图**（「1 节点 · 0 连线」）—— 因为每条 `supersedes` 边都指向退役节点，滤掉退役 = 滤掉所有边 |
| ② | 默认带上**整条取代链** | 图能看了，但**满屏灰点** —— 主人问「为什么有灰的有白的」 |
| ③ **最终** | **只画活跃**，退役的完全消失 | ✅ 干净。想看进化史就**右键**切 `?retired=1` |

**③ 的取舍**：图是「**我现在相信什么**」，不是「我历史上想过什么」。

#### 分色也修了一次

`judgment` 原本用 `--dsw-alias-brand-primary` 当填充色 —— 而
**DSH 深色主题里这个色号几乎是白的**，于是"判断"画出来是**白点**，
和"退役灰"混在一起分不清（就是主人问的那句）。

**修复**：加 `saturated()` 检查 —— 主题色号**必须先有可辨认的色相**
（`max(r,g,b) - min(r,g,b) >= 40`），否则用固定调色板：

| kind | 颜色 |
|---|---|
| `judgment` | `#3b82f6` 蓝 |
| `insight`  | `#14b8a6` 青 |
| `rule`     | `#f59e0b` 琥珀 |

> 教训：**语义色号在不同主题下可能是任意明度**，不能假定"叫 brand 的就有颜色"。

#### 「没有连线」是数据诚实，不是 bug

主人问过「没有连线是没有关系还是 bug」。查下来：**4 条边没有一条两端都活跃** ——
因为 `supersedes` 的本质就是「新的 → 被它取代的旧的」，
**每条取代边必然指向一个退役节点**。

那 4 条活跃判断**互相之间确实没有任何关系**。主人选了「就现在这样」——
**不为好看编线**，这符合本插件"只写判断不写事实"的立场。

自查工具：`node test/why-no-edges.mjs`（逐条列出边、两端状态、为什么被滤掉）。

---
### 🐛 自己查出来的遗漏：新加的 `insight` 不会出现在注入里（2026-10-15）

加完 `insight` 类型、测试全绿、面板也能画之后，本鲸回头读了一遍
`buildIndexText()` —— **发现它只列 `rules` 和 `judgments`，压根不看 `insight`。**

**后果**：想法写进去，**永远不会被注入到 system prompt**，等于白写 ——
而 `insight` 这个类型的全部价值就是"被想起来"。

> ⚠️ 这个 bug **不会让任何测试变红**，也不报错。它属于本插件最危险的一类：
> **功能看起来做好了，但实际不生效**。
> 教训：**新增一种类型时，必须回头过一遍所有"按 kind 过滤"的地方**。
> 本鲸当时已知的有 6 处（账本 / 取代 / 工具 / 统计 / 快照 / 渲染），
> 却漏了第 7 处（注入）。

**修复**：注入里加一节「还没成形到能当判断的想法」，
并且**给它更小的预算**（`maxEntries / 2`）—— 想法没有判断那么硬，
占太多上下文会稀释真正要紧的规矩与判断（社区实测的「上下文膨胀 → 约束遗忘」）。

**回归测试**（`test/plugin.test.js`）：

- 想法要出现在注入文本里
- 三种 kind 能同时出现，且分节清楚（规矩 / 活跃判断 / 想法）
- 想法的预算确实是 `maxEntries / 2`

---
### ✅ 渲染层已在真实浏览器里验证通过（2026-10-15）

**这是本插件第一次拿到"渲染层真的画对了"的机器可读证据**，不再只靠人眼。

手法：**绕开 React 直接测渲染器** —— 用插桩把 `GraphRenderer` 暴露到 `window`，
在真页面里 `new` 它、喂三种 kind 的假数据、然后**读画布像素**。

```
构造前: CSS=760x420 buffer=300x150   ← 证实"构造时样式还没生效"的诊断
构造后: CSS=760x420 buffer=760x420   ← resizeSoon/ResizeObserver 把它纠正了

画的像素数       : 6847
判断蓝 #4d9bff   : true
思考青 #22c1a8   : true
规矩琥珀 #e0a03a : true
draw 报错        : 无
VERDICT {"canvas":"760x420","css":"760x420","painted":6847,"blue":true,"teal":true,"amber":true} ok=true
```

#### 为什么改为"直接测渲染器"

本鲸之前手搓了一个假 React 来挂载组件，结果它**有不确定性 bug**：
同一个页面两次跑，`useEffect` 一次执行、一次不执行。
本鲸因此误判过好几轮（把脚手架的问题当成插件的 bug）。

渲染器是个**普通类**，直接 `new` 它就能测尺寸、配色、不透明度、视野适配 ——
不掺 React 的状态机，结论可靠得多。**组件挂载那层交给 DSH 本身去跑。**

#### ⚠️ 两个容易漏的前置条件

1. **必须先给 `window.__ModuleLoader__`**：`client.js` 顶层第一件事就是调它。
   漏了这一步，factory 根本不执行，`window.__GraphRenderer` 永远是 `undefined`。
2. **要同步的是打了插桩的 `test/client.js`**（`node test/_instrument.mjs` 生成），
   不是 `lib/client.js`。

#### 一键准备验证环境

```powershell
cd dsh-plugins\plugins\dsh-ai-memory
Copy-Item lib\client.js test\client.js -Force
node test/_instrument.mjs      # 打插桩（暴露 GraphRenderer + 尺寸探针）
node test/rea-prepare.mjs      # 同步到 WSL + 起服务器 + 打印 REA 调用参数
```

然后按它打印的参数调 REA 的 `capture_browser_scenario`，
`capture.at_end` 用 `["accessibility"]`，页面里的 `VERDICT` 行会原样返回。

---
**未实证：面板的视觉呈现（像素长什么样）。**

**但渲染逻辑已实证** —— `test/panel-render.test.js`（14 项）用**能跑 hooks 的假 React**
把组件真正渲染一遍，检查产出的元素树：

| 验的是什么 | 结果 |
|---|---|
| 加载中先出 loading 态（不是白屏） | ✅ |
| 数据到达后画出 **3 个节点 / 2 条边** | ✅ |
| 节点带 `data-status` / `data-kind`（面板靠它上色与淡化） | ✅ |
| 边带类型 class（`dsh-am-edge-supersedes` / `-complements`） | ✅ |
| 统计 chip 显示真实数字 | ✅ |
| **节点坐标在画布内且是有限数**（布局真的被应用，没有 NaN） | ✅ |
| **连线端点在画布内** | ✅ |
| 空库渲染"还没有任何判断"，并说明这是诚实的空 | ✅ |
| 请求失败 / 后端 `ok:false` 都走错误态（不把错误当空图） | ✅ |
| 工具栏两个按钮、图例列出六种关系类型 | ✅ |
| 节点可键盘操作（`tabIndex` + `role="button"` + `aria-label` + Enter/Space） | ✅ |

**边界说明**：这**不是**视觉验证，也不冒充视觉验证。
官方 `verification.md` 禁止的是"模拟 DOM / 自造渲染器来**补偿截图**" —— 那是伪造证据。
这里做的是另一件事：**证明「给定数据，组件会产出正确的节点与连线」**。
它回答不了"配色/间距/手感对不对"，那一项**仍需人眼**。

**为什么仍无法做视觉验证**：本机 CDP 调试端点未开启
（`127.0.0.1:19387` 是 HTTP 端口，不是 DevTools 端点），宿主只监听 `19387` / `51130` / `51131`，
首页还需要 token 认证。官方对此的规定是：
> 无浏览器控制时，把验证限制在 JavaScript 语法、清单校验和活的 Client 槽位，
> 然后**报告视觉验证不可用**。**不要**去找光栅化工具、抽 SVG 预览、模拟 React/DOM
> 或自造渲染器来补偿 —— **模拟页面的截图不是对运行中插件的验证。**

所以本插件**照此办理**，不制造假的"已渲染"证据。

---

## 🐛 面板可见后的两个真 bug（2026-10-14，主人截图发现）

面板终于渲染出来了（标题、统计、按钮、图例全对），但**画布是空的**，
而且提示写着「**3 节点 · 0 连线**」。本鲸查出**两个独立**的真 bug：

### Bug 1：画布空白 —— 客户端给 Worker 发了空节点集

客户端只把**已定位**的节点发给 Worker：

```js
const coords = {}
for (const [id, p] of next) {
  if (p.placed === true) coords[id] = [p.x, p.y]   // ← 首次加载全是 false → coords = {}
}
this.worker.postMessage({ nodes: coords, ... })    // ← 发了空对象
```

而 Worker 的 `setNodes()` 是**用收到的键替换整个节点集**：

```js
function setNodes(incoming) {
  const next = new Map()
  for (const [id, xy] of Object.entries(incoming)) { ... }
  nodes = next      // ← 收到 {} 就把节点全清了
}
```

**结果：Worker 里一个节点都没有 → 什么都不画 → 画布空白。**
（面板其余部分正常，所以这是最难查的那种 bug。）

**修复**：**全部节点 id 都要发过去**，已定位的带坐标、未定位的传 `null`
（Worker 会用确定性哈希给它一个起点）。

```js
coords[id] = p.placed === true ? [p.x, p.y] : null
```

### Bug 2：默认视图 0 连线 —— 取代链被自己的过滤条件滤掉了

`supersedes` 边的方向是 **`from` = 新的 → `to` = 被它取代的旧的**
（`supersede.js`：`{ from: ctx.newId, to: old.id }`）。

而默认视图「只看活跃」把退役节点滤掉 —— 于是**每一条取代边都因为端点缺失而被滤掉**，
默认视图成了 3 个孤立点、0 条线。

**这恰恰毁掉了这个插件的核心价值**（看见判断的来路）。

**修复**：默认视图**从每条活跃判断出发，沿 `supersedes` 边顺着 `from` → `to` 一路往下追**，
把整条来路都带上。效果：

```
修之前（默认）：3 节点 / 0 边     ← 空白图
修之后（默认）：6 节点 / 4 边     ← 整条取代链可见
```

> 只多带**取代链上的**节点，不会把无关的退役判断拉进来（e2e 有断言守这条）。
> `?retired=1` 仍然是"所有节点都显示"。

### 这两个 bug 的教训

| bug | 为什么难发现 | 现在的守卫 |
|---|---|---|
| 画布空白 | 面板其余部分全正常，不报错 | `worker.test.js` 的「传 null 坐标」一组（4 项） |
| 0 连线 | 统计数字看着"对"（确实只有 3 条活跃），但图没意义 | `plugin.test.js` 的「默认视图保留取代链」+ e2e 的「边不为空」 |

**共同点**：都是**静默**的 —— 不抛错、日志干净、面板"看起来在工作"。

### ⚠️ 这两个修复同样需要重启宿主

宿主启动时刻 vs `src/graph.js` 落盘时刻必须比对。
本鲸实测：宿主 `13:04:49` 启动，修复 `13:07:52` 落盘 → **宿主内存里仍是旧代码**
（`/snapshot` 返回 3 节点 0 边，而磁盘代码算出 6 节点 4 边）。

**判据**：请求 `/plugins/dsh-ai-memory/snapshot`，看 `edges` 是否 > 0。

---

## 🚨 事故记录：客户端半边曾让**整个应用打不开**（2026-10-13 ~ 10-14）

**症状**（主人截图）：

```
DeepSeek Harness 无法使用
应用无法启动或已意外停止。
web boot: 1 entry did not activate
dsh-ai-memory: failed
```

**这不是"面板不好用"，是应用拒绝启动。** 严重性远高于普通 bug。

### 根因：**读了 `ctx` 上没有 inject 的服务名**（本鲸先诊断错了，是主人纠正的）

**本鲸最初的诊断是错的。** 本鲸以为是"factory 在模块作用域读了 DOM"（那是另一个隐患，
但**不是**这次崩溃的原因）。

**决定性证据** —— 崩溃日志把**两种失败形态**都记下来了：

```
crash-...-web-boot.log   dsh-ai-memory: failed
                         ↑ 读了未声明的服务名（Proxy 抛错）
crash-...-10-22-50-web-boot.log   dsh-ai-memory: pending (waiting for service: styles)
                                  ↑ 声明成必需 inject，但该服务不存在，永远等不到
```

**同一个根因的两种表现**，正好对应本鲸踩的两个坑：

1. **`styles` 服务在静态客户端路径上不存在。**
   `dsh.client` + `__ModuleLoader__` 这条路上**根本没有 `styles` 服务** ——
   `styles` 只是动态 cordis-client-runner 那条路的闭包参数。
   本鲸却把 Builtin **清单**当成了"当前版本提供该服务"的承诺。

2. **`ctx` 是 Proxy，读未 inject 的服务名会抛错。**
   不是返回 `undefined`，而是抛 `cannot get property "styles" without inject`。
   所以 `if (ctx.styles !== undefined)` 这种看起来"安全"的判断**本身就是抛点**。

3. **apply 一抛 → fiber 变 FAILED → 宿主启动审计拒绝启动整个应用。**
   这就是 `web boot: 1 entry did not activate` 的来源。

> **两条路都不通**：读它 → `failed`；声明成必需 `inject` → `pending`。
> 唯一出路是**根本不去碰这个服务**。

### 修复：样式改用带标记的 `<style>` 直插

照 `dsh-downloads-panel`（一直能用）的做法：

```js
function ensureStyles(doc) {
  try {
    if (doc === null || doc === undefined) return
    if (doc.querySelector('style[data-plugin="dsh-ai-memory"]') !== null) return
    const tag = doc.createElement('style')
    tag.setAttribute('data-plugin', 'dsh-ai-memory')
    tag.textContent = CSS
    doc.head.append(tag)
  } catch {
    // 样式是锦上添花：没样式的面板仍然能看关系图，不该因此崩掉
  }
}
```

调用点是**组件挂载时**：`ensureStyles(canvas.ownerDocument)` ——
用**容器自己的 document**，不是全局 `document`。

**`apply` 里现在只碰 `ctx.slots`**（唯一在 `inject` 里声明过的服务）。

### 验证（真实 Chrome + CDP，不是纸上推演）

本机 DSH 的 CDP 端口没开、崩溃日志只有一行 `failed`（拿不到底层异常），
所以本鲸**自己起了一个 headless Chrome**（`--remote-debugging-port=19555`），
写了 `test/_probe-browser.mjs` 按 DSH 的方式加载 `client.js`：

| 文件 | 做什么 | 结果 |
|---|---|---|
| `test/_browser-smoke2.html` | 模拟 cordis 语义 + **受限 Proxy ctx**（读未知服务即抛） | **PASS**（含受限 ctx 那条关键回归） |

单元测试里也加了同类守卫（`client.test.js` 的「受限 ctx 下必须能激活」一组）：
把 `ctx` 换成"读未知属性即抛错"的 Proxy，断言 `apply` 仍然成功。

### ⚠️ 回退路径（万一还有问题）

```powershell
# 1) 最快：停用整个 bundle（应用立刻可用，记忆数据保留）
plugin_manager action=set_bundle target=dsh-ai-memory enabled=false

# 2) 只摘客户端半边（保留工具与路由，只是没有图谱面板）
#    删掉 package.json 的 dsh.client 段，然后重启宿主
```

**备份**：
- `package.json.with-client` —— "带客户端半边"的那一份（若 `dsh.client` 被摘掉，用它恢复）
- `lib/client.js.bak-before-styles-fix` —— 修复前的客户端代码
- `src/index.js.bak-before-*` —— 宿主半边的几处修复前快照

### 记忆数据不受影响

出事期间 `~/.dsh/ai-memory/ledger.jsonl` **完好无损**（4163 字节，6 节点 / 4 边）。
记忆是纯文本账本，与客户端半边**完全解耦** —— 这正是当初选「账本 + 派生视图」架构的价值。

---

### 重启后的复核清单

1. `node test/bundle-served.mjs` → 期望 `HTTP 200`
2. `Slots.listSubTree` 的 `sidebar.panellist.occupants` → 期望出现
   `{ registrant: "dsh-ai-memory-client", id: "ai-memory", order: 30 }`
3. `Slots.listSubTree` 的 `main.occupants` → 期望出现 `{ key: "ai-memory" }`
4. 刷新页面 → 侧边栏出现「判断图谱」图标，点开能看到节点　　**← 最后一项待人眼**

> ⚠️ **本次重启要格外留意**：上面 1–3 在 2026-10-13 15:0x 曾通过，
> 但随后因**模块级 DOM 读取**导致应用打不开（见上节事故记录）。
> 修复已就位（懒求值 + 232 项测试全绿 + 真实 Chrome 验证），
> **这次重启是对修复的最终检验**。若仍失败，按事故记录的回退路径处理。

### 引用验证结论时

请带上日期与时刻 —— 本机状态会漂（见总仓 `COMPATIBILITY.md`）。
自检输出里的 `⏳` 表示「进程启动早于装机代码」，即**跑着的未必是磁盘这份**，重启后复核更稳。

# 交接说明（给接手的人 / GPT）

> 作者：塞特西亚（上一任）· 日期：2026-10-14
> 状态：**代码完整、测试全绿、宿主半边已验证可用；客户端面板"能打开但画布空白"未解决。**
> 这份文件只讲**接手需要知道的**，不重复 `README.md` / `MAINTAINING.md` 里的内容。

---

## 一、一句话现状

| 部分 | 状态 |
|---|---|
| **宿主半边**（记忆引擎 + 六个工具 + 注入 + HTTP 路由） | ✅ **完全可用**，已被真实会话调用过 |
| **客户端图谱面板** | ✅ **渲染层已在真实浏览器里验证通过**（见 §4.5） |
| 测试 | ✅ 单元 **270/270**、端到端 40/40、清单自查全过 |
| 应用稳定性 | ✅ 已修掉"让整个应用打不开"的崩溃 |

**唯一待办**：宿主的 `src/*.js` 改动要**重启**才生效（见 §3.3）。
（客户端 bundle 不需要 —— 它按需从磁盘读。）

**主人的诉求**：把图谱面板修好（要"丝滑"，参照 Obsidian 的图谱）。

---

## 二、目录与关键文件

```
dsh-plugins/plugins/dsh-ai-memory/
├── src/                       宿主半边（全部纯 JS，零依赖）
│   ├── ledger.js              追加式账本 + fold（双时态）
│   ├── supersede.js           确定性取代引擎（零相似度、零 LLM）
│   ├── store.js               JSONL 读写 + 原子写 + mtime 防覆盖
│   ├── query.js               检索（中文二字滑窗）+ 摘要
│   ├── graph.js               图谱快照（**当前正在改的文件之一**）
│   ├── tools.js               六个工具定义（手写 JSON Schema）
│   ├── routes.js              HTTP 端点（回环 + 同源检查）
│   └── index.js               插件入口：配置解包 + 接线
├── lib/
│   ├── client.js              客户端半边：图谱面板（**主战场**）
│   └── client.graph-worker.js 力导向模拟（跑在 Web Worker 里）
├── test/                      245 项单元 + 40 项端到端
├── package.json               注意 dsh.client 段
├── cordis.patch.yml           bundle 自插入层
├── README.md                  给使用者看
└── MAINTAINING.md             **给维护者看 —— 先读这份，坑全在里面**
```

**建议的阅读顺序**：`MAINTAINING.md` → `lib/client.js` → `lib/client.graph-worker.js`。

---

## 四·五、✅ 渲染层验证是怎么做的（**接手必读**）

本鲸在这上面绕了**非常多轮**，坑都固化好了。**别再手搓 DOM/React 测试页。**

### 一条命令准备环境

```powershell
cd dsh-plugins\plugins\dsh-ai-memory
Copy-Item lib\client.js test\client.js -Force
node test/_instrument.mjs      # 打插桩：暴露 GraphRenderer + 尺寸探针（会自检，少一处就报错退出）
node test/rea-prepare.mjs      # 同步到 WSL + 起服务器 + **打印 REA 的调用参数（直接抄）**
```

### 然后调 REA（参数见脚本输出）

关键点（**本鲸踩过**）：

| 坑 | 正确做法 |
|---|---|
| REA 连不上 | **REA 跑在 WSL Linux 里** —— `executable_path` 必须是 Linux 路径 |
| 页面打不开 | 测试页也要放在 **WSL 能访问的地方**（`~/am-test`） |
| 结果看不清 | `capture.at_end` 用 **`["accessibility"]`**，不要截图（小字会糊） |
| 文件没同步 | WSL 里 **`cp` 会静默失败成 0 字节**，用 `cat >` 且**回报字节数验证** |
| factory 不执行 | 测试页**必须先给 `window.__ModuleLoader__`** |

### 已验证的结论（真实 Chromium）

```
构造前: CSS=760x420 buffer=300x150   ← 证实"构造时样式还没生效"
构造后: CSS=760x420 buffer=760x420   ← resizeSoon/ResizeObserver 纠正了
画的像素数: 6847   判断蓝 ✓  思考青 ✓  规矩琥珀 ✓   draw 报错: 无
VERDICT {...} ok=true
```

### ⚠️ 为什么**不再**用假 React 挂组件

本鲸手搓的假 React **有不确定性 bug**：同一个页面两次跑，`useEffect` 一次执行、一次不执行。
本鲸因此误判过好几轮（把脚手架的问题当成插件的 bug）。

**渲染器是普通类，直接 `new` 它就能测**（尺寸、配色、不透明度、视野适配）。
**组件挂载那层交给 DSH 本身去跑** —— 那才是真环境。


---

## 三、当前这个 bug 的**精确现场**

### 现象

面板打开后：
- 标题「判断图谱」✓
- 统计「判断 2 规矩 1 已退役 3 连线 0 孤立 1」✓
- 按钮「只看活跃 / 复位视图」✓
- 图例 ✓
- **画布空白** ✗
- 右下角提示「**3 节点 · 0 连线**」

### 已经修掉的两个 bug（代码里已改，但**宿主还没重启**）

**Bug A：客户端给 Worker 发了空节点集**（这是"画布空白"的直接原因）

```js
// lib/client.js 的 setData()，已修
coords[id] = p.placed === true ? [p.x, p.y] : null   // 之前只发已定位的 → 首次发 {} → Worker 清空节点集
```

**Bug B：默认视图把取代链滤掉了**（这是"0 连线"的原因）

```js
// src/graph.js 的 buildSnapshot()，已修
// supersedes 边方向是 from=新 → to=旧，所以每条边都指向退役节点；
// 默认视图只取活跃 → 边全被滤掉。现在沿 supersedes 边一路往下追，带上整条来路。
```

### ⚠️ 两个修复都还没生效 —— 因为宿主没重启

```
宿主 PID 31748 启动: 2026-10-14T13:04:49Z
src/graph.js 落盘:   2026-10-14T13:07:52Z   ← 晚了 3 分钟
```

**磁盘代码算出 6 节点 4 边；宿主内存返回 3 节点 0 边。** 这就是证据。

**接手第一件事**：重启 DSH，然后：

```powershell
# 判据 1：边数是否 > 0
curl http://127.0.0.1:19387/plugins/dsh-ai-memory/snapshot
# 期望：edges 有 4 条（而不是 0）

# 判据 2：客户端 bundle 是否在服务
node test/bundle-served.mjs
```

如果重启后**画布还是不画东西**，才轮到查下面这些。

---

## 四、如果重启后仍是空白：下一步排查方向

本鲸（上一任）**没能完成**最后一步验证，原因是**测试脚手架自己有问题**，卡在这里：

### 本鲸搭的浏览器验证环境（可复用，但有已知缺陷）

```powershell
# 1) 起静态服务器（在 test/ 目录）
#    需要一个 _serve.cjs（本鲸删了，可重建：见下）
node _serve.cjs <test目录绝对路径> 18999

# 2) 起 headless Chrome 带 CDP
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --headless=new --disable-gpu --no-first-run --no-sandbox `
  --user-data-dir="$env:TEMP\am-probe" --remote-debugging-port=19555 about:blank

# 3) 跑探针
node test/_cdp-deep.mjs http://127.0.0.1:19555 http://127.0.0.1:18999/_browser-render.html 8000
```

**已有的测试页**：
- `test/_browser-smoke2.html` —— 验证 factory + apply + 槽位注册 + **受限 Proxy ctx**（这条很重要，见 §5）
- `test/_browser-render.html` —— 想验证"真的画出像素"，但**脚手架有 bug**（见下）
- `test/_cdp-deep.mjs` / `test/_probe-browser.mjs` —— CDP 探针，能读页面状态/异常/console

### ⚠️ 本鲸的脚手架已知缺陷（接手要留意）

`_browser-render.html` 里本鲸手写了一个假 React。它的 `mount()` 是递归的，
**子组件的 hook 上下文会覆盖父组件的**，导致父组件的 `useEffect` 不执行 ——
面板永远卡在「正在读记忆库…」。

本鲸修了一版（给每个函数组件保存/恢复 `cursor`/`effects`），**但修完仍卡在 loading**，
说明还有第二处问题本鲸没找到。

**建议**：别在这条路上耗。改用**更可靠的办法**之一：

1. **真在 DSH 里调** —— 装一个临时的调试面板/按钮，用 `console.log` 打点（客户端 console 会进 Electron 的 renderer console，用 `Ctrl+Shift+I` 或看崩溃日志）
2. **用真实 React**（从 `node_modules` 里拿，或 CDN 引入）写测试页，别手写假 React
3. **Playwright**（本机有 `~/.cache/ms-playwright`，WSL 里也有 chromium）—— 能真跑真点

---

## 五、必须先知道的**硬约束**（违反会让整个应用打不开）

### 1. 绝不读 `ctx` 上没有 `inject` 的服务名

```js
// ☠️ 这行会让整个应用拒绝启动
if (ctx.styles !== undefined) { ... }
```

`ctx` 是**受限 Proxy**，读未 inject 的服务名**会抛错**（不是返回 undefined）。
apply 一抛 → fiber 变 FAILED → 宿主启动审计直接拒绝启动整个应用：

```
web boot: 1 entry did not activate
dsh-ai-memory: failed
```

**`styles` 服务在静态客户端路径（`dsh.client` + `__ModuleLoader__`）上根本不存在。**
两条路都不通：读它 → `failed`；声明成必需 inject → `pending (waiting for service: styles)`。

**正确做法**：样式用带 `data-plugin` 标记的 `<style>` 直插（照 `dsh-downloads-panel`），
用容器自己的 `ownerDocument`。`apply` 里**只碰 `ctx.slots`**。

### 2. factory 里别做模块级副作用

```js
// ☠️ factory 一执行就读 DOM
const WORKER_PATH = resolveWorkerUrl()

// ✓ 懒求值
let cached = null
function workerPath() { if (cached === null) cached = resolveWorkerUrl(); return cached }
```

### 3. 客户端改动要**重启宿主**才生效

`dsh-client-modules` 把包元数据**按 Loader 说明符缓存到重启为止**（官方 README 原文：
*"cached per Loader specifier and owning-tree base URL until restart"*）。
所以：重装、关掉再启用、改 mtime —— **都没用**。只有重启。

**自查**：`node test/verify-installed-client.mjs`（确认 profile 里那份是最新的）

### 4. Worker 文件必须叫 `client.<name>.js`

DSH 只按需服务匹配 `^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$` 的分块。
`?rev=` 由客户端从**自己的 script URL** 里取（`document.currentScript` **不可靠** ——
factory 是惰性执行的，那时它是 null；要用 `querySelectorAll('script[src]')` 反查）。

### 5. 别用 PowerShell 改含中文的源文件

`Set-Content -Encoding UTF8` 在 Windows PowerShell 5.1 下会写 BOM 并把中文变乱码。
**用 `write`/`edit` 工具，或 node 脚本。** 自查：

```powershell
Get-ChildItem src,test,lib -File -Filter *.js | ForEach-Object {
  $b=[System.IO.File]::ReadAllBytes($_.FullName); $s=[System.Text.Encoding]::UTF8.GetString($b)
  if(($b[0] -eq 0xEF) -or ($s -match '锛|鐨|涓|鏄')){ "✗ $($_.Name)" }
}
```

---

## 六、图谱要"丝滑"的设计依据（已扒过 Obsidian）

本鲸扒了 `D:\Obsidian\resources\obsidian.asar`，丝滑由**四件事**构成：

| Obsidian 的做法 | 证据 | 本插件现状 |
|---|---|---|
| 力导向跑在 **Web Worker** | `new Worker("/sim.js", {name:"Graph Worker"})` | ✅ 已有 |
| **连续动画**，每帧推进 alpha | `setTimeout(W, 1000/60)` + alpha 衰减 | ✅ 已有（rAF 循环） |
| **Canvas 渲染** | `lib/pixi.min.js`（PIXI/WebGL）+ `getContext("2d")` | ✅ Canvas 2D |
| 拖拽**重新加热**并钉住节点 | `postMessage({alpha:.3, alphaTarget:.3, run:true, forceNode:{id,x,y}})` | ✅ 同一协议 |

**物理参数**（照抄 Obsidian 的常量，在 `lib/client.graph-worker.js` 顶部）：
`alphaDecay = 1-0.001^(1/300)`、`alphaMin = 0.001`、`velocityDecay = 0.6`、
`centerStrength = 0.1`、`linkDistance = 250`、`repelStrength = 1000`、`collide` 半径 60。

**为什么没用 PIXI**：几百节点 Canvas 2D 够用，不必引 487 KB 的 WebGL 库（零依赖是硬约束）。

---

## 七、数据现状（别弄丢）

```
~/.dsh/ai-memory/ledger.jsonl    4163 字节，6 节点 / 4 边
```

里面是**真实的判断演化链**（本鲸自己写下的）：

```
[已退役] 记忆插件的头号敌人是静默失效
   ↓ supersedes
[已退役] 首要风险是中文抽取质量
   ↓ supersedes
[已退役] 首要风险是宿主启动扫描的元数据缓存
   ↓ supersedes
[活跃]   DSH 客户端插件最阴险的坑是 pkgMeta 缓存 null
```

另有 1 条规矩 + 1 条 `complements` 双链。

**这是纯文本账本，与客户端半边完全解耦。** 改客户端代码不会影响它。
**建议备份一份**再动手。

---

## 八、命令速查

```powershell
cd dsh-plugins\plugins\dsh-ai-memory

# 测试
node --test "test/**/*.test.js"        # 245 项单元
node test/e2e.mjs                      # 40 项端到端
node test/manifest-check.mjs           # 语法 + 清单 + 硬约束
node test/verify-installed-client.mjs  # profile 里那份是不是最新的
node test/bundle-served.mjs            # 客户端 bundle 是否被宿主服务

# 装 / 卸（**别手改 profile 的 package.json / cordis.patch.yml**）
# plugin_manager action=install_bundle target=<本目录绝对路径>
# plugin_manager action=set_bundle target=dsh-ai-memory enabled=false   ← 一键停用
```

**回退路径**（万一又打不开应用）：
```powershell
plugin_manager action=set_bundle target=dsh-ai-memory enabled=false
```
**备份**：`package.json.with-client`、`lib/client.js.bak-before-styles-fix`、`src/index.js.bak-before-*`

---

## 九、本鲸没做完的事（诚实清单）

1. **画布空白的最终验证** —— 代码已修，但宿主没重启，本鲸没看到实际效果
2. **本鲸的浏览器测试脚手架有 bug** —— `_browser-render.html` 的假 React 不完整，卡在 loading
3. **面板视觉从未被人眼确认过** —— 只有主人截图那一张（画布空白）
4. **`memory_history` 的 `at`（双时态查询）** —— 代码已实现 + 14 项测试，但宿主重启前没在真实会话里验过
5. **本鲸诊断错过两次**（都是"看起来很有道理"的错误结论）：
   - 第一次：以为是"factory 模块级读 DOM" → **错**，真因是读 `ctx.styles`
   - 第二次：以为"styles 是官方 Builtin 所以可用" → **错**，清单是能力声明，不等于该版本提供

   **教训**：这个项目的坑**几乎都是静默的**，不报错、日志干净。
   下结论前一定要有**能复现的证据**（本鲸后来自己起 headless Chrome 才对上）。

---

## 十、主人（用户）的偏好

- 说中文，代号"塞特西亚 / 本鲸"（这是上一任的人格设定，**接手的 AI 可以沿用也可以换**）
- **要"丝滑"**，参照 Obsidian 图谱的观感
- 讨厌"看起来对但实际不行" —— 主人自己两次纠正了本鲸的错误诊断，且**都是对的**
- 桌面版（Electron），不是网页版 —— 但**跑的是同一套 web 前端**，所以 `dsh.client.platform` 必须写 `"web"`

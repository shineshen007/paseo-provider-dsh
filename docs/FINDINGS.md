# FINDINGS — API 可行性验证（P0 实测结论）

环境：macOS arm64，Node v24.15.0，`@deepseek-ai/dsh` 0.2.1-rc.2（Desktop 0.2.0-rc.2 家族），
`@getpaseo/plugin` 0.13.1（本机 Paseo App 0.13.0 内嵌 runtime 常量与 0.13.1 逐字一致）。
所有 DSH 侧结论均在**隔离环境**取得：`DSH_HOME=/tmp/dsh-p0-home`，专用 profile `paseo-test`，
未读写用户 `~/.dsh` 的 web/desktop/headless profile，未改动用户任何会话。

## P0-1 ✅ 专用 profile 可派生，且完整挂载 Session Controller

`dsh --profile paseo-test --from-default-profile web --dump-config` 生成独立 profile 目录
（`package.json`/`cordis.yml`/`cordis.patch.yml`/`pnpm-workspace.yaml`），bundle 层为
`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`。

在该 profile 中挂载自写插件 `inject: ['sessionController', ...]` 后启动，
`ctx.sessionController` 的完整原型链实测为：

```
promote, resolveAgent, inspect, list, search, create, selectModel, initializeDefaultModel,
modelCatalog, canOpenWorkspacePath, workspaceDesktop, openWorkspacePath, workspacePathApplications,
verifyDesktopPath, rename, fork, prompt, attachment, updateQueue, cancel, page, follow,
projections, liveProjections, control
```

即：**需求 4/5/6 所需的列表、创建、提问、取消、分页历史、实时跟随、投影、改名、分叉全部就位**，
无需任何核心改动。

## P0-2 ✅ 原生能力实测（真实模型回合，非模拟）

隔离环境补入凭据后，`modelCatalog()` 返回真实目录：

```
default  = {provider:"deepseek-official", model:"deepseek-flash"}
routable = ["deepseek-official","deepseek-account"]
groups   = deepseek-official: deepseek-flash[off/low/high/max], deepseek-v4-pro[off/low/high/max]
           deepseek-account : deepseek-flash[off/low/high/max], deepseek-v4-pro[off/low/high/max]
```

→ **模型切换**与**思考强度切换**（`reasoningEfforts` = off/low/high/max）是真实 DSH 目录，
可直接映射 Paseo 的 `models` / `thinkingOptions`。

一次真实提问（`sc.prompt({mode:'queue'})`）捕获到的 durable 事件序列：

```
permission/preset → sandbox/mode → approval/policy → model/selection → command/run → plan/mode
→ command/done → agent/inbox/spliced×2 → turn/start → step/start → system/message
→ user/message×4 → request/header → request/context → session/title×2
→ session/title-llm-request → session-log-deepseek/delivery-accepted×2
→ assistant/message → step/end → turn/end
```

→ 回合边界（`turn/start`/`turn/end`）、助手消息、系统/用户消息、模型选择、权限策略
全部可观测，可作为 Paseo 时间线的权威来源。

## P0-3 ✅ 流式（增量）实测

`sc.follow({assistantStream:true})` 一次回合收到 **311** 个 `assistant-stream` 帧，
帧类型 `start` / `chunk` / `end` 齐备，样本：

```json
{"type":"chunk","attemptId":"session-…:1","revision":2,"index":0,
 "chunk":{"type":"block-start","index":0,"blockType":"reasoning"}}
```

→ 与 Paseo daemon 的 `messageId` 增量语义天然对齐（同一 `attemptId` 连续 chunk = 同一消息增量），
可实现真流式而非回合结束一次性输出。

## P0-4 ✅ Plan 模式是真实 seam，但**不在宿主常驻作用域**

关键设计修正：`plan-mode` 在 `dsh-web-app/cordis.patch.yml` 中被 **按 agent preset 隔离**
（`isolate: {planMode: true}`），因此宿主根 Context **没有** `ctx.planMode`。
在根作用域 inject `planMode` 会让插件永久 `pending`（实测：`waiting for service: planMode`）。

正确路径已实测通：**通过会话命令运行时执行 `/plan` / `/plan off`**

```
ctx.commands.execute(agent, '/plan', [], signal)
  → {"kind":"success","text":"Plan mode on. Use /plan off to leave."}
ctx.sessionController.projections({sessionId})
  → values.plan = {"active":true,"pending":false}
```

→ Plan 状态既**可控**（命令）又**可读**（`plan` 投影），无需持有 agent 作用域服务。

## P0-5 ✅ 权限/审批/提问 seam 均存在

```
ctx.approval.request              : function   (outcome 闭集 allowed-once|rejected|cancelled|unavailable)
ctx.permissionPresets.catalog     : function   → {options:[read-only, workspace-strike…], defaultPreset:"workspace-write"}
ctx.permissionPresets.current/set : function
ctx.userQuestions.ask             : function   (waterfall 'user-questions/request')
ctx.subagents.listChildren        : function
ctx.commands.list/execute         : function   → 实测命令集: compact, export, feedback, goal, permission, plan
```

实测权限目录：

```json
{"options":[{"value":"read-only"},{"value":"workspace-write"},{"value":"danger-full-access"}],
 "defaultPreset":"workspace-write"}
```

→ 沙箱/审批预设可映射为 Paseo `settings` 下拉；`danger-full-access` 存在但**绝不自动选择**。

## P0-6 ✅ 第三方插件安装/组合链路可行（无核心改动）

- 本地包 `pnpm add /path/to/bridge` 装入 profile → `package.json.dependencies` 记录 `link:`
- profile 的 `cordis.patch.yml` 用 **`- insert:` 列表**追加条目（顶层 `- id:` 只能覆盖已存在条目，
  会报 `patch: entry "..." not found`）
- `dsh --profile <p> --dump-config` 可见我方条目 → 191 条组合成功
- 启动后插件 `apply()` 正常执行，服务注入成功

## P0-7 ⚠️ `sessionController` 部分方法强制要求 `AbortSignal`

实测报错并已定位：`prompt`、`page`、`projections` 等 Remote 方法在缺 signal 时抛
`Cannot read properties of undefined (reading 'throwIfAborted')`。
→ 桥接层必须为每个调用构造 `AbortSignal`（可复用长生命周期 controller）。

## P0-8 ⚠️ `page()` 的 `throughSeq` 必须 ≤ follow 游标

实测 `throughSeq: 100000` 报 `session page through seq 100000 is past cursor 25`。
→ 历史重放必须先 `follow` 拿到 `snapshot.cursor`，再以该游标请求 `page`。

## P0-9 ⚠️ 会话日志为压缩帧格式

`~/.dsh/sessions/<cwd-slug>/session-<uuid>/session.v4.jsonl.zstd` 不是单 zstd 负载
（解压仅得 header 行），是分帧压缩流。
→ **不自行解析磁盘日志**；历史一律走 `page`/`follow` 官方路径，避免与 DSH 存储格式耦合。

## P0-10 ⚠️ 工具调用与子 Agent 需要正确的 agent preset

首次探测未出现 `tool/call`：会话运行在 `standard` preset 且预设工具可用，但模型选择了纯文本回复；
`listChildren` 返回 `[]` 属预期（未真正触发 delegation）。
→ 集成测试必须使用**确定性触发**（明确要求调用 bash / subagent 并校验 `tool/call` 事件出现），
不能以"模型没调用"判定功能缺失。

## 对实现方案的修正（相对计划稿）

1. **Plan 模式**：改走 `commands.execute('/plan')` + `projections.plan`，不 inject `ctx.planMode`。
2. **桥接层 inject 集合**：`sessionController, agents, llm, sessions, sessionPersistence, approval,
   permissionPresets, userQuestions, subagents, commands, sessionProjections`（去掉 `planMode`）。
3. **所有 Remote 调用**统一包装 `AbortSignal`。
4. **历史重放**先 `follow` 取游标再 `page`，且不复用磁盘日志解析。

## P0-11 ✅ Paseo 直接加载 `.ts` 入口，且为 strip-only 转译

实测：Paseo 插件契约要求 `index.server.ts` 的每个相对导入必须落在 `server/` 或 `shared/` 内
（根目录相对导入为编译错误）。用 `node --experimental-strip-types` 加载该入口时，会拒绝
**TypeScript 参数属性**（`constructor(private readonly x: T)`）：

```
TypeError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter property is not supported in strip-only mode
```

→ 所有类（`BridgeClient`、`JsonRpcPeer`、`SocketCarrier`）改为显式字段 + 构造函数体赋值。
修正后入口加载成功，并按 daemon 的 `registerProvider` 校验规则逐条通过：

```
provider: dsh | DeepSeek Harness | command: ["dsh"] | icon: icon.svg
connect: function | status: function | cacheKey: function
PASSES daemon registerProvider validation
cacheKey stable: true | cwd-sensitive: true
```

## P0-12 ⚠️ macOS `sun_path` 上限导致 Unix socket 失败

在 `DSH_HOME` 位于深层临时目录时，套接字路径达 **109 字节**，`listen()` 报
`Error: listen EINVAL`。macOS/BSD 的 `sun_path` 上限为 104 字节（Linux 108），含终止符。

→ `resolveSocketPath()` 按顺序选择可容纳的路径（DSH home → OS 临时目录 → `/tmp`），
桥接侧对 `EINVAL` 给出明确诊断，绝不静默截断路径。

## P0-13 ✅ 隔离安装/卸载闭环

`install.sh` → `doctor`（12 项全通过）→ `uninstall.sh` 往返后：

- `~/.paseo/config.json` 恢复到安装前的键集合；
- profile 的 `cordis.patch.yml` 由备份精确还原；
- `pnpm remove` 后残留的 `link:` 符号链接被显式清除。

同时确认：profile 模板自带的 `cordis.patch.yml` 仅含注释与空 flow 列表 `[]`，
**追加内容会产生第二个 YAML 文档**并被加载器拒绝（`end of the stream or a document separator is expected`）；
安装脚本因此重写为单一文档。

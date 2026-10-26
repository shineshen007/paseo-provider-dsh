# paseo-provider-dsh 中文使用指南

在 Paseo 中使用原生 DeepSeek Harness（`dsh`）的完整操作说明。

本插件让 **Paseo 直接把 DSH 当作原生 Provider 使用**：不是 ACP 包装、不是协议转换、不是提示词模拟。
模型列表、Plan 模式、思考强度、沙箱权限、工具审批、交互式提问、子 Agent、会话历史全部来自 DSH 自己的服务。

---

## 1. 安装前确认

按顺序检查下面四项，缺任何一项都会导致后面失败。

### 1.1 检查 DSH CLI

```bash
dsh --version
```

应有版本号输出（开发验证版本 `0.2.1-rc.2`）。若没有：

```bash
npm install -g @deepseek-ai/dsh
```

### 1.2 检查 Paseo 版本

```bash
/Applications/Paseo.app/Contents/Resources/bin/paseo --version
```

需要 **0.13.x**（本插件 `requirements.paseo` 为 `>=0.13.0 <0.14.0`）。

> `paseo` 命令不在 PATH 里是正常的：它在 Paseo.app 内部。建议先加个别名：

```bash
alias paseo='/Applications/Paseo.app/Contents/Resources/bin/paseo'
```

### 1.3 检查插件总开关（最容易卡住的一步）

```bash
python3 -c "import json,os;print('pluginsEnabled =', json.load(open(os.path.expanduser('~/.paseo/config.json'))).get('pluginsEnabled','缺失'))"
```

**这一步非常关键：**

- 输出 `True` → 可以继续。
- 输出 `缺失` 或 `False` → **Paseo 不会启动任何插件**，插件安装后状态会显示 `disabled`，界面里看不到 DeepSeek Harness。

Paseo 把「缺失」视为 `false`。需要你明确同意开启，因为插件是**受信任、无沙箱**的代码，能访问文件、进程和凭据。

开启方式二选一：

- **图形界面**：Paseo → Settings → Plugins → 打开 Enable plugins。
- **命令行**：安装时加 `--enable-plugins`（见第 2 步）。

### 1.4 检查 pnpm

```bash
pnpm --version
```

没有的话：`npm install -g pnpm`。

---

## 2. 安装

```bash
cd paseo-provider-dsh

# 1) 装依赖并构建（首次需要）
npm install
node scripts/build.mjs

# 2) 安装：创建专用 DSH profile + 注册 Paseo 插件
#    若第 1.3 步插件总开关未开启，加 --enable-plugins 表示你同意开启
bash scripts/install.sh --enable-plugins
```

安装脚本会做四件事，**只做这四件**：

| 动作 | 位置 | 为什么 |
|---|---|---|
| 创建专用 DSH profile | `~/.dsh/profiles/paseo-dsh/` | 不碰你已有的 `web` / `desktop` / `headless` |
| 写入 bridge 条目 | 该 profile 的 `cordis.patch.yml`（先备份） | 让 DSH 加载桥接插件 |
| 安装 bridge 包 | 该 profile 的 `node_modules`（pnpm） | DSH 官方第三方插件机制 |
| 注册 Paseo 插件 | `~/.paseo/config.json`（先备份） | 让 Paseo 认识这个 Provider |

安装脚本会**拒绝**对 `web` / `desktop` / `headless` 操作，这是刻意设计：保证不影响你现有的 DSH。

### 2.1 验证安装

```bash
node scripts/doctor.mjs
```

期望看到 13 项全部 `ok`，例如：

```
ok    dsh CLI — <版本号> (/path/to/dsh)
ok    DSH profile — ~/.dsh/profiles/paseo-dsh
ok    bridge patch entry — present in cordis.patch.yml
ok    profile composes — 191 entries
ok    profile is dedicated — bundles: @deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app
ok    bridge package — dsh-paseo-bridge@0.1.0
ok    plugin manifest — id=paseo-provider-dsh requires paseo >=0.13.0 <0.14.0
ok    Paseo registration — directory:/.../paseo-provider-dsh
ok    pluginsEnabled (daemon switch) — on
ok    Paseo version — 0.13.0 vs requires >=0.13.0 <0.14.0
ok    bridge handshake — wire 1, bridge 0.1.0, node v24.15.0
ok    advertised features — all present

13 ok, 0 warning(s), 0 failure(s)
```

其中 `bridge handshake` 会真的启动一次 DSH 完成握手，所以这一项通过基本说明链路是通的。

---

## 3. 在 Paseo 里使用

### 3.1 重启 / 重载

```bash
paseo reload          # 配置变更热重载
paseo plugin ls       # 应看到 paseo-provider-dsh -> running
```

若 `paseo reload` 不可用（daemon 没跑），直接启动 Paseo 应用即可。

### 3.2 选择 Provider

新建 Agent 时，Provider 下拉里会出现 **DeepSeek Harness**。

也可用命令行直接跑一次：

```bash
paseo run "列出当前目录的文件" --provider dsh
```

指定模型（`provider/model` 形式）：

```bash
paseo run "解释这个仓库的构建流程" --provider dsh --model dsh/deepseek-official/deepseek-flash
```

### 3.3 可用的功能

| 功能 | 在 Paseo 里怎么用 | 背后是 DSH 的什么 |
|---|---|---|
| **模型切换** | Agent 设置里选模型 | `modelCatalog()` 真实目录 |
| **思考强度** | 选模型的 thinking 选项（off / low / high / max） | 真实 `reasoningEffort` |
| **Plan 模式** | 模式选 `Plan`，或发 `/plan` | DSH `/plan` 命令 + `plan/mode` 事件 |
| **退出 Plan** | 模式切回 `Build`，或发 `/plan off` | 同上 |
| **权限/沙箱** | 设置里的 Permissions 下拉 | `ctx.permissionPresets`（read-only / workspace-write …） |
| **工具审批** | 工具要权限时弹审批卡片，点允许/拒绝 | `approval/request` 瀑布 |
| **交互式提问** | Agent 提问时弹出问题卡片 | `user-questions/request` 瀑布 |
| **子 Agent** | 自动出现子会话，可展开看它做了什么 | `subagents` + `subagent/descriptor` |
| **取消任务** | 点停止 | `sessionController.cancel` |
| **会话恢复** | 重开同一个 Agent | 按原生 `session-<uuid>` 恢复 |
| **历史回放** | 打开旧 Agent | DSH `page` / `follow` |
| **流式输出** | 边生成边显示 | assistant stream 增量帧 |

### 3.4 关于权限的重要说明

- 默认是 `workspace-write`（可写工作区），**不会**自动选 `danger-full-access`。
- `danger-full-access` 只有你在 Paseo 设置里**手动选**才会生效。
- 工具需要更高权限时，会弹卡片问你，不会静默放行。

---

## 3.5 使用你自己的模型（magpie / bonsai / ninfer 等）

**为什么会缺模型**：插件用**独立 profile**（`paseo-dsh`），不继承你在 DSH 桌面版里加的第三方 provider。
所以你在 DSH 里能用的 magpie 模型，在 Paseo 里默认看不到。DSH 内置的 `deepseek-official` / `deepseek-account`
不受影响，一直在。

**默认行为**：`install.sh` 会自动从 `desktop` profile 继承 `llm-pi-ai` 的 provider 配置。

```bash
# 手动同步（指定来源 profile）
node scripts/sync-llm-config.mjs --source=desktop --target=paseo-dsh

# 换来源
node scripts/sync-llm-config.mjs --source=web

# 不要继承
DSH_PASEO_LLM_SOURCE=none bash scripts/install.sh
```

**只继承 providers，不改默认模型**：`agent-default-model` 刻意不同步，因此 Paseo 默认永远是官方
`deepseek-official/deepseek-flash`。继承来的模型可选但不会变成隐式默认。

**安全边界**：

- 只写 `~/.dsh/profiles/paseo-dsh/`，源 profile 只读；
- 拒绝写入 `web` / `desktop` / `headless`；
- 重复执行只替换托管块，不会重复追加；
- 源 profile 不存在或无 provider 时跳过并提示，不会破坏目标文件。

**模型 id 含斜杠**：DSH 的模型 id 本身可能带斜杠（如 `magpie/workbuddy/glm-5.3`），
插件按真实目录反查 provider/model 边界，不会错切成 `magpie` + `workbuddy`。

## 4. 会话与历史

- 每个 Paseo Agent 对应一个真实的 DSH 会话 `session-<uuid>`。
- 这个原生 ID 会被保存，重开时**恢复同一个会话**，不会新开一个。
- 因此 Paseo 里产生的对话，在 DSH 自己的 Web/CLI 里也能看到；反之亦然（同一个 `~/.dsh`）。

> 注意：如果某个会话正被 DSH 桌面端占用，Paseo 再打开会得到 `session/writer-held` 错误。
> 这是 DSH 的保护机制（避免两个进程同时写同一份日志），不是插件缺陷。

---

## 5. 升级

```bash
cd paseo-provider-dsh
git pull                  # 或重新拿到新版本
node scripts/build.mjs
bash scripts/install.sh   # 可重复执行，不会重复添加条目
paseo plugin reload paseo-provider-dsh
```

`install.sh` 是幂等的：已存在的 bridge 条目会跳过，插件配置不会重复。

---

## 6. 卸载与回滚

### 6.1 卸载

```bash
bash scripts/uninstall.sh
paseo reload
```

卸载会：

- 从 `~/.paseo/config.json` 移除本插件（并备份）
- 从 DSH profile 移除 bridge 包与 patch 条目（优先用备份精确还原）
- **不删除任何会话历史**

如需连专用 profile 一起删（不影响会话）：

```bash
bash scripts/uninstall.sh --purge-profile
```

### 6.2 回滚到安装前状态

```bash
bash scripts/rollback.sh --list                 # 看安装时留下的备份
bash scripts/rollback.sh --restore <备份文件>    # 还原单个文件
bash scripts/rollback.sh                        # 等价于卸载
```

所有被修改的文件在改动前都做了带时间戳的备份，因此回滚是精确还原，不是重新拼。

---

## 7. 远程 SSH 主机

Paseo Remote SSH 是指 daemon 跑在远端机器上。本插件天然支持：

- Provider 启动的 `dsh` 是 **daemon 所在机器的本地子进程**；
- 两者通过 **Unix socket** 通信，**不占端口、不需要端口转发**。

操作步骤：

1. 在远端机器安装 DSH：`npm install -g @deepseek-ai/dsh`
2. 在远端机器执行 `bash scripts/install.sh`
3. 如果 `dsh` 不在 daemon 的 PATH 上，在 Paseo 的 Provider 配置里指定命令：

```json
{
  "agents": {
    "providers": {
      "dsh": {
        "enabled": true,
        "command": ["/opt/node/bin/dsh"],
        "env": { "DSH_HOME": "/home/you/.dsh" }
      }
    }
  }
}
```

改完执行 `paseo reload`。

---

## 8. 常见问题排查

先跑 `node scripts/doctor.mjs`，它会直接告诉你哪一环断了。

| 现象 | 原因 | 解决 |
|---|---|---|
| `plugin ls` 显示 `disabled` | 插件总开关没开 | `pluginsEnabled` 设为 true，或 `install.sh --enable-plugins` |
| `plugin ls` 显示 `failed` | 插件编译/加载出错 | `paseo plugin logs paseo-provider-dsh` 看具体报错 |
| Provider 显示不可用 | `dsh` 找不到或版本不符 | `doctor` 会显示 `dsh --version` 结果 |
| 第一次对话报 `host-start` | DSH 启动失败 | 错误里会带 DSH 的 stderr，按提示修 |
| `socket path is too long` | `~/.dsh` 路径太深 | 换短路径，或依赖自动回退到临时目录 |
| `session/writer-held` | 会话被别的 DSH 进程占用 | 先在桌面端关掉该会话 |
| 审阅卡片不出现 | 该操作本来就不需要审批 | 只有真正需要权限的工具才弹卡片 |
| 界面里没有 DeepSeek Harness | 插件没 `running`，或没连对 host | `paseo plugin ls` + 确认 host 选择 |

查看日志：

```bash
paseo plugin logs paseo-provider-dsh      # 插件侧日志
grep -i "paseo-bridge" ~/.paseo/daemon.log # 桥接侧日志
```

---

## 9. 已知限制

以下是明确没做或只做了一部分的功能，**不会以假象呈现**：

| 限制 | 说明 |
|---|---|
| 文件级回滚 | DSH 无此能力，请求会明确返回不支持 |
| 会话归档 | DSH 无原生归档标记，会明确返回不支持 |
| 每会话 MCP 注入 | DSH 在 profile 层绑定 MCP，会话期无法新增 |
| 图片输入 | 能力未开放（未做端到端验证） |
| 用量/成本显示 | 尚未接通 DSH 的 token 统计 |
| 附加到已运行的 DSH 宿主 | 默认自建专用宿主，不抢占你桌面上正在跑的实例 |
| Windows | 未支持（仅 macOS / Ubuntu / Remote SSH） |

完整说明见 [`LIMITATIONS.md`](LIMITATIONS.md)。

---

## 10. 验证本插件是否真的在工作

```bash
# 单元与契约测试
npm test

# 真实 DSH 集成测试（10 个场景，使用临时 DSH_HOME，不碰你的真实数据）
node scripts/e2e/run.mjs
```

集成测试覆盖：模型目录、真实对话、Plan 模式、思考强度、权限预设、会话持久化恢复、
会话列表、取消、子 Agent、审批通道。

实测结果记录在 [`ACCEPTANCE.md`](ACCEPTANCE.md)。

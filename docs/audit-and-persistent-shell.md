# 第二阶段：审计落盘 + 单机持久 shell

> 状态：已实现，已端到端验证（见 [verification.md](./verification.md)）
> 范围：仅单机模式。多服务器 / 工作区模型明确不在本轮。
> 日期：2026-11-05
>
> **2026-11-05 架构调整：AIShell 改为 record-only。** 产品定位是「远程访问通道 + 操作记录」，
> 危险操作由 agent 自身的策略负责，AIShell 不拦截、不询问。审批层（ApprovalManager /
> ApprovalDialog / 审批策略）与 `mkdir` / `rename` / `delete` / `chmod` 四个工具已移除。
> 本文中涉及审批的段落保留为历史设计记录；当前行为以 [§2 审计落盘](#2-审计落盘) 和
> 代码为准。本地 `ssh` / `scp` / `sftp` 由 Claude Code 的 PreToolUse hook 补记（见 §7）。

---

## 1. 目标与非目标

### 1.1 目标

1. **Agent 对服务器的操作可事后复查**。机器崩了、会话断了、进程被杀了，仍能回答「在什么时间，往哪台机器上，发了什么命令，结果如何」。
2. **Agent 能做需要状态和流式的操作**。保持工作目录、环境变量、提权上下文；能跑长任务、看持续输出。

### 1.2 非目标

| 不做 | 原因 |
|---|---|
| 多服务器 / 工作区模型 | 本轮明确搁置 |
| 内置 AI 对话面板 | 违背产品定位（见 [[aishell-agent-strategy]]） |
| 命令片段、本地 Shell 标签、端口转发 | 与主线无耦合，后续独立插入 |
| 完整拦截 Agent 绕过 MCP 直接 `ssh` | 见 §7 风险，只能降低不能消除 |
| 多 Agent 并存 + 审批队列 | 下一轮，依赖面更大 |

---

## 2. 审计落盘

### 2.1 为什么必须先做

原来的 [activity.ts](../src/main/mcp/activity.ts) 是纯内存 `MAX_EVENTS = 500`，重启清空；而且事件是「先 `start`、跑完再 `update`」，所以：

- 服务器在命令执行中崩溃 → 那条记录停在 `running`，随进程一起消失
- 事后复盘 → 只剩「Agent 干过事」，查不到具体内容

崩机场景恰恰是「命令还在跑、机器先没了」（OOM、磁盘写满、进程数爆掉、kill 错进程）。**只在完成后写日志的设计，对定责无效。** 因此审计的核心是「写前记录」。

### 2.2 存储

文件：`<userData>/audit/<YYYY-MM-DD>.jsonl`（Windows 为 `%APPDATA%/aishell/audit/`），按本地日滚动，append-only。

每次工具调用写成独立的多条记录，用同一个 `id` 关联：

```jsonc
// intent —— 执行（或弹审批）之前同步写入；会改动服务器的调用同步 fsync
{"v":1,"type":"intent","id":"a1b2","ts":1762300000123,
 "sessionId":"s-web01","sessionName":"web-01","host":"10.0.1.11:22","username":"deploy",
 "agentSessionId":"A9","profileId":"claude","tool":"exec",
 "args":{"command":"systemctl restart nginx"},"approval":"required","dangerous":true}

// decision —— 需要审批时，用户的选择
{"v":1,"type":"decision","id":"a1b2","ts":1762300000500,"decision":"allow"}   // allow | always | deny | timeout | cancelled

// result —— 完成后追加（成功或失败都写）
{"v":1,"type":"result","id":"a1b2","ts":1762300001500,"status":"error","durationMs":1377,
 "exitCode":1,"output":{"stdout":"…截断后的输出…","stderr":"…","stdoutBytes":2048,"stdoutSha256":"…"},
 "error":"…"}

// note —— 非工具调用的事实：快照 / Agent 生命周期 / 持久 shell 开关
{"v":1,"type":"note","id":"a1b4","kind":"snapshot","ts":…,"sessionId":"s-web01",
 "action":"agent_launch","payload":{"load":[…],"cpus":8,"memUsedPct":87,"swapUsedPct":64,
                                    "disks":[{"mount":"/","usePct":96}],"procCount":312}}
```

设计要点：

- **「有 intent 无 result」就是崩溃或强断的现场**。查询时这类记录显示为 `unfinished`（未完成），见 §2.4。
- **`intent` 同步写**。异步写会丢最后几条，那恰好是最关键的。只读工具不 fsync，会改服务器的工具 fsync。
- **写失败则拒绝执行**：`intent` 写不进去时工具直接报错「审计日志写入失败，已拒绝执行」，不让未审计的操作上服务器。
- **输出只存截断后的内容 + 字节数 + sha256**，不存全文，避免日志撑爆磁盘。
- **`sessionName` / `host` 冗余落盘**。会话日后被删或改名，记录仍可读。
- **`agentSessionId` / `profileId` 落在每条记录上**，区分是谁干的。

### 2.3 写入时机

[tools.ts](../src/main/mcp/tools.ts) 的 `call()` 流程：

```
1. 解析 session/tool/args
2. 判定 needsApproval / dangerous / 跨会话
3. ★ 写 intent（同步；改动服务器的调用 fsync）     ← 在审批之前
4. 若需审批：先抓快照（危险命令），再弹窗；拒绝/timeout/cancelled → 写 decision 并返回
5. 执行 handler
6. ★ 写 result（追加）
7. 更新内存 ActivityLog（供 UI 实时显示）
```

第 3 步放在审批**之前**，因为「用户批准了这条危险命令」本身也是需要留证的事实。

### 2.4 崩溃检测（`unfinished`）

重启后应用无法知道上一条 intent 是否还活着，规则是：

- intent 在**更早的文件**里（跨天）→ 当作已死；
- intent 在今天、但没有 result，且已过 `CRASH_GRACE_MS = 60 s` → 当作已死；
- 例外：本进程刚写、还没等到 result 的 intent（`AuditStore.pending` 中且在本次扫描位置之后）→ 仍算 `running`。

不用文件 mtime 判断——追加写会刷新 mtime，重启与否都会让它失真。查看历史时这类记录标为「未完成」并有醒目提示。

### 2.5 读取与导出

IPC（[ipc.ts](../src/main/ipc.ts)）：

| 通道 | 说明 |
|---|---|
| `audit:query(AuditQuery)` | `{ from, to, sessionId?, status?, text?, limit? }`，`from`/`to` 为 `YYYY-MM-DD` 本地日期；返回 `{ entries, hasMore }`，即组装好的调用与 note，按时间倒序 |
| `audit:info()` | 目录、总大小、文件数、留存天数、是否超阈值 |
| `audit:today()` | 今天的日期键（UI 用来初始化筛选） |
| `audit:openDir()` | 在文件管理器中打开审计目录 |
| `audit:export(query, 'jsonl' \| 'csv')` | 另存为；CSV 带 UTF-8 BOM（Excel 正确显示中文），单元格转义公式前缀 |

UI：现有活动流保持实时视图；「审计记录」是独立弹窗（[AuditDialog.tsx](../src/renderer/src/components/AuditDialog.tsx)），入口在 Agent 面板和设置页。支持日期范围、会话（含「已删除的会话」）、状态、全文搜索，展开看完整参数与输出。**不复用活动流的组件**——实时流是「看一眼」，历史是「查」，交互不同。

### 2.6 留存与脱敏

- 默认保留 **90 天**，启动时和修改设置时清理过期文件；今天的文件永不清。
- 设置项 `auditRetentionDays`（30 / 90 / 180 / 永久）。
- 目录总大小超过 200 MB 时在设置页告警，不自动删——删证据要人决定。
- **写入前脱敏**（[redact.ts](../src/main/audit/redact.ts)）：`mysql -pXXX`、`--password=`、`sshpass -p`、`token=`、Bearer 等模式替换为 `***`；参数、摘要、错误、快照内容全覆盖。

---

## 3. 单机持久 shell

### 3.1 问题

`exec` 每次都是全新 `client.exec()`（[SshManager.ts](../src/main/ssh/SshManager.ts)）：`cwd` 靠拼 `cd x && cmd`，输出攒齐才返回，上限 64 KB，超时封顶 600 s。做不了：

- `source .venv/bin/activate` 之后的连续操作
- `cd` 之后反复操作相对路径
- 编译、`docker build`、`rsync` 这类长任务
- `journalctl -f`、`tail -f` 这类持续输出

### 3.2 方案：独立于用户终端的 Agent shell

`SshManager` 的 `Runtime` 带 `agentShell`，**与用户终端用的 shell 完全独立**（否则 Agent 的输出会污染用户屏幕）。实现见 [AgentShell.ts](../src/main/ssh/AgentShell.ts)。

MCP 工具（[tools.ts](../src/main/mcp/tools.ts)）：

| 工具 | 参数 | 说明 |
|---|---|---|
| `shell_open` | `{ session_id }` | 打开持久 shell（record-only 后不审批）；已打开则复用 |
| `shell_run` | `{ command, timeout_sec?, session_id? }` | 执行，返回输出、退出码、之后的 `cwd`。超时**不杀命令**，返回 `running=true` |
| `shell_read` | `{ timeout_sec?, session_id? }` | 等待仍在运行的命令，返回自上次读取以来的新输出 |
| `shell_interrupt` | `{ session_id? }` | 发送 Ctrl+C，返回剩余输出 |
| `shell_close` | `{ session_id? }` | 关闭；会话断开、空闲 30 分钟、应用退出时自动关闭 |

### 3.3 完成判定：随机哨兵，不解析提示符

不靠正则匹配 `$` / `#` 提示符（不同 shell、主题、`PS1` 都会变，必然脆）。命令之后追加一行：

```sh
printf '\n__AIE_%s_%s:%s:%s__\n' <nonce> <seq> "$?" "$PWD"
```

`nonce` 每次打开 shell 随机生成，`seq` 递增，两者都作为参数传入——即便命令行被回显也不会误匹配；过期序号的哨兵在清理阶段剥掉。

- 不依赖提示符格式，bash / zsh / sh 通用
- 哨兵带退出码和 `$PWD`，一次往返就拿到「结束 / 退出码 / 新工作目录」
- 输出按块流式收集（最多保留 512 KB 待读），每次读取再截到 64 KB
- 打开时执行初始化脚本：`stty -echo -onlcr`、清空 `PS1`、禁用分页器与历史——回显、换行转换和压缩包的进度条都不会混进输出

已知不支持的：需要 stdin 交互的命令（`vim`、`less`、`top`、`sudo` 密码输入）。交互式程序在发出前就被拒绝并给出替代方案（`cat` / `tail` 代替 `less`，`top -bn1` 代替 `top`，编辑用 `write_file`）。Ctrl+C 中断会重新发哨兵（Ctrl+C 会清掉终端里预输入的内容，可能包括原哨兵）。

### 3.4 审批语义（历史设计）

> 2026-11-05 起 AIShell 改为 record-only，审批层已移除。本节保留为设计记录。

明确原则：**持久 shell 不绕过审批，只改变「在哪里执行」。**

| 操作 | 审批 |
|---|---|
| `shell_open` | 必须审批（每会话一次，没有「始终允许」按钮）；关闭/断开后需重新授权 |
| `shell_run` 内执行的命令 | 仍走 `isDangerousCommand` 检查；命中则审批 |
| 普通命令 | 按现有 `approvalPolicy`，不改 |

透明度：

- shell 打开期间，Agent 面板顶部常驻标识「持久 shell 已开启 · <会话>」，可一键关闭
- 每条 `shell_run` / `shell_read` / `shell_interrupt` 都是独立审计记录（`tool: "shell_run"` 等）
- shell 打开/关闭本身记 `note kind=shell`（含原因：agent / disconnect / idle / app_quit / closed）

### 3.5 安全边界

- 一个会话最多一个 Agent shell（避免状态混乱）。
- 单行命令超过 4000 字节直接拒绝——tty 规范模式会静默截断输入，改用 `write_file` + 执行脚本。
- 会话断开 → 自动关闭并记审计；空闲 30 分钟自动关闭。
- 输出仍受 64 KB 上限保护，超出部分标记 `truncated`。

### 3.6 上下文文件

Agent 工作区的 `CLAUDE.md` / `AGENTS.md` 写明：何时用 `exec`、何时用 `shell_run`；「先 `shell_open`，再 `shell_run`，退出时 `shell_close`」；交互式命令的限制与替代方案。避免 Agent 每次操作都重开 shell 或卡在交互式程序上。

---

## 4. 涉及文件

| 文件 | 内容 |
|---|---|
| `src/main/audit/AuditStore.ts` | JSONL 读写、按天滚动、崩溃检测、留存清理、JSONL/CSV 导出 |
| `src/main/audit/redact.ts` | 密码/token 脱敏 |
| `src/main/audit/snapshot.ts` | 快照采集（load / 内存 / 交换 / 磁盘 / 进程数 / 核数） |
| `src/main/mcp/tools.ts` | `call()` 写 intent/decision/result；5 个 shell 工具 |
| `src/main/ssh/AgentShell.ts` | 哨兵协议、超时/读取/中断、空闲关闭 |
| `src/main/ssh/SshManager.ts` | `Runtime.agentShell`；`openAgentShell` / `getAgentShell` / `hasAgentShell` / `closeAgentShell` |
| `src/main/ipc.ts` | `audit:*` 通道 |
| `src/main/index.ts` | 装配 `AuditStore`、shell 状态 note |
| `src/shared/types.ts` | `AuditCall` / `AuditNote` / `AuditQuery` / `AuditInfo` |
| `src/renderer/.../AuditDialog.tsx` | 审计查询 / 详情 / 导出弹窗 |
| `src/renderer/.../AgentPanel.tsx` | shell 状态标识、审计入口 |
| `src/renderer/.../SettingsDialog.tsx` | 留存天数、审计目录大小、打开目录 / 查看审计 |
| `tests/test-audit-store.mts` | `AuditStore` 单测（不启动 Electron） |
| `tests/test-agent-shell*.mts` | `AgentShell` 哨兵协议测试（mock SSH + 本地 bash） |
| `scripts/mcp-smoke.mjs` | MCP 冒烟（含 shell 模式与审计断言） |

---

## 5. 实施顺序

| 步骤 | 内容 | 状态 |
|---|---|---|
| S1 | `AuditStore` + `call()` 写 intent/decision/result | 完成 |
| S2 | 崩前快照 + 留存清理 + 设置项 + 脱敏 | 完成 |
| S3 | `audit:*` IPC + 审计记录弹窗 | 完成 |
| S4 | `SshManager` 的 Agent shell 通道 | 完成 |
| S5 | 5 个 MCP 工具 + 审批 + 审计接入 | 完成 |
| S6 | UI 标识 + 上下文说明 + 冒烟测试 | 完成 |

---

## 6. 验收清单

### 审计

| # | 检查项 | 状态 |
|---|---|---|
| A1 | 正常 `exec` 产生成对的 intent + result，`id` 一致 | 通过 |
| A2 | 命令执行中强制结束应用，重启后记录显示「未完成」 | 通过（杀掉应用时 `sleep 240` 仍在跑） |
| A3 | 用户拒绝审批时写 decision，记录显示「被拒绝」 | 通过 |
| A4 | 记录含 `agentSessionId` / `profileId` / `sessionName` / `host` | 通过 |
| A5 | 大输出只存截断内容 + 哈希 + 字节数，文件体积可控 | 通过（`clipOutput`） |
| A6 | 按日期、会话、状态、文本筛选正确 | 通过 |
| A7 | 导出文件每行合法 JSON，可被 `jq` 解析；CSV 带 BOM | 通过（单测覆盖） |
| A8 | 超过留存期的文件启动时被清理；设置项生效 | 通过（单测覆盖） |
| A9 | 会话被删除后，历史记录仍能显示原主机名 | 通过 |

### 持久 shell

| # | 检查项 | 状态 |
|---|---|---|
| B1 | `shell_open` 需审批；拒绝后不创建 | 通过 |
| B2 | 连续两次 `shell_run`，第二次能看到第一次的 `cd` 结果 | 通过 |
| B3 | 环境变量（`export FOO=1`）跨调用保持 | 通过 |
| B4 | 退出码正确传递（0 / 非 0） | 通过 |
| B5 | 长任务超时返回已收输出并标记 `running`，shell 未被杀；`shell_read` 能继续读 | 通过 |
| B6 | 交互式命令（`vim`）返回明确提示，不挂死 | 通过 |
| B7 | 危险命令在 shell 内仍触发审批 | 通过 |
| B8 | 会话断开时 shell 自动关闭并记审计 | 通过 |
| B9 | 空闲超时自动关闭 | 通过（单元测试） |
| B10 | 用户终端的输出与 Agent shell 互不干扰 | 通过 |
| B11 | 面板显示 shell 状态，可一键关闭 | 通过 |

---

## 7. 风险与已知限制

| 风险 | 应对 |
|---|---|
| **Agent 绕过 MCP 直接 `ssh`** | 当前仅靠 `CLAUDE.md` 约束，不可验证。本轮**不宣称解决**；对外措辞必须是「通过 AIShell 的操作有完整审计」，不是「完整审计」 |
| intent 同步写可能拖慢高频调用 | 只同步写 intent（小 JSON）且只读工具不 fsync；实测未见明显延迟 |
| 哨兵字符串被命令输出污染 | nonce 随机 + seq 递增 + 只认当前 seq；过期哨兵在清理阶段剥离 |
| shell 内 `sudo` 密码交互 | 不支持，返回提示；后续可考虑 `sudo -S` 显式传密码（需单独评审） |
| 审计文件包含敏感命令参数 | 写入前脱敏（见 §2.6）；但脱敏是模式匹配，不保证覆盖所有写法 |
| 磁盘被审计日志本身写满 | 输出截断 + 留存清理 + 超阈值告警 |
| 首日重启边界 | 跨天的 intent 一律标未完成；当天 60 s 内退出会短暂显示为 `running`，超过宽限期后刷新即正确 |

---

## 8. 已确认的决定（2026-11-05）

1. **脱敏**：做。写入前对密码类参数（`-p<pwd>`、`--password=`、`token=` 等）脱敏。
2. **留存期**：默认 90 天，可在设置中调整。
3. **`shell_open` 授权粒度**：本会话授权一次；会话断开或 shell 关闭后需重新授权。
4. **历史记录入口**：独立弹窗。

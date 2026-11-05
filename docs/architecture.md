# 架构总览

AIShell 是一个 Electron 桌面应用：本机终端里的 CLI Agent（Claude Code / Codex / 自定义）通过 AIShell 内置的 MCP Server 操作当前 SSH 连接，所有调用在执行前写入本机审计日志。

## 1. 进程与模块

```mermaid
flowchart LR
  subgraph Local["本机"]
    subgraph Renderer["Renderer（React）"]
      UI["会话栏 · 终端 · 文件面板 · Agent 面板 · 审计弹窗"]
    end
    subgraph Main["Main process"]
      IPC["IPC 白名单"]
      SSHM["SshManager<br/>SSH + SFTP"]
      PTY["PtyManager"]
      AG["AgentManager"]
      MCP["McpServer<br/>127.0.0.1 + Bearer Token"]
      TOOLS["ToolRegistry<br/>11 个 MCP 工具"]
      AUD["AuditStore<br/>JSONL"]
      STORE["SessionStore<br/>会话 / 设置 / 凭据"]
    end
    AGENT["Claude Code / Codex / 自定义 CLI"]
  end

  SERVER[("远程服务器")]

  UI <-->|"contextBridge / IPC"| IPC
  IPC --> SSHM
  IPC --> AG
  IPC --> STORE
  IPC --> AUD
  SSHM <-->|"ssh2"| SERVER
  AG -->|"spawn PTY"| AGENT
  AGENT -->|"MCP JSON-RPC"| MCP
  MCP --> TOOLS
  TOOLS --> SSHM
  TOOLS --> AUD
  PTY <--> AGENT
```

| 模块 | 职责 | 位置 |
|---|---|---|
| `SessionStore` | 会话、分组、设置、已知主机、凭据加密 | [src/main/store/SessionStore.ts](../src/main/store/SessionStore.ts) |
| `SshManager` | 连接、exec、SFTP、主机信息、Agent 持久 shell | [src/main/ssh/SshManager.ts](../src/main/ssh/SshManager.ts) |
| `AgentShell` | 独立于用户终端的持久 shell，随机哨兵判定命令结束 | [src/main/ssh/AgentShell.ts](../src/main/ssh/AgentShell.ts) |
| `PtyManager` | 本机伪终端：用户终端与 Agent 进程共用 | [src/main/pty/PtyManager.ts](../src/main/pty/PtyManager.ts) |
| `AgentManager` | 生成工作区、MCP 配置、启动脚本，管理 Agent 生命周期 | [src/main/agents/AgentManager.ts](../src/main/agents/AgentManager.ts) |
| `McpServer` | HTTP JSON-RPC、Token 校验、会话作用域、MCP 握手 | [src/main/mcp/server.ts](../src/main/mcp/server.ts) |
| `ToolRegistry` | 工具定义、执行、审计 intent/result、活动流 | [src/main/mcp/tools.ts](../src/main/mcp/tools.ts) |
| `AuditStore` | 按天 JSONL、崩溃检测、脱敏、留存清理、导出 | [src/main/audit/AuditStore.ts](../src/main/audit/AuditStore.ts) |
| Renderer | React 19 + Zustand + xterm.js + CodeMirror | [src/renderer/](../src/renderer/) |

## 2. 一次 MCP 调用的路径

```mermaid
sequenceDiagram
  participant A as CLI Agent
  participant M as McpServer
  participant T as ToolRegistry
  participant S as SshManager
  participant D as AuditStore
  participant U as Renderer

  A->>M: POST /mcp/<sessionId> (Bearer Token)
  M->>M: 校验 Token 与会话作用域
  M->>T: call(tool, args, scope)
  T->>D: 同步写 intent（改动服务器的调用 fsync）
  T->>U: activity:event（running）
  T->>S: 执行 exec / write_file / ...
  S-->>T: 结果
  T->>D: 写 result（状态、耗时、截断输出）
  T->>U: activity:event（success / error）
  T-->>A: MCP 结果
```

关键点：

- **intent 先于执行**。即使命令执行中应用或服务器崩溃，事后仍能知道「发出了什么」；有 intent 无 result 的记录显示为「未完成」。
- **写失败则拒绝执行**。审计日志写不进去时，工具直接报错，不让未审计的操作上服务器。
- **AIShell 不拦截命令**。危险操作只打标签（`dangerous`）并记入审计，是否执行由 Agent 自身的策略决定。
- **活动流与审计分离**。活动流是内存中的实时视图；审计是磁盘上的历史记录，两者查询方式不同。

## 3. Agent 启动

启动 Agent 时，`AgentManager` 在 `userData/workspaces/<sessionId>/` 下生成工作区：

```
CLAUDE.md / AGENTS.md        远程服务器上下文、工具使用规则
.aishell/
  claude-mcp.json            Claude Code 的 MCP 配置（含本次运行的 Token）
  session.json               会话元数据
  README.md                  自定义 Agent 接入说明
  launch-<id>.cmd / .sh      PTY 启动脚本
.claude/settings.json        PreToolUse hook：记录本机 ssh/scp/sftp（Claude Code）
.codex/                      隔离的 CODEX_HOME 与 MCP 配置（Codex）
```

- **Claude Code**：`claude --mcp-config .aishell/claude-mcp.json`，可选 `--strict-mcp-config`。
- **Codex**：独立 `CODEX_HOME`，写入 `[mcp_servers.aishell]`，Token 由 `AISHELL_MCP_TOKEN` 传入。
- **自定义 Agent**：注入 `AISHELL_MCP_URL` / `AISHELL_MCP_TOKEN` / `AISHELL_SESSION_ID` / `AISHELL_WORKSPACE`。

Agent 运行在本机 PTY 中，不经过模型 API；AIShell 只负责进程、工作区和 MCP 通道。

## 4. 持久 shell

`exec` 每次都是新的 SSH 通道，不保留 `cd` / `export`。需要连续状态或长任务时，Agent 使用每个会话独立的持久 shell：

- 与用户终端**完全独立**，避免输出互相污染。
- 命令结束后追加随机哨兵（nonce + seq），不解析提示符，一次往返拿到退出码与 `$PWD`。
- 超时不杀命令，返回 `running=true`；`shell_read` 继续读取，`shell_interrupt` 发送 Ctrl+C。
- 不支持 `vim` / `less` / `top` 等交互式程序，发出前拒绝并给出替代方案。

完整设计见 [audit-and-persistent-shell.md](./audit-and-persistent-shell.md)。

## 5. 安全边界

| 边界 | 实现 |
|---|---|
| MCP 仅本机可访问 | 监听 `127.0.0.1` 随机端口 |
| 调用认证 | 每次启动随机生成 32 字节 Bearer Token |
| 会话隔离 | URL 绑定 `<sessionId>`；跨会话调用会在审计中标记 |
| 凭据 | `safeStorage`（Windows DPAPI）加密密码与私钥口令；不可用时仅内存保存 |
| 主机验证 | 首次连接记录 SHA256 指纹（TOFU），后续变化拒绝连接 |
| 审计脱敏 | `-pXXX`、`--password=`、`token=`、Bearer 等模式落盘前替换为 `***` |
| 下载落点 | MCP `download` 只能写入 Agent 工作区或系统下载目录 |

**不承诺的部分**：Agent 可以绕过 MCP，在本机直接执行 `ssh` / `scp` / `sftp`。Claude Code 的 PreToolUse hook 会把这类命令补记为 `bash` note，但这依赖 Agent 类型，且只能记录、不能阻止。详见 [audit-and-persistent-shell.md §7](./audit-and-persistent-shell.md#7-风险与已知限制)。

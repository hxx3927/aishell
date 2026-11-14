import { Bug, FolderOpen } from 'lucide-react'
import { useAppStore } from '../../state/store'

export function AboutSection(): React.JSX.Element {
  const versions = useAppStore((s) => s.versions)
  const mcpPort = useAppStore((s) => s.mcpPort)
  const userDataPath = useAppStore((s) => s.userDataPath)
  const platform = useAppStore((s) => s.platform)
  const pushToast = useAppStore((s) => s.pushToast)

  return (
    <div className="space-y-3 text-[11px] text-dim">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/15 text-lg font-bold text-accent">
          A
        </div>
        <div>
          <div className="text-sm font-semibold text-ink">AIShell</div>
          <div className="text-[10px] text-faint">AI-native SSH workbench</div>
        </div>
      </div>
      <dl className="grid grid-cols-[120px_1fr] gap-y-1.5">
        <dt className="text-faint">版本</dt>
        <dd className="font-mono">{versions.app}</dd>
        <dt className="text-faint">Electron</dt>
        <dd className="font-mono">{versions.electron}</dd>
        <dt className="text-faint">Node</dt>
        <dd className="font-mono">{versions.node}</dd>
        <dt className="text-faint">平台</dt>
        <dd className="font-mono">{platform}</dd>
        <dt className="text-faint">MCP 端口</dt>
        <dd className="font-mono">{mcpPort ?? '未启动'}</dd>
        <dt className="text-faint">数据目录</dt>
        <dd className="break-all font-mono text-[10px]">{userDataPath}</dd>
      </dl>
      <div className="rounded-lg border border-line-2 bg-panel-2/50 px-3 py-2.5 leading-relaxed">
        AIShell 复用本机的 Claude Code、Codex 等 CLI Agent，通过 MCP
        把当前 SSH 会话变成 Agent 可调用的工具。不内置模型、不上传凭据。
      </div>
      <div className="flex gap-2">
        <button
          className="btn-secondary"
          onClick={() =>
            void window.aishell.shell.openDataDir().then((error) => {
              if (error) pushToast('error', `打开数据目录失败：${error}`)
            })
          }
        >
          <FolderOpen size={13} />
          打开数据目录
        </button>
        <button
          className="btn-secondary"
          onClick={() =>
            void window.aishell.shell.copyDiagnostics().then(() => {
              pushToast('info', '已复制诊断信息')
            })
          }
        >
          <Bug size={13} />
          复制诊断信息
        </button>
      </div>
    </div>
  )
}

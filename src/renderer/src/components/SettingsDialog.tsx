import {
  Cpu,
  FolderCog,
  FolderOpen,
  Info,
  Loader2,
  Lock,
  ScrollText,
  ShieldCheck,
  Terminal as TerminalIcon,
  Trash2
} from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { AgentProfile, Settings } from '@shared/types'
import { useAppStore } from '../state/store'
import { formatTime } from '../lib/format'
import { Modal } from './Modal'

type Section = 'terminal' | 'agent' | 'files' | 'security' | 'about'

const SECTIONS: Array<{ id: Section; label: string; icon: ReactNode }> = [
  { id: 'terminal', label: '终端', icon: <TerminalIcon size={13} /> },
  { id: 'agent', label: 'Agent', icon: <Cpu size={13} /> },
  { id: 'files', label: '文件', icon: <FolderCog size={13} /> },
  { id: 'security', label: '安全', icon: <ShieldCheck size={13} /> },
  { id: 'about', label: '关于', icon: <Info size={13} /> }
]

const RETENTION_OPTIONS = [
  { value: 30, label: '30 天' },
  { value: 90, label: '90 天（默认）' },
  { value: 180, label: '180 天' },
  { value: 365, label: '1 年' },
  { value: 0, label: '永久保留' }
]

export function SettingsDialog() {
  const open = useAppStore((s) => s.settingsOpen)
  const setOpen = useAppStore((s) => s.setSettingsOpen)
  const settings = useAppStore((s) => s.settings)
  const saveSettings = useAppStore((s) => s.saveSettings)
  const knownHosts = useAppStore((s) => s.knownHosts)
  const removeKnownHost = useAppStore((s) => s.removeKnownHost)
  const mcpPort = useAppStore((s) => s.mcpPort)
  const versions = useAppStore((s) => s.versions)
  const userDataPath = useAppStore((s) => s.userDataPath)
  const encryptionAvailable = useAppStore((s) => s.encryptionAvailable)
  const pushToast = useAppStore((s) => s.pushToast)
  const setAuditOpen = useAppStore((s) => s.setAuditOpen)

  const [section, setSection] = useState<Section>('terminal')
  const [draft, setDraft] = useState<Settings>(settings)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) setDraft(settings)
  }, [open, settings])

  const patch = (value: Partial<Settings>): void => {
    setDraft((prev) => ({ ...prev, ...value }))
  }

  const patchProfile = (id: string, value: Partial<AgentProfile>): void => {
    setDraft((prev) => ({
      ...prev,
      agentProfiles: prev.agentProfiles.map((profile) =>
        profile.id === id ? { ...profile, ...value } : profile
      )
    }))
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await saveSettings(draft)
      pushToast('info', '设置已保存')
      setOpen(false)
    } catch (err) {
      pushToast('error', `保存设置失败：${(err as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      title="设置"
      subtitle="更改会应用到所有会话。"
      onClose={() => setOpen(false)}
      width="max-w-3xl"
      bodyClass="p-0"
      footer={
        <>
          <button className="btn-secondary" onClick={() => setOpen(false)} disabled={saving}>
            取消
          </button>
          <button className="btn-primary" onClick={() => void save()} disabled={saving}>
            {saving && <Loader2 size={13} className="animate-spin" />}
            保存设置
          </button>
        </>
      }
    >
      <div className="flex min-h-[420px]">
        <nav className="w-[132px] shrink-0 border-r border-line bg-panel-2/40 p-2">
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              className={`mb-0.5 flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-xs transition ${
                section === item.id
                  ? 'bg-accent/10 text-accent'
                  : 'text-dim hover:bg-panel-3 hover:text-ink'
              }`}
              onClick={() => setSection(item.id)}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </nav>

        <div className="min-w-0 flex-1 px-5 py-4">
          {section === 'terminal' && (
            <div className="space-y-4">
              <div>
                <label className="label">字体</label>
                <input
                  className="input font-mono"
                  value={draft.fontFamily}
                  onChange={(event) => patch({ fontFamily: event.target.value })}
                />
                <div className="mt-1 text-[10px] text-faint">
                  建议使用等宽字体，例如 JetBrains Mono、Cascadia Code。
                </div>
              </div>
              <div>
                <label className="label">字号</label>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={10}
                    max={24}
                    value={draft.fontSize}
                    onChange={(event) => patch({ fontSize: Number(event.target.value) })}
                    className="w-56 accent-cyan-400"
                  />
                  <span className="font-mono text-xs text-ink">{draft.fontSize}px</span>
                </div>
              </div>
              <div className="rounded-lg border border-line-2 bg-panel-2/50 px-3 py-2.5 text-[11px] text-dim">
                快捷键：Ctrl+Shift+C 复制、Ctrl+Shift+V 粘贴、Ctrl+F 查找。
              </div>
            </div>
          )}

          {section === 'agent' && (
            <div className="space-y-4">
              <div className="rounded-lg border border-line-2 bg-panel-2/50 px-3 py-2.5 text-[11px] text-dim">
                AIShell 不拦截任何命令。危险操作的判断与确认由 agent 自身负责，AIShell 只记录
                agent 执行的每一步，可在「审计」中查看。
              </div>

              <label className="flex items-start gap-2 text-xs text-dim">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-cyan-400"
                  checked={Boolean(draft.claudeStrictMcp)}
                  onChange={(event) => patch({ claudeStrictMcp: event.target.checked })}
                />
                <span>
                  Claude Code 使用严格 MCP 配置
                  <span className="block text-[10px] text-faint">
                    开启后 Claude 只加载 AIShell 注入的 MCP，忽略全局 MCP 配置。
                  </span>
                </span>
              </label>

              <div>
                <label className="label">Agent 配置</label>
                <div className="space-y-2">
                  {draft.agentProfiles.map((profile) => (
                    <div
                      key={profile.id}
                      className="rounded-lg border border-line-2 bg-panel-2/60 px-3 py-2.5"
                    >
                      <div className="flex items-center gap-2">
                        <label className="flex flex-1 items-center gap-2 text-xs text-ink">
                          <input
                            type="checkbox"
                            className="accent-cyan-400"
                            checked={profile.enabled}
                            onChange={(event) =>
                              patchProfile(profile.id, { enabled: event.target.checked })
                            }
                          />
                          {profile.label}
                        </label>
                        <span className="chip">{profile.kind}</span>
                      </div>
                      <div className="mt-2 grid grid-cols-[150px_1fr] gap-2">
                        <input
                          className="input font-mono text-[11px]"
                          placeholder="命令"
                          value={profile.command}
                          onChange={(event) =>
                            patchProfile(profile.id, { command: event.target.value })
                          }
                        />
                        <input
                          className="input font-mono text-[11px]"
                          placeholder="参数，空格分隔"
                          value={(profile.args ?? []).join(' ')}
                          onChange={(event) =>
                            patchProfile(profile.id, {
                              args: event.target.value
                                .split(/\s+/)
                                .map((item) => item.trim())
                                .filter(Boolean)
                            })
                          }
                        />
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-1 text-[10px] text-faint">
                  命令使用系统 PATH 中的可执行文件；修改后对新启动的 Agent 生效。
                </div>
              </div>
            </div>
          )}

          {section === 'files' && (
            <div className="space-y-4">
              <div>
                <label className="label">本地起始目录</label>
                <div className="flex gap-2">
                  <input
                    className="input font-mono"
                    placeholder="留空则使用用户主目录"
                    value={draft.localStartPath ?? ''}
                    onChange={(event) => patch({ localStartPath: event.target.value })}
                  />
                  <button
                    className="btn-secondary shrink-0"
                    title="选择目录"
                    onClick={() =>
                      void window.aishell.dialog.pickDirectory().then((dir) => {
                        if (dir) patch({ localStartPath: dir })
                      })
                    }
                  >
                    <FolderOpen size={13} />
                    浏览
                  </button>
                </div>
                <div className="mt-1 text-[10px] text-faint">
                  文件管理左侧面板的默认目录（任意磁盘均可）；编辑器下载也使用该目录。
                </div>
              </div>
              <label className="flex items-start gap-2 text-xs text-dim">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-cyan-400"
                  checked={Boolean(draft.showHiddenFiles)}
                  onChange={(event) => patch({ showHiddenFiles: event.target.checked })}
                />
                <span>
                  显示隐藏文件
                  <span className="block text-[10px] text-faint">
                    远端始终显示全部文件；此选项作用于本地面板。
                  </span>
                </span>
              </label>
            </div>
          )}

          {section === 'security' && (
            <div className="space-y-4">
              <div
                className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-[11px] ${
                  encryptionAvailable
                    ? 'border-ok/30 bg-ok/5 text-ok'
                    : 'border-warn/30 bg-warn/5 text-warn'
                }`}
              >
                <Lock size={13} className="mt-0.5 shrink-0" />
                <span>
                  {encryptionAvailable
                    ? '密码与私钥口令使用系统安全存储（Windows DPAPI）加密后落盘。'
                    : '系统安全存储不可用，本次运行期间凭据只保存在内存中。'}
                </span>
              </div>

              <div>
                <label className="label">已知主机指纹（TOFU）</label>
                {knownHosts.length === 0 ? (
                  <div className="rounded-md border border-line-2 bg-panel-2 px-3 py-2 text-[11px] text-faint">
                    还没有记录。首次连接服务器时会自动记录指纹，之后指纹变化将被拒绝。
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-md border border-line-2">
                    {knownHosts.map((host) => (
                      <div
                        key={host.key}
                        className="flex items-center gap-2 border-b border-line px-3 py-2 last:border-b-0"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-xs text-ink">{host.key}</div>
                          <div className="truncate font-mono text-[10px] text-faint">
                            {host.fingerprint}
                          </div>
                          <div className="text-[9px] text-faint">
                            首次信任 {formatTime(host.addedAt)}
                          </div>
                        </div>
                        <button
                          className="icon-btn h-6 w-6 text-err/80 hover:text-err"
                          title="删除记录"
                          onClick={() => void removeKnownHost(host.key)}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <label className="label">审计日志保留期</label>
                <div className="flex items-center gap-2">
                  <select
                    className="input w-40"
                    value={draft.auditRetentionDays ?? 90}
                    onChange={(event) => patch({ auditRetentionDays: Number(event.target.value) })}
                  >
                    {RETENTION_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <button
                    className="btn-secondary"
                    onClick={() => {
                      setOpen(false)
                      setAuditOpen(true)
                    }}
                  >
                    <ScrollText size={13} />
                    查看审计记录
                  </button>
                </div>
                <div className="mt-1 text-[10px] text-faint">
                  Agent 的每次操作在执行前写入本机审计日志（密码、Token 等已脱敏）。超过保留期的日志在启动时删除。
                </div>
              </div>

              <div className="rounded-lg border border-line-2 bg-panel-2/50 px-3 py-2.5 text-[11px] leading-relaxed text-dim">
                MCP Server 仅监听 127.0.0.1，使用每次启动随机生成的 Bearer Token；
                每个 SSH 会话拥有独立的作用域地址。
              </div>
            </div>
          )}

          {section === 'about' && (
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
                <dt className="text-faint">MCP 端口</dt>
                <dd className="font-mono">{mcpPort ?? '未启动'}</dd>
                <dt className="text-faint">数据目录</dt>
                <dd className="break-all font-mono text-[10px]">{userDataPath}</dd>
              </dl>
              <div className="rounded-lg border border-line-2 bg-panel-2/50 px-3 py-2.5 leading-relaxed">
                AIShell 复用本机的 Claude Code、Codex 等 CLI Agent，通过 MCP
                把当前 SSH 会话变成 Agent 可调用的工具。不内置模型、不上传凭据。
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

import { KeyRound, Lock, ScrollText, Search, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { formatTime } from '../../lib/format'
import { useAppStore } from '../../state/store'
import { SettingGroup, Select } from './controls'

const RETENTION_OPTIONS = [
  { value: 30, label: '30 天' },
  { value: 90, label: '90 天（默认）' },
  { value: 180, label: '180 天' },
  { value: 365, label: '1 年' },
  { value: 0, label: '永久保留' }
]

export function SecuritySection(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const saveSettings = useAppStore((s) => s.saveSettings)
  const knownHosts = useAppStore((s) => s.knownHosts)
  const removeKnownHost = useAppStore((s) => s.removeKnownHost)
  const encryptionAvailable = useAppStore((s) => s.encryptionAvailable)
  const setAuditOpen = useAppStore((s) => s.setAuditOpen)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const [hostQuery, setHostQuery] = useState('')

  const hosts = useMemo(() => {
    const q = hostQuery.trim().toLowerCase()
    if (!q) return knownHosts
    return knownHosts.filter(
      (host) => host.key.toLowerCase().includes(q) || host.fingerprint.toLowerCase().includes(q)
    )
  }, [knownHosts, hostQuery])

  return (
    <>
      <SettingGroup title="凭据">
        <div
          className={`flex items-start gap-2 px-4 py-3 text-[11px] ${
            encryptionAvailable ? 'text-ok' : 'text-warn'
          }`}
        >
          <Lock size={13} className="mt-0.5 shrink-0" />
          <span>
            {encryptionAvailable
              ? '密码与私钥口令使用系统安全存储（Windows DPAPI）加密后落盘。'
              : '系统安全存储不可用，本次运行期间凭据只保存在内存中。'}
          </span>
        </div>
      </SettingGroup>

      <SettingGroup title="审计">
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-xs text-ink">日志保留期</div>
            <div className="mt-0.5 text-[10px] leading-relaxed text-faint">
              Agent 的每次操作在执行前写入本机审计日志（密码、Token 等已脱敏），超过保留期的日志在启动时删除。
            </div>
          </div>
          <Select
            width="w-32"
            value={settings.auditRetentionDays ?? 90}
            options={RETENTION_OPTIONS}
            onChange={(auditRetentionDays) => void saveSettings({ auditRetentionDays })}
          />
          <button
            className="btn-secondary shrink-0"
            onClick={() => {
              setSettingsOpen(false)
              setAuditOpen(true)
            }}
          >
            <ScrollText size={13} />
            查看记录
          </button>
        </div>
      </SettingGroup>

      <SettingGroup
        title={
          <span className="flex w-full items-center gap-2">
            已知主机指纹
            <span className="flex-1" />
            <span className="relative">
              <Search
                size={11}
                className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-faint"
              />
              <input
                className="input w-44 py-1 pl-6 text-[11px] normal-case tracking-normal"
                placeholder="搜索主机或指纹"
                value={hostQuery}
                onChange={(event) => setHostQuery(event.target.value)}
              />
            </span>
          </span>
        }
      >
        {hosts.length === 0 ? (
          <div className="px-4 py-3 text-[11px] text-faint">
            {knownHosts.length === 0
              ? '还没有记录。首次连接服务器时会自动记录指纹（TOFU），之后指纹变化将被拒绝。'
              : '没有匹配的主机。'}
          </div>
        ) : (
          hosts.map((host) => (
            <div key={host.key} className="flex items-center gap-2 px-4 py-2 text-[11px]">
              <KeyRound size={12} className="shrink-0 text-faint" />
              <div className="min-w-0 flex-1">
                <div className="text-xs text-ink">{host.key}</div>
                <div
                  className="truncate font-mono text-[10px] text-faint"
                  title="点击复制指纹"
                  onClick={() => void window.aishell.clipboard.writeText(host.fingerprint)}
                >
                  {host.fingerprint}
                </div>
                <div className="text-[9px] text-faint">首次信任 {formatTime(host.addedAt)}</div>
              </div>
              <button
                className="icon-btn h-6 w-6 text-err/80 hover:text-err"
                title="删除记录（下次连接会重新信任）"
                onClick={() => void removeKnownHost(host.key)}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))
        )}
      </SettingGroup>

      <SettingGroup title="MCP Server">
        <div className="px-4 py-3 text-[11px] leading-relaxed text-dim">
          MCP Server 仅监听 127.0.0.1，使用每次启动随机生成的 Bearer Token；每个 SSH
          会话拥有独立的作用域地址，Agent 只能操作它正在使用的那台服务器。
        </div>
      </SettingGroup>
    </>
  )
}

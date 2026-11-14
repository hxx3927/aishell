import { Check, FolderOpen, Loader2, Plus, RefreshCw, TriangleAlert, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { AgentProfile, AgentProbeResult } from '@shared/types'
import { useAppStore } from '../../state/store'
import { Toggle } from './controls'
import type { RowContext } from './rows'

const BUILTIN_IDS = new Set(['claude', 'codex'])

/**
 * Agent profiles live in an array, so they cannot go through the key-based
 * settings registry; this section renders them as cards with a live probe.
 */
export function AgentSection({ ctx }: { ctx: RowContext }): React.JSX.Element {
  const { settings, update } = ctx
  const pushToast = useAppStore((s) => s.pushToast)
  const [probes, setProbes] = useState<Record<string, AgentProbeResult | 'loading'>>({})

  const probe = (profile: AgentProfile): void => {
    if (!profile.command.trim()) {
      setProbes((prev) => ({ ...prev, [profile.id]: { command: '', found: false } }))
      return
    }
    setProbes((prev) => ({ ...prev, [profile.id]: 'loading' }))
    void window.aishell.agent
      .probe(profile.command)
      .then((result) => setProbes((prev) => ({ ...prev, [profile.id]: result })))
      .catch(() => setProbes((prev) => ({ ...prev, [profile.id]: { command: profile.command, found: false } })))
  }

  // Probe once when the section opens; the command field's blur refreshes it.
  const commandKey = settings.agentProfiles.map((profile) => profile.command).join('\u0000')
  useEffect(() => {
    for (const profile of useAppStore.getState().settings.agentProfiles) probe(profile)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commandKey])

  const setProfiles = (agentProfiles: AgentProfile[]): void => update({ agentProfiles })

  const patchProfile = (id: string, patch: Partial<AgentProfile>): void => {
    setProfiles(settings.agentProfiles.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  }

  const addProfile = (): void => {
    const id = `custom-${Date.now().toString(36)}`
    setProfiles([
      ...settings.agentProfiles,
      { id, label: '新 Agent', command: '', args: [], kind: 'custom', enabled: true }
    ])
  }

  const removeProfile = (id: string): void => {
    setProfiles(settings.agentProfiles.filter((p) => p.id !== id))
  }

  return (
    <section className="mb-4">
      <div className="mb-1.5 flex items-center justify-between px-1">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-dim">
          Agent 程序
        </div>
        <button className="btn-secondary py-1 text-[11px]" onClick={addProfile}>
          <Plus size={12} />
          添加自定义 Agent
        </button>
      </div>
      <div className="space-y-2">
        {settings.agentProfiles.map((profile) => {
          const state = probes[profile.id]
          return (
            <div key={profile.id} className="rounded-xl border border-line-2 bg-panel-2/50 p-3">
              <div className="flex items-center gap-2">
                <Toggle
                  checked={profile.enabled}
                  label={`启用 ${profile.label}`}
                  onChange={(enabled) => patchProfile(profile.id, { enabled })}
                />
                <input
                  className="w-36 rounded-md border border-transparent bg-transparent px-1 py-0.5 text-xs font-medium text-ink outline-none transition hover:border-line-2 focus:border-accent/60 focus:bg-field"
                  value={profile.label}
                  onChange={(event) => patchProfile(profile.id, { label: event.target.value })}
                />
                <span className="chip">{profile.kind}</span>
                <div className="ml-auto flex items-center gap-1">
                  <ProbeBadge state={state} />
                  <button
                    className="icon-btn h-6 w-6"
                    title="重新检测"
                    onClick={() => probe(profile)}
                  >
                    <RefreshCw size={12} />
                  </button>
                  {!BUILTIN_IDS.has(profile.id) && (
                    <button
                      className="icon-btn h-6 w-6 text-err/80 hover:text-err"
                      title="删除"
                      onClick={() => removeProfile(profile.id)}
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              </div>

              <div className="mt-2 grid grid-cols-[72px_1fr] items-center gap-x-2 gap-y-1.5">
                <span className="text-[10px] text-faint">命令</span>
                <input
                  className="input font-mono text-[11px]"
                  placeholder="PATH 中的可执行文件，例如 claude"
                  value={profile.command}
                  spellCheck={false}
                  onChange={(event) => patchProfile(profile.id, { command: event.target.value })}
                  onBlur={() => probe(profile)}
                />
                <span className="text-[10px] text-faint">参数</span>
                <ArgsEditor
                  args={profile.args ?? []}
                  onChange={(args) => patchProfile(profile.id, { args })}
                />
              </div>

              {state !== 'loading' && state && !state.found && profile.command.trim() && (
                <div className="mt-2 flex items-start gap-1.5 rounded-md border border-warn/30 bg-warn/5 px-2 py-1.5 text-[10px] leading-relaxed text-warn">
                  <TriangleAlert size={12} className="mt-px shrink-0" />
                  在 PATH 中找不到「{profile.command}」，启动时会失败。可以写完整路径，或确认它已加入环境变量。
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className="mt-1.5 space-y-2">
        <div className="flex items-center gap-3 rounded-lg border border-line-2 bg-panel-2/50 px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="text-xs text-ink">Claude Code 使用严格 MCP 配置</div>
            <div className="mt-0.5 text-[10px] leading-relaxed text-faint">
              开启后 Claude 只加载 AIShell 注入的当前会话 MCP，忽略全局 MCP 配置。
            </div>
          </div>
          <Toggle
            checked={Boolean(settings.claudeStrictMcp)}
            label="Claude Code 使用严格 MCP 配置"
            onChange={(claudeStrictMcp) => update({ claudeStrictMcp })}
          />
        </div>
        <div className="px-1 text-[10px] text-faint">
          修改对下一次启动 Agent 生效。内置 Agent 不能删除，但可以禁用。
        </div>
      </div>
      <button
        className="btn-secondary mt-3 py-1 text-[11px]"
        onClick={() => {
          void window.aishell.shell.openDataDir().then((error) => {
            if (error) pushToast('error', `打开数据目录失败：${error}`)
          })
        }}
      >
        <FolderOpen size={12} />
        打开数据目录
      </button>
    </section>
  )
}

function ProbeBadge({
  state
}: {
  state: AgentProbeResult | 'loading' | undefined
}): React.JSX.Element | null {
  if (!state) return null
  if (state === 'loading') {
    return (
      <span className="flex items-center gap-1 text-[10px] text-faint">
        <Loader2 size={11} className="animate-spin" />
        检测中
      </span>
    )
  }
  if (!state.found) {
    return (
      <span className="flex items-center gap-1 text-[10px] text-warn" title={state.path}>
        <TriangleAlert size={11} />
        未找到
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1 text-[10px] text-ok" title={state.path}>
      <Check size={11} />
      已找到{state.version ? ` · ${state.version}` : ''}
    </span>
  )
}

/**
 * Arguments as chips: a whole chip is one argv entry, so values with spaces
 * survive — the old space-split input could not express them.
 */
function ArgsEditor({
  args,
  onChange
}: {
  args: string[]
  onChange: (args: string[]) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const joined = useMemo(() => args.join(' '), [args])

  const commit = (): void => {
    const value = draft.trim()
    if (!value) return
    onChange([...args, value])
    setDraft('')
  }

  return (
    <div className="flex min-h-[30px] flex-wrap items-center gap-1 rounded-lg border border-line-2 bg-field px-1.5 py-1">
      {args.map((arg, index) => (
        <span
          key={`${arg}-${index}`}
          className="flex items-center gap-1 rounded bg-panel-3 px-1.5 py-0.5 font-mono text-[10px] text-ink"
          title={joined}
        >
          {arg}
          <button
            className="text-faint hover:text-err"
            title="移除"
            onClick={() => onChange(args.filter((_, i) => i !== index))}
          >
            <X size={10} />
          </button>
        </span>
      ))}
      <input
        className="min-w-[80px] flex-1 bg-transparent font-mono text-[11px] text-ink outline-none placeholder:text-faint"
        placeholder={args.length ? '' : '每个参数的标签一项，例如 --model'}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === 'Tab') {
            if (draft.trim()) {
              event.preventDefault()
              commit()
            }
          }
          if (event.key === 'Backspace' && !draft && args.length) {
            onChange(args.slice(0, -1))
          }
        }}
        onBlur={commit}
      />
    </div>
  )
}

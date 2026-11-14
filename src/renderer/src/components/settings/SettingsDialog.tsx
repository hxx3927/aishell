import { Search } from 'lucide-react'
import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import type { Settings } from '@shared/types'
import { SETTINGS_DEFAULTS, type ResettableSetting } from '../../lib/settingsDefaults'
import { useAppStore } from '../../state/store'
import { Modal } from '../Modal'
import { ROWS, type RowContext } from './rows'
import { renderSection, SECTIONS, type Section } from './sections'

/**
 * Settings apply as soon as they change — the VS Code / Warp model, so the
 * terminal behind the dialog updates live and there is no Save/Cancel pair.
 * Each row that differs from its default carries a bar and a reset action.
 */
export function SettingsDialog(): React.JSX.Element {
  const open = useAppStore((s) => s.settingsOpen)
  const setOpen = useAppStore((s) => s.setSettingsOpen)
  const settings = useAppStore((s) => s.settings)
  const saveSettings = useAppStore((s) => s.saveSettings)
  const pushToast = useAppStore((s) => s.pushToast)

  const [section, setSection] = useState<Section>('general')
  const [query, setQuery] = useState('')
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (open) {
      setFailed(false)
      setQuery('')
    }
  }, [open])

  const update = (patch: Partial<Settings>): void => {
    void saveSettings(patch)
      .then(() => setFailed(false))
      .catch((err) => {
        setFailed(true)
        pushToast('error', `保存设置失败：${(err as Error).message}`)
      })
  }

  const reset = (key: ResettableSetting): void => {
    update({ [key]: SETTINGS_DEFAULTS[key] } as Partial<Settings>)
  }

  const deferredQuery = useDeferredValue(query.trim().toLowerCase())

  /** Rows whose label or keywords match; `null` when not searching. */
  const matches = useMemo(() => {
    if (!deferredQuery) return null
    const result = new Set<string>()
    for (const row of ROWS) {
      if (row.kind !== 'setting') continue
      const haystack = `${row.label} ${row.keywords ?? ''}`.toLowerCase()
      if (haystack.includes(deferredQuery)) result.add(row.key)
    }
    return result
  }, [deferredQuery])

  const ctx: RowContext = { settings, update, reset }

  return (
    <Modal
      open={open}
      title="设置"
      subtitle="修改立即生效，无需保存。和默认值不同的项左侧有标记，悬停即可恢复默认。"
      onClose={() => setOpen(false)}
      width="max-w-4xl"
      bodyClass="p-0"
      footer={
        <div className="flex w-full items-center justify-between">
          <span className={`text-[10px] ${failed ? 'text-err' : 'text-faint'}`}>
            {failed ? '有设置保存失败，请重试。' : '所有设置只保存在本机，不会上传。'}
          </span>
          <button className="btn-primary" onClick={() => setOpen(false)}>
            完成
          </button>
        </div>
      }
    >
      <div className="flex h-[560px]">
        <nav className="flex w-[168px] shrink-0 flex-col border-r border-line bg-panel-2/40 p-2">
          <div className="relative mb-2">
            <Search
              size={12}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint"
            />
            <input
              className="input py-1.5 pl-7 text-[11px]"
              placeholder="搜索设置"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && query) {
                  event.stopPropagation()
                  setQuery('')
                }
              }}
            />
          </div>
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              className={`mb-0.5 flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-xs transition ${
                !matches && section === item.id
                  ? 'bg-accent/10 text-accent'
                  : 'text-dim hover:bg-panel-3 hover:text-ink'
              }`}
              onClick={() => {
                setQuery('')
                setSection(item.id)
              }}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </nav>

        <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
          {matches ? (
            <SearchResults visible={matches} ctx={ctx} />
          ) : (
            renderSection(section, { ctx })
          )}
        </div>
      </div>
    </Modal>
  )
}

/** Search shows every matching row, grouped under its section heading. */
function SearchResults({
  visible,
  ctx
}: {
  visible: Set<string>
  ctx: RowContext
}): React.JSX.Element {
  const withMatches = SECTIONS.filter((item) =>
    ROWS.some((row) => row.kind === 'setting' && row.section === item.id && visible.has(row.key))
  )
  if (withMatches.length === 0) {
    return (
      <div className="mt-16 text-center text-xs text-faint">
        没有匹配的设置。试试「粘贴」「字体」「心跳」「换行」。
      </div>
    )
  }
  return (
    <>
      <div className="mb-2 text-[11px] text-dim">找到 {visible.size} 项设置</div>
      {withMatches.map((item) => (
        <div key={item.id} className="mb-4">
          <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[11px] font-semibold text-dim">
            {item.icon}
            {item.label}
          </div>
          {renderSection(item.id, { ctx, visible })}
        </div>
      ))}
    </>
  )
}

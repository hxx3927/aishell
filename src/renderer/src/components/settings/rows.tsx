import type { ReactNode } from 'react'
import type { Settings } from '@shared/types'
import { SETTINGS_DEFAULTS, type ResettableSetting } from '../../lib/settingsDefaults'
import { NumberField, Segmented, Select, SettingRow, Toggle } from './controls'
import type { Section } from './sections'

export interface RowContext {
  settings: Settings
  update: (patch: Partial<Settings>) => void
  reset: (key: ResettableSetting) => void
}

interface RowBase {
  section: Section
  /** Visible label, also used by the search box. */
  label: string
  description?: ReactNode
  /** Extra words that should match a search but are not in the label. */
  keywords?: string
}

interface SettingRowEntry extends RowBase {
  kind: 'setting'
  key: ResettableSetting
  /** Stacks the control under the label. */
  stacked?: boolean
  control: (ctx: RowContext) => ReactNode
}

interface CustomRowEntry extends RowBase {
  kind: 'custom'
  control: (ctx: RowContext) => ReactNode
}

export type RowEntry = SettingRowEntry | CustomRowEntry

/** Order here is the order on screen. */
export const ROWS: RowEntry[] = [
  {
    kind: 'setting',
    key: 'theme',
    section: 'general',
    label: '外观主题',
    keywords: 'dark light system 深色 浅色 跟随系统',
    description: '选择「跟随系统」时，系统切换深色/浅色会自动跟随。',
    control: ({ settings, update }) => (
      <Segmented
        value={settings.theme}
        options={[
          { value: 'light', label: '浅色' },
          { value: 'dark', label: '深色' },
          { value: 'system', label: '跟随系统' }
        ]}
        onChange={(theme) => update({ theme })}
      />
    )
  },
  {
    kind: 'custom',
    section: 'appearance',
    label: '快捷键',
    keywords: 'shortcut 复制 粘贴 查找',
    control: () => (
      <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-lg border border-line-2 bg-panel-2/60 px-3 py-2.5 text-[11px] text-dim">
        {[
          ['复制', 'Ctrl+Shift+C'],
          ['粘贴', 'Ctrl+Shift+V'],
          ['查找', 'Ctrl+F'],
          ['设置', 'Ctrl+,'],
          ['新建会话', 'Ctrl+Shift+N'],
          ['右键菜单', 'Shift+右键']
        ].map(([name, keys]) => (
          <div key={name} className="flex items-center justify-between gap-3">
            <span>{name}</span>
            <kbd className="rounded border border-line-2 bg-field px-1.5 py-0.5 font-mono text-[10px] text-ink">
              {keys}
            </kbd>
          </div>
        ))}
      </div>
    )
  },
  {
    kind: 'setting',
    key: 'fontFamily',
    section: 'appearance',
    label: '字体',
    keywords: 'font family 等宽',
    description: '等宽字体，多个字体用逗号分隔，排在前面且已安装的生效。',
    stacked: true,
    control: ({ settings, update }) => (
      <input
        className="input font-mono"
        value={settings.fontFamily}
        spellCheck={false}
        onChange={(event) => update({ fontFamily: event.target.value })}
      />
    )
  },
  {
    kind: 'setting',
    key: 'fontSize',
    section: 'appearance',
    label: '字号',
    control: ({ settings, update }) => (
      <NumberField
        value={settings.fontSize}
        min={8}
        max={32}
        suffix="px"
        width="w-20"
        onChange={(fontSize) => update({ fontSize })}
      />
    )
  },
  {
    kind: 'setting',
    key: 'lineHeight',
    section: 'appearance',
    label: '行高',
    keywords: 'line height 行距',
    description: '1.0 比较紧凑，适合一屏显示更多输出。',
    control: ({ settings, update }) => (
      <NumberField
        value={settings.lineHeight}
        min={1}
        max={1.8}
        step={0.05}
        width="w-20"
        onChange={(lineHeight) => update({ lineHeight: Math.round(lineHeight * 100) / 100 })}
      />
    )
  },
  {
    kind: 'setting',
    key: 'cursorStyle',
    section: 'appearance',
    label: '光标样式',
    control: ({ settings, update }) => (
      <Segmented
        value={settings.cursorStyle}
        options={[
          { value: 'bar', label: '竖线' },
          { value: 'block', label: '方块' },
          { value: 'underline', label: '下划线' }
        ]}
        onChange={(cursorStyle) => update({ cursorStyle })}
      />
    )
  },
  {
    kind: 'setting',
    key: 'cursorBlink',
    section: 'appearance',
    label: '光标闪烁',
    control: ({ settings, update }) => (
      <Toggle
        checked={settings.cursorBlink}
        label="光标闪烁"
        onChange={(cursorBlink) => update({ cursorBlink })}
      />
    )
  },
  {
    kind: 'setting',
    key: 'scrollback',
    section: 'terminal',
    label: '回滚行数',
    keywords: 'history 历史 buffer 缓存',
    description: '每个终端保留的历史行数，越大越占内存。对新建的终端生效。',
    control: ({ settings, update }) => (
      <Select
        value={settings.scrollback}
        options={[
          { value: 2000, label: '2,000 行' },
          { value: 5000, label: '5,000 行' },
          { value: 10000, label: '10,000 行（默认）' },
          { value: 25000, label: '25,000 行' },
          { value: 50000, label: '50,000 行' }
        ]}
        onChange={(scrollback) => update({ scrollback })}
      />
    )
  },
  {
    kind: 'setting',
    key: 'copyOnSelect',
    section: 'terminal',
    label: '选中即复制',
    keywords: 'copy select 剪贴板',
    description: '鼠标松开时把选中的文本写入剪贴板，Windows 下多数运维工具默认开启。',
    control: ({ settings, update }) => (
      <Toggle
        checked={settings.copyOnSelect}
        label="选中即复制"
        onChange={(copyOnSelect) => update({ copyOnSelect })}
      />
    )
  },
  {
    kind: 'setting',
    key: 'rightClickAction',
    section: 'terminal',
    label: '右键行为',
    keywords: 'right click paste 菜单 粘贴',
    description: '选择「直接粘贴」时，Shift+右键仍然打开菜单。',
    control: ({ settings, update }) => (
      <Segmented
        value={settings.rightClickAction}
        options={[
          { value: 'paste', label: '直接粘贴' },
          { value: 'menu', label: '弹出菜单' }
        ]}
        onChange={(rightClickAction) => update({ rightClickAction })}
      />
    )
  },
  {
    kind: 'setting',
    key: 'pasteLineBreakGuard',
    section: 'terminal',
    label: '多行粘贴前确认',
    keywords: 'paste multiline 粘贴 确认 换行',
    description: '粘贴 3 行以上内容时先确认，避免误把多行命令逐行执行。',
    control: ({ settings, update }) => (
      <Toggle
        checked={settings.pasteLineBreakGuard}
        label="多行粘贴前确认"
        onChange={(pasteLineBreakGuard) => update({ pasteLineBreakGuard })}
      />
    )
  },
  {
    kind: 'setting',
    key: 'trimPaste',
    section: 'terminal',
    label: '粘贴时去掉首尾空白',
    keywords: 'paste trim 空格 换行',
    control: ({ settings, update }) => (
      <Toggle
        checked={settings.trimPaste}
        label="粘贴时去掉首尾空白"
        onChange={(trimPaste) => update({ trimPaste })}
      />
    )
  },
  {
    kind: 'setting',
    key: 'bellStyle',
    section: 'terminal',
    label: '响铃',
    keywords: 'bell 提示音 声音 闪屏',
    description: '收到终端响铃时的提示；Agent 窗口响铃会同时弹出通知。',
    control: ({ settings, update }) => (
      <Select
        value={settings.bellStyle}
        options={[
          { value: 'off', label: '关闭' },
          { value: 'visual', label: '屏幕闪烁' },
          { value: 'sound', label: '提示音' }
        ]}
        onChange={(bellStyle) => update({ bellStyle })}
      />
    )
  },
  {
    kind: 'setting',
    key: 'shiftEnterNewline',
    section: 'agent',
    label: 'Shift+Enter 换行',
    keywords: 'shift enter 换行 回车 多行 agent',
    description:
      '在终端里按 Shift+Enter 发送换行而不是回车，Claude Code 等 Agent 用它输入多行提示而不直接提交。',
    control: ({ settings, update }) => (
      <Toggle
        checked={settings.shiftEnterNewline}
        label="Shift+Enter 换行"
        onChange={(shiftEnterNewline) => update({ shiftEnterNewline })}
      />
    )
  },
  {
    kind: 'setting',
    key: 'sshKeepaliveInterval',
    section: 'ssh',
    label: '心跳间隔',
    keywords: 'keepalive 保活 断线',
    description: '每隔多少秒向服务器发送一次 SSH 心跳，0 表示关闭。对新建的连接生效。',
    control: ({ settings, update }) => (
      <NumberField
        value={settings.sshKeepaliveInterval}
        min={0}
        max={600}
        suffix="秒"
        onChange={(sshKeepaliveInterval) => update({ sshKeepaliveInterval })}
      />
    )
  },
  {
    kind: 'setting',
    key: 'sshKeepaliveCountMax',
    section: 'ssh',
    label: '心跳失败上限',
    keywords: 'keepalive 保活',
    description: '连续多少次心跳没有回应就判定连接断开。',
    control: ({ settings, update }) => (
      <NumberField
        value={settings.sshKeepaliveCountMax}
        min={1}
        max={20}
        suffix="次"
        onChange={(sshKeepaliveCountMax) => update({ sshKeepaliveCountMax })}
      />
    )
  },
  {
    kind: 'setting',
    key: 'sshReadyTimeout',
    section: 'ssh',
    label: '连接超时',
    keywords: 'timeout 超时',
    description: '握手和登录阶段最多等待多久，弱网环境可以调大。',
    control: ({ settings, update }) => (
      <NumberField
        value={settings.sshReadyTimeout}
        min={5000}
        max={120000}
        step={1000}
        suffix="毫秒"
        onChange={(sshReadyTimeout) => update({ sshReadyTimeout })}
      />
    )
  },
]

export function renderRow(entry: RowEntry, ctx: RowContext, focused: boolean): ReactNode {
  if (entry.kind === 'custom') return entry.control(ctx)
  const current = ctx.settings[entry.key]
  const isDefault = current === undefined || current === SETTINGS_DEFAULTS[entry.key]
  return (
    <SettingRow
      label={entry.label}
      description={entry.description}
      stacked={entry.stacked}
      resetKey={entry.key}
      onReset={isDefault ? undefined : () => ctx.reset(entry.key)}
      dimmed={!focused}
      control={entry.control(ctx)}
    />
  )
}

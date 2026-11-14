import {
  Cpu,
  FolderCog,
  Gamepad2,
  Info,
  Palette,
  Server,
  ShieldCheck,
  SquareTerminal
} from 'lucide-react'
import type { ReactNode } from 'react'
import { SettingGroup } from './controls'
import { AboutSection } from './AboutSection'
import { AgentSection } from './AgentSection'
import { FilesSection } from './FilesSection'
import { ROWS, renderRow, type RowContext } from './rows'
import { SecuritySection } from './SecuritySection'

export type Section =
  | 'general'
  | 'appearance'
  | 'terminal'
  | 'ssh'
  | 'files'
  | 'agent'
  | 'security'
  | 'about'

interface SectionMeta {
  id: Section
  label: string
  icon: ReactNode
}

export const SECTIONS: SectionMeta[] = [
  { id: 'general', label: '通用', icon: <Palette size={13} /> },
  { id: 'appearance', label: '外观与字体', icon: <SquareTerminal size={13} /> },
  { id: 'terminal', label: '终端行为', icon: <Gamepad2 size={13} /> },
  { id: 'ssh', label: 'SSH 连接', icon: <Server size={13} /> },
  { id: 'files', label: '文件', icon: <FolderCog size={13} /> },
  { id: 'agent', label: 'Agent', icon: <Cpu size={13} /> },
  { id: 'security', label: '安全与隐私', icon: <ShieldCheck size={13} /> },
  { id: 'about', label: '关于', icon: <Info size={13} /> }
]

const GROUP_TITLES: Partial<Record<Section, string>> = {
  general: '外观',
  appearance: '终端外观',
  terminal: '终端行为',
  ssh: '连接参数（对新建连接生效）',
  agent: '交互'
}

interface SectionProps {
  ctx: RowContext
  /** Keys matched by the search box; rows outside the set dim out. */
  visible?: Set<string>
}

export function renderSection(section: Section, { ctx, visible }: SectionProps): ReactNode {
  const rows = ROWS.filter((row) => row.section === section)
  const title = GROUP_TITLES[section]

  let body: ReactNode
  switch (section) {
    case 'general':
    case 'appearance':
    case 'terminal':
    case 'ssh':
    case 'agent':
      body = rows.length > 0 && (
        <SettingGroup title={title}>
          {rows.map((row) => (
            <div key={row.label}>
              {renderRow(row, ctx, !visible || !('key' in row) || visible.has(row.key))}
            </div>
          ))}
        </SettingGroup>
      )
      break
    default:
      body = null
  }

  if (section === 'agent') {
    return (
      <>
        {body}
        <AgentSection ctx={ctx} />
      </>
    )
  }
  if (section === 'files') return <FilesSection />
  if (section === 'security') return <SecuritySection />
  if (section === 'about') return <AboutSection />

  return <>{body}</>
}

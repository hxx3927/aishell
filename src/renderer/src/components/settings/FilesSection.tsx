import { FolderOpen } from 'lucide-react'
import { useAppStore } from '../../state/store'
import { SettingGroup, SettingRow, Toggle } from './controls'

export function FilesSection(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const saveSettings = useAppStore((s) => s.saveSettings)

  return (
    <SettingGroup title="文件管理">
      <SettingRow
        label="本地起始目录"
        description="文件管理左侧面板的默认目录（任意磁盘均可）；编辑器下载也使用该目录。留空则使用用户主目录。"
        stacked
        control={
          <div className="flex gap-2">
            <input
              className="input font-mono"
              placeholder="留空则使用用户主目录"
              value={settings.localStartPath ?? ''}
              onChange={(event) => void saveSettings({ localStartPath: event.target.value })}
            />
            <button
              className="btn-secondary shrink-0"
              onClick={() =>
                void window.aishell.dialog.pickDirectory().then((dir) => {
                  if (dir) void saveSettings({ localStartPath: dir })
                })
              }
            >
              <FolderOpen size={13} />
              浏览
            </button>
          </div>
        }
      />
      <SettingRow
        label="显示隐藏文件"
        description="作用于本地面板；远端面板始终显示全部文件。"
        control={
          <Toggle
            checked={Boolean(settings.showHiddenFiles)}
            label="显示隐藏文件"
            onChange={(showHiddenFiles) => void saveSettings({ showHiddenFiles })}
          />
        }
      />
    </SettingGroup>
  )
}

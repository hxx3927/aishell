import { Eye, EyeOff, FolderOpen, KeyRound, Loader2, Lock, UserRound } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { AuthType, Session, SessionInput } from '@shared/types'
import { useAppStore } from '../state/store'
import { Modal } from './Modal'

const AUTH_OPTIONS: Array<{ value: AuthType; label: string; hint: string }> = [
  { value: 'password', label: '密码', hint: '使用账号密码登录' },
  { value: 'key', label: '私钥', hint: '使用本机私钥文件登录' },
  { value: 'agent', label: 'SSH Agent', hint: '使用系统 ssh-agent 中的密钥' }
]

export function SessionDialog() {
  const editor = useAppStore((s) => s.sessionEditor)
  const close = useAppStore((s) => s.closeSessionEditor)
  const refreshSessions = useAppStore((s) => s.refreshSessions)
  const pushToast = useAppStore((s) => s.pushToast)
  const sessions = useAppStore((s) => s.sessions)
  const groupNames = useAppStore((s) => s.settings.groups)

  const editing = editor.session
  const fallbackGroup = groupNames?.[0] ?? '默认'
  const [name, setName] = useState('')
  const [group, setGroup] = useState('默认')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [username, setUsername] = useState('root')
  const [authType, setAuthType] = useState<AuthType>('password')
  const [password, setPassword] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [keyPath, setKeyPath] = useState('')
  const [showSecret, setShowSecret] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!editor.open) return
    setError('')
    setSaving(false)
    setShowSecret(false)
    setPassword('')
    setPassphrase('')
    if (editing) {
      setName(editing.name)
      setGroup(editing.group || '默认')
      setHost(editing.host)
      setPort(String(editing.port))
      setUsername(editing.username)
      setAuthType(editing.auth.type)
      setKeyPath(editing.auth.privateKeyPath ?? '')
    } else {
      setName('')
      setGroup(editor.group || fallbackGroup)
      setHost('')
      setPort('22')
      setUsername('root')
      setAuthType('password')
      setKeyPath('')
    }
  }, [editor.open, editing, editor.group, fallbackGroup])

  const groups = useMemo(() => {
    const values = new Set<string>(groupNames?.length ? groupNames : ['默认'])
    for (const session of sessions) if (session.group) values.add(session.group)
    return Array.from(values)
  }, [sessions, groupNames])

  const submit = async (): Promise<void> => {
    if (!host.trim()) {
      setError('请填写主机地址')
      return
    }
    if (!username.trim()) {
      setError('请填写用户名')
      return
    }
    if (authType === 'key' && !keyPath.trim()) {
      setError('请选择私钥文件')
      return
    }
    const portNumber = Number(port)
    if (!/^\d+$/.test(port.trim()) || portNumber < 1 || portNumber > 65535) {
      setError('端口需为 1–65535 的整数')
      return
    }

    const input: SessionInput = {
      id: editing?.id ?? '',
      name: name.trim() || host.trim(),
      group: group.trim() || fallbackGroup,
      host: host.trim(),
      port: portNumber,
      username: username.trim(),
      auth: {
        type: authType,
        privateKeyPath: authType === 'key' ? keyPath.trim() : undefined
      },
      color: editing?.color,
      tags: editing?.tags,
      createdAt: editing?.createdAt ?? Date.now(),
      lastUsedAt: editing?.lastUsedAt,
      password: authType === 'password' ? password || undefined : undefined,
      passphrase: authType === 'key' ? passphrase || undefined : undefined
    }

    setSaving(true)
    try {
      const saved = await window.aishell.sessions.save(input)
      await refreshSessions()
      pushToast('info', editing ? `已更新「${saved.name}」` : `已创建「${saved.name}」`)
      close()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const pickKey = async (): Promise<void> => {
    const picked = await window.aishell.dialog.pickKey()
    if (picked) setKeyPath(picked)
  }

  return (
    <Modal
      open={editor.open}
      title={editing ? '编辑连接' : '新建连接'}
      subtitle="保存后双击左侧连接即可连接。凭据使用系统安全存储加密。"
      onClose={close}
      width="max-w-2xl"
      footer={
        <>
          {error && <div className="mr-auto text-xs text-err">{error}</div>}
          <button className="btn-secondary" onClick={close} disabled={saving}>
            取消
          </button>
          <button className="btn-primary" onClick={() => void submit()} disabled={saving}>
            {saving && <Loader2 size={13} className="animate-spin" />}
            保存
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">名称</label>
          <input
            className="input"
            placeholder="例如：生产 Web"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div>
          <label className="label">分组</label>
          <input
            className="input"
            list="aishell-groups"
            placeholder="默认"
            value={group}
            onChange={(event) => setGroup(event.target.value)}
          />
          <datalist id="aishell-groups">
            {groups.map((item) => (
              <option key={item} value={item} />
            ))}
          </datalist>
        </div>

        <div>
          <label className="label">主机 / IP</label>
          <input
            className="input font-mono"
            placeholder="10.0.0.5 或 example.com"
            value={host}
            onChange={(event) => setHost(event.target.value)}
            autoFocus
          />
        </div>
        <div className="grid grid-cols-[1fr_88px] gap-3">
          <div>
            <label className="label">用户名</label>
            <input
              className="input font-mono"
              placeholder="root"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </div>
          <div>
            <label className="label">端口</label>
            <input
              className="input font-mono"
              value={port}
              onChange={(event) => setPort(event.target.value.replace(/[^\d]/g, ''))}
            />
          </div>
        </div>
      </div>

      <div className="mt-5">
        <label className="label">认证方式</label>
        <div className="grid grid-cols-3 gap-2">
          {AUTH_OPTIONS.map((option) => (
            <button
              key={option.value}
              className={`rounded-lg border px-3 py-2 text-left transition ${
                authType === option.value
                  ? 'border-accent/60 bg-accent/10'
                  : 'border-line-2 bg-panel-2 hover:border-line-2 hover:bg-panel-3'
              }`}
              onClick={() => setAuthType(option.value)}
            >
              <div className="flex items-center gap-1.5 text-xs font-medium text-ink">
                {option.value === 'password' ? (
                  <Lock size={12} />
                ) : option.value === 'key' ? (
                  <KeyRound size={12} />
                ) : (
                  <UserRound size={12} />
                )}
                {option.label}
              </div>
              <div className="mt-1 text-[10px] text-faint">{option.hint}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {authType === 'password' && (
          <div>
            <label className="label">密码</label>
            <div className="relative">
              <input
                className="input pr-10 font-mono"
                type={showSecret ? 'text' : 'password'}
                placeholder={editing ? '留空则保留原密码' : '账号密码'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void submit()
                }}
              />
              <button
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-faint hover:text-ink"
                onClick={() => setShowSecret((value) => !value)}
                title={showSecret ? '隐藏' : '显示'}
              >
                {showSecret ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>
        )}

        {authType === 'key' && (
          <>
            <div>
              <label className="label">私钥文件</label>
              <div className="flex gap-2">
                <input
                  className="input font-mono"
                  placeholder="C:\Users\me\.ssh\id_ed25519"
                  value={keyPath}
                  onChange={(event) => setKeyPath(event.target.value)}
                />
                <button className="btn-secondary shrink-0" onClick={() => void pickKey()}>
                  <FolderOpen size={13} />
                  浏览
                </button>
              </div>
            </div>
            <div>
              <label className="label">私钥口令（可留空）</label>
              <input
                className="input font-mono"
                type={showSecret ? 'text' : 'password'}
                placeholder={editing ? '留空则保留原口令' : 'Passphrase'}
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
              />
            </div>
          </>
        )}

        {authType === 'agent' && (
          <div className="rounded-lg border border-line-2 bg-panel-2 px-3 py-2.5 text-[11px] leading-relaxed text-dim">
            将使用系统 SSH Agent 中已加载的密钥。Windows 需启用 OpenSSH Authentication Agent 服务。
          </div>
        )}
      </div>
    </Modal>
  )
}

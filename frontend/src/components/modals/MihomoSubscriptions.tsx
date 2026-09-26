import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useEffect, useMemo, useState } from 'react'
import { apiCall, clashFetch } from '@/lib/api'
import { useAppContext } from '@/lib/store'
import { addMihomoProvider, listMihomoProviders, removeMihomoProvider } from '@/lib/mihomoSubscription'

interface Props { open: boolean; onOpenChange: (open: boolean) => void; onApplied: () => Promise<unknown> }
interface ConfigItem { file: string; content: string }

function hostname(url: string): string {
  try { return new URL(url).hostname } catch { return 'Сохранённая ссылка' }
}

export function MihomoSubscriptionsModal({ open, onOpenChange, onApplied }: Props) {
  const { state, showToast } = useAppContext()
  const [config, setConfig] = useState<ConfigItem | null>(null)
  const [url, setUrl] = useState('')
  const [allowLan, setAllowLan] = useState(false)
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const providers = useMemo(() => { try { return config ? listMihomoProviders(config.content) : [] } catch { return [] } }, [config])

  useEffect(() => {
    if (!open) return
    let active = true
    setLoading(true); setError(''); setConfirmDelete(null)
    void apiCall<{ success: boolean; configs?: ConfigItem[]; error?: string }>('GET', 'configs?core=mihomo')
      .then((result) => {
        if (!active) return
        if (!result.success) throw new Error(result.error || 'Не удалось прочитать Mihomo')
        const found = result.configs?.find((item) => item.file === '/opt/etc/mihomo/config.yaml')
        if (!found) throw new Error('config.yaml Mihomo не найден')
        setConfig(found)
      })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : 'Ошибка загрузки') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [open])

  async function save(nextContent: string, message: string) {
    if (!config) throw new Error('config.yaml не загружен')
    let saved = false
    try {
      const result = await apiCall<{ success: boolean; error?: string }>('PUT', 'configs?core=mihomo&validate=mihomo', { file: config.file, content: nextContent })
      if (!result.success) throw new Error(result.error || 'Mihomo не принял конфигурацию')
      saved = true
      if (state.currentCore === 'mihomo' && state.serviceStatus === 'running') {
        await clashFetch(state.clashApiPort ?? '', 'configs?force=true', { method: 'PUT', secret: state.clashApiSecret, unix: state.clashApiUnix, body: { path: config.file, payload: '' }, retry: false })
      }
      setConfig({ ...config, content: nextContent })
      await onApplied()
      showToast(message)
    } catch (cause) {
      if (saved) {
        const rollback = await apiCall<{ success: boolean }>('PUT', 'configs?core=mihomo&validate=mihomo', { file: config.file, content: config.content }).catch(() => null)
        if (rollback?.success && state.currentCore === 'mihomo' && state.serviceStatus === 'running') {
          await clashFetch(state.clashApiPort ?? '', 'configs?force=true', { method: 'PUT', secret: state.clashApiSecret, unix: state.clashApiUnix, body: { path: config.file, payload: '' }, retry: false }).catch(() => null)
        }
      }
      throw cause
    }
  }

  async function add() {
    setBusy(true); setError('')
    try {
      if (!config) throw new Error('config.yaml не загружен')
      const trimmed = url.trim()
      if (!/^https:\/\/[^\s]+$/i.test(trimmed)) throw new Error('Нужна HTTPS ссылка подписки')
      const preview = await apiCall<{ success: boolean; error?: string; requiresLanAccess?: boolean }>('POST', 'subscription/preview', { url: trimmed, allow_lan: allowLan })
      if (!preview.success) {
        if (preview.requiresLanAccess) setAllowLan(true)
        throw new Error(preview.error || 'Подписка не загрузилась')
      }
      const id = name.trim() || `subscription_${Date.now().toString(36)}`
      await save(addMihomoProvider(config.content, id, trimmed), state.currentCore === 'mihomo' ? 'Подписка Mihomo добавлена' : 'Подписка сохранена; Mihomo загрузит её при переключении')
      setUrl(''); setName(''); setAllowLan(false)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось добавить подписку') }
    finally { setBusy(false) }
  }

  async function refresh(provider: { name: string; url: string }) {
    setBusy(true); setError('')
    try {
      const result = await apiCall<{success: boolean; error?: string}>('POST', 'mihomo/subscription-refresh', {name: provider.name})
      if (!result.success) throw new Error(result.error || 'Не удалось обновить подписку')
      if (state.currentCore === 'mihomo' && state.serviceStatus === 'running' && config) {
        await clashFetch(state.clashApiPort ?? '', 'configs?force=true', {method: 'PUT', secret: state.clashApiSecret, unix: state.clashApiUnix, body: {path: config.file, payload: ''}, retry: false})
      }
      await onApplied()
      showToast(`Подписка ${provider.name} обновлена`)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось обновить подписку') }
    finally { setBusy(false) }
  }

  async function remove(nameToRemove: string) {
    setBusy(true); setError('')
    try {
      if (!config) throw new Error('config.yaml не загружен')
      await save(removeMihomoProvider(config.content, nameToRemove), 'Подписка Mihomo удалена')
      setConfirmDelete(null)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось удалить подписку') }
    finally { setBusy(false) }
  }

  return <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
    <DialogContent className="max-h-[90dvh] max-w-[min(94vw,700px)]! overflow-y-auto">
      <DialogHeader><DialogTitle>Подписки Mihomo</DialogTitle></DialogHeader>
      <p className="text-muted-foreground text-sm">Ссылки хранятся в config.yaml. Узлы добавляются в группы маршрутизации. Существующие правила сохраняются. Кнопка обновляет сохранённые узлы подписки и при неактивном ядре. Автоматическое обновление — каждый час.</p>
      <div className="space-y-2">
        {providers.length === 0 && !loading && <p className="text-muted-foreground text-sm">Подписок пока нет.</p>}
        {providers.map((provider) => <div key={provider.name} className="border-border flex flex-wrap items-center gap-2 rounded-lg border p-3">
          <div className="min-w-0 flex-1"><div className="font-medium">{provider.name}</div><div className="text-muted-foreground text-xs">{hostname(provider.url)}</div></div>
          {confirmDelete === provider.name ? <><Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmDelete(null)}>Отмена</Button><Button size="sm" variant="destructive" disabled={busy} onClick={() => void remove(provider.name)}>Подтвердить удаление</Button></> : <><Button size="sm" variant="outline" disabled={busy} onClick={() => void refresh(provider)}>{state.currentCore === 'mihomo' && state.serviceStatus === 'running' ? 'Обновить' : 'Проверить ссылку'}</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmDelete(provider.name)}>Удалить</Button></>}
        </div>)}
      </div>
      <div className="border-border space-y-2 border-t pt-3">
        <label htmlFor="mihomo-subscription-name" className="text-sm font-medium">Добавить подписку</label>
        <Input id="mihomo-subscription-name" value={name} disabled={busy || loading} onChange={(event) => setName(event.target.value)} placeholder="Имя (необязательно)" />
        <Input type="password" value={url} disabled={busy || loading} onChange={(event) => setUrl(event.target.value)} placeholder="https://..." autoComplete="off" spellCheck={false} aria-label="URL подписки Mihomo" />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={allowLan} disabled={busy} onChange={(event) => setAllowLan(event.target.checked)} />Локальный сервер подписки</label>
        <Button disabled={busy || loading || !url.trim()} onClick={() => void add()}>{busy ? 'Сохранение...' : 'Добавить'}</Button>
      </div>
      {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
      <div className="flex justify-end"><Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Закрыть</Button></div>
    </DialogContent>
  </Dialog>
}

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useEffect, useState } from 'react'
import { apiCall } from '@/lib/api'
import { useAppContext } from '@/lib/store'
import { countXraySubscriptionNodes, removeXraySubscription, xrayConfigFromSubscription } from '@/lib/xraySubscription'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onApplied: () => Promise<unknown>
}
interface SubscriptionEntry { id: string; url: string; allowLan: boolean }
interface SetupResponse { success: boolean; content?: string; subscriptions?: SubscriptionEntry[]; subscriptionUrl?: string; subscriptionAllowLan?: boolean; error?: string }

function hostname(url: string): string {
  try { return new URL(url).hostname } catch { return 'Сохранённая подписка' }
}

export function XraySubscriptionsModal({ open, onOpenChange, onApplied }: Props) {
  const { state, dispatch, showToast } = useAppContext()
  const [content, setContent] = useState('')
  const [entries, setEntries] = useState<SubscriptionEntry[]>([])
  const [url, setUrl] = useState('')
  const [allowLan, setAllowLan] = useState(false)
  const [needsLanAccess, setNeedsLanAccess] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let active = true
    setLoading(true); setError(''); setConfirmDelete(null)
    void apiCall<SetupResponse>('GET', 'xray-config')
      .then((result) => {
        if (!active) return
        if (!result.success) throw new Error(result.error || 'Не удалось загрузить Xray JSON')
        setContent(result.content ?? '')
        setEntries(result.subscriptions ?? (result.subscriptionUrl ? [{ id: 'legacy', url: result.subscriptionUrl, allowLan: !!result.subscriptionAllowLan }] : []))
      })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить подписки') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [open])

  async function save(nextContent: string, nextEntries: SubscriptionEntry[], successText: string) {
    let saved = false
    try {
      const put = await apiCall<{ success: boolean; error?: string; warning?: string }>('PUT', 'xray-config', { content: nextContent, subscriptions: nextEntries })
      saved = !!put.success
      if (!put.success || put.warning) throw new Error(put.error || put.warning || 'Xray не принял конфигурацию')
      if (state.currentCore === 'xray') {
        dispatch({ type: 'SET_SERVICE_STATUS', status: 'pending', pendingText: 'Обновление Xray...' })
        const restart = await apiCall<{ success: boolean; error?: string }>('POST', 'control', { action: 'hardRestart', core: 'xray' })
        if (!restart.success) throw new Error(restart.error || 'Xray не перезапустился')
        const status = await apiCall<{ success: boolean; running: boolean }>('GET', 'control')
        if (!status.success || !status.running) throw new Error('Xray не запустился после изменения подписок')
        dispatch({ type: 'SET_SERVICE_STATUS', status: 'running' })
      }
      setContent(nextContent); setEntries(nextEntries); setConfirmDelete(null)
      await onApplied()
      showToast(successText)
    } catch (cause) {
      if (saved) {
        const rollback = await apiCall<{ success: boolean }>('PUT', 'xray-config', { content, subscriptions: entries }).catch(() => null)
        if (rollback?.success && state.currentCore === 'xray') await apiCall('POST', 'control', { action: 'hardRestart', core: 'xray' }).catch(() => null)
      }
      if (state.currentCore === 'xray') {
        const status = await apiCall<{ success: boolean; running: boolean }>('GET', 'control').catch(() => null)
        dispatch({ type: 'SET_SERVICE_STATUS', status: status?.running ? 'running' : 'stopped' })
      }
      throw cause
    }
  }

  async function preview(subscriptionUrl: string, local: boolean): Promise<string> {
    if (!/^https:\/\/[^\s]+$/i.test(subscriptionUrl)) throw new Error('Нужна HTTPS ссылка подписки')
    const result = await apiCall<{ success: boolean; content?: string; error?: string; requiresLanAccess?: boolean }>('POST', 'subscription/preview', { url: subscriptionUrl, allow_lan: local })
    if (!result.success || !result.content) {
      if (result.requiresLanAccess) setNeedsLanAccess(true)
      throw new Error(result.error || 'Подписка не загрузилась')
    }
    return result.content
  }

  async function add() {
    const trimmed = url.trim()
    if (entries.length >= 8) return setError('Можно добавить не более 8 подписок')
    if (entries.some((entry) => entry.url === trimmed)) return setError('Эта подписка уже добавлена')
    setBusy(true); setError('')
    try {
      const id = `s${Date.now().toString(36)}`
      const generated = xrayConfigFromSubscription(await preview(trimmed, allowLan), content, id)
      await save(generated.json, [...entries, { id, url: trimmed, allowLan }], `Подписка добавлена: ${generated.count} узлов`)
      setUrl(''); setAllowLan(false); setNeedsLanAccess(false)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось добавить подписку') }
    finally { setBusy(false) }
  }

  async function refresh(entry: SubscriptionEntry) {
    setBusy(true); setError('')
    try {
      const generated = xrayConfigFromSubscription(await preview(entry.url, entry.allowLan || allowLan), content, entry.id)
      await save(generated.json, entries.map(item => item.id === entry.id ? {...item, allowLan: entry.allowLan || allowLan} : item), `Подписка обновлена: ${generated.count} узлов`)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось обновить подписку') }
    finally { setBusy(false) }
  }

  async function remove(entry: SubscriptionEntry) {
    setBusy(true); setError('')
    try { await save(removeXraySubscription(content, entry.id), entries.filter((item) => item.id !== entry.id), 'Подписка удалена') }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось удалить подписку') }
    finally { setBusy(false) }
  }

  return <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
    <DialogContent className="max-h-[90dvh] max-w-[min(94vw,700px)]! overflow-y-auto">
      <DialogHeader><DialogTitle>Подписки Xray</DialogTitle></DialogHeader>
      <p className="text-muted-foreground text-sm">Узлы обновляются отдельно для каждой ссылки. Правила маршрутизации сохраняются. Изменение узлов активного Xray кратко перезапускает ядро.</p>
      <div className="space-y-2">
        {entries.length === 0 && !loading && <p className="text-muted-foreground text-sm">Подписок пока нет.</p>}
        {entries.map((entry, index) => <div key={entry.id} className="border-border flex flex-wrap items-center gap-2 rounded-lg border p-3">
          <div className="min-w-0 flex-1"><div className="font-medium">Подписка {index + 1} · {hostname(entry.url)}</div><div className="text-muted-foreground text-xs">Узлов: {countXraySubscriptionNodes(content, entry.id)}{entry.allowLan ? ' · локальный сервер' : ''}</div></div>
          {confirmDelete === entry.id ? <><span className="text-xs text-amber-400">Используемые маршруты перейдут на другой узел или «Без VPN».</span><Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmDelete(null)}>Отмена</Button><Button size="sm" variant="destructive" disabled={busy} onClick={() => void remove(entry)}>Подтвердить</Button></> : <><Button size="sm" variant="outline" disabled={busy || loading} onClick={() => void refresh(entry)}>Обновить</Button><Button size="sm" variant="outline" disabled={busy || loading} onClick={() => setConfirmDelete(entry.id)}>Удалить</Button></>}
        </div>)}
      </div>
      <div className="border-border space-y-2 border-t pt-3">
        <label htmlFor="xray-new-subscription" className="text-sm font-medium">Добавить подписку</label>
        <Input id="xray-new-subscription" type="password" value={url} disabled={loading || busy} onChange={(event) => setUrl(event.target.value)} placeholder="https://..." autoComplete="off" spellCheck={false} />
        {(needsLanAccess || allowLan) && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={allowLan} disabled={busy} onChange={(event) => setAllowLan(event.target.checked)} />Разрешить локальный сервер</label>}
        <Button disabled={loading || busy || !url.trim()} onClick={() => void add()}>{busy ? 'Сохранение...' : 'Добавить и загрузить'}</Button>
      </div>
      {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
      <div className="flex justify-end"><Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Закрыть</Button></div>
    </DialogContent>
  </Dialog>
}

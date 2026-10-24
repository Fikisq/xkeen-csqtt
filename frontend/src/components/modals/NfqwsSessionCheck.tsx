import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { apiCall } from '@/lib/api'

interface Connection { id: string; protocol: string; remoteIp: string; port: number; sentPackets?: number | null; receivedPackets?: number | null; replyObserved: boolean; waitingSeconds: number; lastSeenSecondsAgo: number }
interface Session { success: boolean; available?: boolean; error?: string; id?: string; running: boolean; deviceIp?: string; service?: string; remainingSeconds?: number; accounting?: boolean; connectionCount?: number; connectionsWithReplies?: number; rows?: Connection[]; confirmation?: boolean | null; reason?: string; gamesRulesEnabled?: boolean }

export function NfqwsSessionCheck() {
  const [open, setOpen] = useState(false)
  const [device, setDevice] = useState('')
  const [service, setService] = useState('roblox')
  const [session, setSession] = useState<Session | null>(null)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!open) return
    let active = true, timer: ReturnType<typeof setTimeout> | undefined
    setLoaded(false)
    async function poll() {
      try {
        const value = await apiCall<Session>('GET', 'nfqws2/session')
        if (!active) return
        setSession(value); setLoaded(true)
        if (value.running) { setDevice(value.deviceIp || ''); setService(value.service || 'roblox') }
        timer = setTimeout(() => void poll(), value.running ? 2000 : 4000)
      } catch (cause) {
        if (active) { setLoaded(true); setError(cause instanceof Error ? cause.message : 'Не удалось получить состояние'); timer = setTimeout(() => void poll(), 4000) }
      }
    }
    void poll()
    return () => { active = false; if (timer) clearTimeout(timer) }
  }, [open])

  async function start() {
    setBusy(true); setError('')
    try {
      const value = await apiCall<Session>('POST', 'nfqws2/session', { deviceIp: device.trim(), service })
      if (!value.success) throw new Error(value.error || 'Не удалось начать наблюдение')
      setSession(await apiCall<Session>('GET', 'nfqws2/session'))
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Ошибка проверки') }
    finally { setBusy(false) }
  }
  async function update(action: 'stop' | 'confirm', works?: boolean) {
    setBusy(true); setError('')
    try {
      const value = await apiCall<Session>('POST', 'nfqws2/session/update', { id: session?.id, action, works })
      if (!value.success) throw new Error(value.error || 'Не удалось обновить проверку')
      setSession(value)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Ошибка проверки') }
    finally { setBusy(false) }
  }
  return <>
    <Button size="sm" variant="outline" onClick={() => { setError(''); setOpen(true) }}>Проверить сеанс</Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex! max-h-[90dvh] max-w-[min(96vw,920px)]! flex-col overflow-hidden">
        <DialogHeader className="shrink-0 pr-8"><DialogTitle>Roblox и голос Discord · проверка сеанса</DialogTitle><DialogDescription>Наблюдение соединений выбранного устройства в течение 90 секунд. Маршруты и стратегия не переключаются.</DialogDescription></DialogHeader>
        <div className="min-h-0 space-y-3 overflow-y-auto pr-1">
          <div className="grid items-end gap-3 sm:grid-cols-2">
            <label className="text-sm font-medium">IP устройства<Input className="mt-1" value={device} disabled={busy || session?.running} onChange={event => setDevice(event.target.value)} placeholder="192.168.1.100" inputMode="decimal" /></label>
            <label className="text-sm font-medium">Сервис<select className="bg-input-background border-border mt-1 h-9 w-full rounded-md border px-2 text-sm" value={service} disabled={busy || session?.running} onChange={event => setService(event.target.value)}><option value="roblox">Roblox</option><option value="discord">Голос Discord</option></select></label>
          </div>
          <div className="rounded-xl border border-border/70 bg-input-background p-3 text-xs text-muted-foreground space-y-2">
            <p>1. Направьте проверяемый трафик устройства через nfqws2. Если он идёт внутри VPN, панель увидит соединение VPN. Не запускайте другие сетевые приложения во время наблюдения.</p>
            <p>2. Нажмите «Начать», затем подключитесь к игре Roblox или голосовому каналу Discord. Если приложение уже открыто — переподключитесь.</p>
            <p>3. После наблюдения подтвердите результат. Ответы в таблице показывают сетевой обмен и сами по себе не подтверждают загрузку игры или наличие звука.</p>
          </div>
          {session?.id && <div className="rounded-xl border border-border/70 bg-input-background p-3 text-sm space-y-2">
            <p className="font-medium">{session.service === 'discord' ? 'Голос Discord' : 'Roblox'} · {session.deviceIp} · {session.running ? `осталось ${session.remainingSeconds} с` : session.reason === 'strategy-changed' ? 'Стратегия или процесс nfqws2 изменились — начните заново' : 'Наблюдение завершено'}</p>
            <p className="text-xs text-muted-foreground">Соединений замечено: {session.connectionCount || 0} · с ответами: {session.connectionsWithReplies || 0}. Выбранный сервис — метка проверки: приложение по одному порту не определяется.</p>
            {!session.gamesRulesEnabled && <p className="text-xs text-yellow-400">Дополнительные правила Roblox и голоса Discord сейчас не сохранены в стратегии.</p>}
            {!session.accounting && <p className="text-xs text-yellow-400">Счётчики пакетов пока недоступны. Показываются новые соединения и изменения состояния ответа; существующий сеанс может не попасть в таблицу.</p>}
            {!session.rows?.length ? <p className="text-muted-foreground text-xs">Подходящих соединений пока нет. Это не означает, что сервис заблокирован.</p> : <div className="overflow-x-auto"><table className="w-full min-w-[540px] text-left text-xs"><thead><tr className="border-b"><th className="py-2">Сервер</th><th>Протокол</th><th>Пакеты → / ←</th><th>Наблюдение</th></tr></thead><tbody>{session.rows.map(row => <tr className="border-b border-border/40" key={row.id}><td className="py-2">{row.remoteIp}:{row.port}</td><td>{row.protocol}</td><td>{row.sentPackets ?? '—'} / {row.receivedPackets ?? '—'}</td><td className={row.replyObserved ? 'text-green-400' : 'text-yellow-400'}>{row.replyObserved ? 'Есть ответы' : row.waitingSeconds >= 10 ? 'Без ответа ≥10 с' : 'Ответа пока нет'}{row.lastSeenSecondsAgo >= 5 ? ' · запись исчезла' : ''}</td></tr>)}</tbody></table></div>}
            {!session.running && session.reason !== 'strategy-changed' && !session.error && <div className="space-y-2 border-t pt-3">
              <p className="text-xs font-medium">{session.service === 'discord' ? 'Вы вошли в канал и слышите собеседника?' : 'Игра загрузилась и можно играть?'}</p>
              <div className="flex flex-wrap gap-2"><Button size="sm" variant={session.confirmation === true ? 'default' : 'outline'} disabled={busy} onClick={() => void update('confirm', true)}>Работает</Button><Button size="sm" variant={session.confirmation === false ? 'default' : 'outline'} disabled={busy} onClick={() => void update('confirm', false)}>Не работает</Button></div>
              {session.confirmation != null && <p className={session.confirmation ? 'text-green-400 text-xs' : 'text-yellow-400 text-xs'}>Подтверждено пользователем: {session.confirmation ? 'работает' : 'не работает'}. Результат относится к этой стратегии и устройству.</p>}
            </div>}
          </div>}
          {(error || session?.error) && <p role="alert" className="text-destructive text-sm">{error || session?.error}</p>}
          {session?.available === false && <p role="alert" className="text-yellow-400 text-sm">Таблица conntrack на этом роутере недоступна.</p>}
          <p className="text-muted-foreground text-xs">Содержимое пакетов не записывается. Результат хранится только в памяти панели до следующей проверки или перезапуска. Закрытие окна не останавливает наблюдение.</p>
        </div>
        <DialogFooter className="shrink-0 border-t pt-3"><Button variant="outline" onClick={() => setOpen(false)}>Закрыть</Button>{session?.running ? <Button disabled={busy} onClick={() => void update('stop')}>Завершить наблюдение</Button> : <Button disabled={busy || !loaded || session?.available === false || !device.trim()} onClick={() => void start()}>{busy ? 'Подготовка…' : 'Начать'}</Button>}</DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}

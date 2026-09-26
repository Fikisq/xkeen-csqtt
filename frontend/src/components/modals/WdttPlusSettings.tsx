import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { apiCall } from '../../lib/api'
import { useAppContext } from '../../lib/store'

interface Settings {
  success: boolean
  server?: string
  dtlsPort?: number
  wgPort?: number
  workers?: number
  hashesCount?: number
  hasManualHashes?: boolean
  hasPassword?: boolean
  rtNetwork?: boolean
  turnSni?: string
  rtMasque?: boolean
  rtMasqueAcceptTos?: boolean
  error?: string
}

export function WdttPlusSettings({ onBack, onRefresh }: { onBack: () => void; onRefresh: () => void }) {
  const { showToast } = useAppContext()
  const [server, setServer] = useState('31.77.146.181')
  const [dtlsPort, setDtlsPort] = useState('56000')
  const [wgPort, setWgPort] = useState('56001')
  const [workers, setWorkers] = useState('27')
  const [hashesCount, setHashesCount] = useState('4')
  const [manualHashes, setManualHashes] = useState('')
  const [hasManualHashes, setHasManualHashes] = useState(false)
  const [password, setPassword] = useState('')
  const [hasPassword, setHasPassword] = useState(false)
  const [rtNetwork, setRtNetwork] = useState(false)
  const [turnSni, setTurnSni] = useState('')
  const [rtMasque, setRtMasque] = useState(false)
  const [rtMasqueAcceptTos, setRtMasqueAcceptTos] = useState(false)
  const [pending, setPending] = useState(false)
  const [restartRequired, setRestartRequired] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void apiCall<Settings>('GET', 'wdtt-plus/settings').then((result) => {
      if (!result.success) throw new Error(result.error || 'Не удалось прочитать WDTT Plus')
      if (result.server) setServer(result.server)
      if (result.dtlsPort) setDtlsPort(String(result.dtlsPort))
      if (result.wgPort) setWgPort(String(result.wgPort))
      if (result.workers) setWorkers(String(result.workers))
      setHashesCount(String(result.hashesCount ?? 4))
      setHasManualHashes(!!result.hasManualHashes)
      setHasPassword(!!result.hasPassword)
      setRtNetwork(!!result.rtNetwork)
      setTurnSni(result.turnSni ?? '')
      setRtMasque(!!result.rtMasque)
      setRtMasqueAcceptTos(!!result.rtMasqueAcceptTos)
    }).catch((cause) => setError(cause instanceof Error ? cause.message : 'Ошибка WDTT Plus'))
  }, [])

  const numberValid = (value: string) => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 65535
  const valid = server.trim().length > 0 && numberValid(dtlsPort) && numberValid(wgPort)
    && Number.isInteger(Number(workers)) && Number(workers) >= 9 && Number(workers) <= 108 && Number(workers) % 9 === 0
    && (hasManualHashes || !!manualHashes.trim())
    && (!rtNetwork || !rtMasque || rtMasqueAcceptTos)

  async function save() {
    setPending(true)
    setError('')
    try {
      const result = await apiCall<{ success: boolean; error?: string }>('PUT', 'wdtt-plus/settings', {
        server: server.trim(), dtlsPort: Number(dtlsPort), wgPort: Number(wgPort), workers: Number(workers),
        hashMode: 'manual', hashesCount: Number(hashesCount), manualHashes: manualHashes.trim(), password,
        rtNetwork, turnSni: turnSni.trim(), rtMasque: rtNetwork && rtMasque, rtMasqueAcceptTos,
      })
      if (!result.success) throw new Error(result.error || 'Не удалось сохранить WDTT Plus')
      if (password) setHasPassword(true)
      if (manualHashes.trim()) setHasManualHashes(true)
      setPassword('')
      setManualHashes('')
      setRestartRequired(true)
      showToast('Настройки WDTT Plus сохранены. Если сервис уже запущен, нажмите «Применить».')
      onRefresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Ошибка WDTT Plus') }
    finally { setPending(false) }
  }

  async function apply() {
    setPending(true)
    setError('')
    try {
      const result = await apiCall<{ success: boolean; error?: string }>('POST', 'wdtt-plus/control', { action: 'restart' })
      if (!result.success) throw new Error(result.error || 'Не удалось применить WDTT Plus')
      setRestartRequired(false)
      showToast('WDTT Plus перезапущен; подключение может занять время')
      onRefresh()
      onBack()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Ошибка WDTT Plus') }
    finally { setPending(false) }
  }

  return <div className="space-y-3">
    <p className="text-muted-foreground text-xs">Клиент WDTT Plus v18 открывает локальный SOCKS5 с UDP для Xray. Панель не создаёт звонки VK: вставьте уже полученные ссылки или хеши.</p>
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <label className="text-sm font-medium">Сервер<Input value={server} onChange={(event) => setServer(event.target.value)} placeholder="31.77.146.181" /></label>
      <label className="text-sm font-medium">DTLS-порт сервера<Input inputMode="numeric" value={dtlsPort} onChange={(event) => setDtlsPort(event.target.value)} /></label>
      <label className="text-sm font-medium">Порт WireGuard на сервере<Input inputMode="numeric" value={wgPort} onChange={(event) => setWgPort(event.target.value)} /></label>
      <label className="text-sm font-medium">Потоки<select className="bg-input-background border-border mt-1 h-9 w-full rounded-md border px-2 text-sm" value={workers} onChange={(event) => setWorkers(event.target.value)}>{Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={(i + 1) * 9}>{(i + 1) * 9}</option>)}</select></label>
      <label className="text-sm font-medium">Пароль туннеля · {hasPassword ? 'сохранён' : 'не сохранён'}<Input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={hasPassword ? 'Пусто = оставить прежний' : 'Введите пароль'} /></label>
    </div>
    <div className="space-y-2"><label className="block text-sm font-medium">Количество хешей<select className="bg-input-background border-border mt-1 h-9 w-full rounded-md border px-2 text-sm" value={hashesCount} onChange={(event) => setHashesCount(event.target.value)}>{[1, 2, 3, 4].map((count) => <option key={count} value={count}>{count}</option>)}</select></label><label className="block text-sm font-medium">Ссылки или хеши VK · {hasManualHashes ? 'сохранены' : 'не сохранены'}<Input type="password" autoComplete="off" value={manualHashes} onChange={(event) => setManualHashes(event.target.value)} placeholder="Через запятую" /></label><p className="text-muted-foreground text-xs">Эти ссылки всё равно относятся к звонкам VK. Получайте их вне панели только от аккаунта, которым готовы пользоваться.</p></div>
    <div className="border-border space-y-2 rounded-md border p-3 text-sm">
      <label className="flex items-center gap-2 font-medium"><input type="checkbox" checked={rtNetwork} onChange={(event) => setRtNetwork(event.target.checked)} />Сеть РТ: сначала TURN/TLS и TURN/TCP, затем UDP</label>
      {rtNetwork && <><label className="block font-medium">SNI белого списка для TURN/TLS<Input value={turnSni} onChange={(event) => setTurnSni(event.target.value)} placeholder="Необязательно · example.com" /></label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={rtMasque} onChange={(event) => setRtMasque(event.target.checked)} />Резерв MASQUE через Cloudflare WARP</label>
        {rtMasque && <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={rtMasqueAcceptTos} onChange={(event) => setRtMasqueAcceptTos(event.target.checked)} />Подтверждаю условия Cloudflare WARP для регистрации MASQUE при первом запуске.</label>}</>}
      <p className="text-muted-foreground text-xs">Новые параметры вступят в силу после «Применить». Режим выключен, пока вы его не включите.</p>
    </div>
    <p className="text-muted-foreground text-xs">Порт WireGuard здесь справочный: рабочую конфигурацию клиент получает от сервера через GETCONF. Пароль и хеши сохраняются с доступом только для root и не возвращаются в панель.</p>
    {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
    <div className="bg-card sticky bottom-0 flex justify-end gap-2 border-t pt-3 pb-1">
      <Button variant="outline" onClick={onBack}>Назад</Button>
      <Button disabled={pending || !valid} onClick={() => void save()}>Сохранить</Button>
      {restartRequired && <Button disabled={pending || !!password} onClick={() => void apply()}>Применить</Button>}
    </div>
  </div>
}

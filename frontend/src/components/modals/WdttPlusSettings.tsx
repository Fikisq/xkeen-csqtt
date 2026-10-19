import { SettingInfo } from '@/components/ui/setting-info'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { apiCall } from '../../lib/api'
import { useAppContext } from '../../lib/store'

interface Settings {
  success: boolean
  clientVersion?: string
  deviceId?: string
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

const selectClass = 'bg-input-background border-border mt-1 h-9 w-full rounded-md border px-2 text-sm'

export function WdttPlusSettings({ onBack, onRefresh }: { onBack: () => void; onRefresh: () => void }) {
  const { showToast } = useAppContext()
  const [server, setServer] = useState('')
  const [dtlsPort, setDtlsPort] = useState('56000')
  const [wgPort, setWgPort] = useState('56001')
  const [workers, setWorkers] = useState('27')
  const [clientVersion, setClientVersion] = useState('')
  const [deviceId, setDeviceId] = useState('')
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
      setClientVersion(result.clientVersion ?? 'v18')
      setDeviceId(result.deviceId ?? '')
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

  return <div className="flex min-h-0 flex-col gap-3"><div className="min-h-0 space-y-3 overflow-y-auto pr-2">
    <p className="text-xs text-green-400">Клиент WDTT Plus {clientVersion}<SettingInfo label="WDTT Plus">Локальный SOCKS5 с UDP для Xray. Использует готовые ссылки звонков VK; панель их для WDTT Plus не создаёт. Сохранение и применение — отдельные действия.</SettingInfo></p>
    {deviceId && <p className="text-muted-foreground break-all text-xs">Device ID:<SettingInfo label="Device ID">Сохранённый идентификатор этого роутера, отправляемый клиентом серверу.</SettingInfo> <span className="select-all">{deviceId}</span></p>}
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <label className="text-sm font-medium">Сервер<SettingInfo label="Сервер">Адрес вашего сервера WDTT Plus без номера порта.</SettingInfo><Input className="mt-1" value={server} onChange={(event) => setServer(event.target.value)} placeholder="Адрес вашего сервера" /></label>
      <label className="text-sm font-medium">DTLS-порт сервера<SettingInfo label="DTLS-порт">Порт туннеля на сервере. Должен совпадать с настройками серверной части.</SettingInfo><Input className="mt-1" inputMode="numeric" value={dtlsPort} onChange={(event) => setDtlsPort(event.target.value)} /></label>
      <label className="text-sm font-medium">Порт WireGuard на сервере<SettingInfo label="Порт WireGuard">Справочное значение: рабочую конфигурацию клиент получает от сервера через GETCONF.</SettingInfo><Input className="mt-1" inputMode="numeric" value={wgPort} onChange={(event) => setWgPort(event.target.value)} /></label>
      <label className="text-sm font-medium">Потоки<SettingInfo label="Потоки">Количество параллельных соединений: 9–108, шаг 9. Большее число может повышать скорость и нагрузку на роутер.</SettingInfo><select className={selectClass} value={workers} onChange={(event) => setWorkers(event.target.value)}>{Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={(i + 1) * 9}>{(i + 1) * 9}</option>)}</select></label>
      <label className="text-sm font-medium">Пароль туннеля <SettingInfo label="Пароль туннеля">Пароль от вашего сервера. Пустое поле оставляет сохранённый пароль; секрет не возвращается в браузер.</SettingInfo><span className={hasPassword ? 'text-green-400' : 'text-amber-400'}>{hasPassword ? '· сохранён' : '· не сохранён'}</span><Input className="mt-1" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={hasPassword ? 'Пусто = оставить прежний' : 'Введите пароль'} /></label>
      <label className="block text-sm font-medium">Количество хешей<SettingInfo label="Количество хешей">Число используемых ручных хешей: от 1 до 4. Это не количество потоков.</SettingInfo><select className={selectClass} value={hashesCount} onChange={(event) => setHashesCount(event.target.value)}>{[1, 2, 3, 4].map((count) => <option key={count} value={count}>{count}</option>)}</select></label>
    </div>
    <Separator />
    <div className="space-y-3">
      <label className="block text-sm font-medium">Ссылки или хеши VK <SettingInfo label="Ссылки и хеши VK">Готовые ссылки звонков VK или хеши через запятую. Получите их вне панели. Пустое поле сохраняет прежние значения.</SettingInfo><span className={hasManualHashes ? 'text-green-400' : 'text-amber-400'}>{hasManualHashes ? '· сохранены' : '· не сохранены'}</span><Input className="mt-1" type="password" autoComplete="off" value={manualHashes} onChange={(event) => setManualHashes(event.target.value)} placeholder="Через запятую" /></label>

    </div>
    <Separator />
    <div className="border-border space-y-3 rounded-xl border bg-background/40 p-3 text-sm">
      <Field orientation="horizontal" className="items-center! gap-4">
        <FieldContent>
          <FieldLabel htmlFor="wdtt-rt-network">TCP/TLS: без внешнего UDP и HTTP/3<SettingInfo label="Режим TCP/TLS">Отдельный режим без внешнего UDP и HTTP/3. Включает настройки TURN/TLS ниже. Изменения действуют после сохранения и «Применить».</SettingInfo></FieldLabel>

        </FieldContent>
        <Switch id="wdtt-rt-network" size="lg" checked={rtNetwork} onCheckedChange={setRtNetwork} aria-label="TCP/TLS" />
      </Field>
      {rtNetwork && <>
        <label className="block font-medium">SNI белого списка для TURN/TLS<SettingInfo label="SNI TURN/TLS">Необязательное имя сервера для подключения TURN по TLS. Должно подходить используемому серверу и сети.</SettingInfo><Input className="mt-1" value={turnSni} onChange={(event) => setTurnSni(event.target.value)} placeholder="Необязательно · example.com" /></label>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="wdtt-rt-masque">Резерв MASQUE через Cloudflare WARP<SettingInfo label="Резерв MASQUE">Необязательный запасной канал при недоступности TURN. Требует отдельного согласия с условиями Cloudflare WARP ниже.</SettingInfo></FieldLabel>

          </FieldContent>
          <Switch id="wdtt-rt-masque" size="sm" checked={rtMasque} onCheckedChange={setRtMasque} aria-label="Резерв MASQUE через Cloudflare WARP" />
        </Field>
        {rtMasque && <Field orientation="horizontal" className="gap-2">
          <FieldContent>
            <FieldDescription className="text-xs">Подтверждаю условия Cloudflare WARP: при первом запуске на сервере выполняется его первичная регистрация. MASQUE — протокол туннеля WARP, отдельный аккаунт не создаётся.</FieldDescription>
          </FieldContent>
          <Switch id="wdtt-rt-masque-tos" size="sm" checked={rtMasqueAcceptTos} onCheckedChange={setRtMasqueAcceptTos} aria-label="Согласие с условиями Cloudflare WARP" />
        </Field>}
      </>}

    </div>

    {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
    </div><div className="bg-card relative z-10 -mx-5 flex shrink-0 justify-end gap-2 border-t px-5 py-4">
      <Button variant="outline" onClick={onBack}>Назад</Button>
      <Button disabled={pending || !valid} onClick={() => void save()}>Сохранить</Button>
      {restartRequired && <Button disabled={pending || !!password} onClick={() => void apply()}>Применить</Button>}
    </div>
  </div>
}

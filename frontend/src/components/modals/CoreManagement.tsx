import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'
import { Input } from '@/components/ui/input'
import { IconCpu, IconX } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { apiCall } from '../../lib/api'
import { useAppContext, useModalContext } from '../../lib/store'
import { WdttPlusSettings } from './WdttPlusSettings'
import { Nfqws2Settings } from './Nfqws2Settings'
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter } from '@/components/ui/alert-dialog'

interface Props {
  onSwitchCore: (core: string) => void
  onOpenUpdate: (core: string) => void
  onOpenSubscriptions: (core: string) => void
  onRefreshStatus: () => void
}

const CORES = [
  { id: 'xray', label: 'Xray' },
  { id: 'mihomo', label: 'Mihomo' },
]

interface CsqttStatus {
  vkApiNotice?: string | null
  installed: boolean
  running: boolean
  interface: boolean
  ready?: boolean
  diagnostic?: string
  clientVersion?: string
}

interface WdttStatus {
  installed: boolean
  running: boolean
  ready: boolean
  attached: boolean
  clientVersion?: string
}

interface NfqwsStatus {
  installed: boolean
  globalReady: boolean
  running: boolean
  mode: 'global' | 'canary'
  device: string
  scope: string
  strategyMode: 'tcp' | 'tcp-quic'
  verifiedTransport: 'tcp' | 'tcp-quic' | 'none' | 'unmeasured'
  blocking: Record<string, string>
}

interface CsqttSpeedResult {
  downloadMbps: number
  uploadMbps: number
  txDropped: number
  rxDropped: number
  interface: string
  endpoint: string
}

export function CoreManageModal({ onSwitchCore, onOpenUpdate, onOpenSubscriptions, onRefreshStatus }: Props) {
  const { state, showToast } = useAppContext()
  const { modals, dispatch } = useModalContext()
  const { currentCore, coreVersions, availableCores, serviceStatus } = state
  const [controlPending, setControlPending] = useState(false)
  const [csqttStatus, setCsqttStatus] = useState<CsqttStatus | null>(null)
  const [wdttStatus, setWdttStatus] = useState<WdttStatus | null>(null)
  const [nfqwsStatus, setNfqwsStatus] = useState<NfqwsStatus | null>(null)
  const [nfqwsError, setNfqwsError] = useState('')
  const [editingWdtt, setEditingWdtt] = useState(false)
  const [editingNfqws, setEditingNfqws] = useState(false)
  const [wdttError, setWdttError] = useState('')
  const [editingCsqtt, setEditingCsqtt] = useState(false)
  const [showCsqttSpeedtest, setShowCsqttSpeedtest] = useState(false)
  const [speedtestPending, setSpeedtestPending] = useState(false)
  const [speedtestResult, setSpeedtestResult] = useState<CsqttSpeedResult | null>(null)
  const [speedtestError, setSpeedtestError] = useState('')
  const [csqttHashes, setCsqttHashes] = useState('4')
  const [csqttClientVersion, setCsqttClientVersion] = useState('2.0')
  const [csqttWorkers, setCsqttWorkers] = useState('81')
  const [csqttHashMode, setCsqttHashMode] = useState('auto_js')
  const [csqttObfs, setCsqttObfs] = useState('audio')
  const [csqttTurnTransport, setCsqttTurnTransport] = useState('udp')
  const [csqttPeer, setCsqttPeer] = useState('')
  const [csqttPassword, setCsqttPassword] = useState('')
  const [csqttVkToken, setCsqttVkToken] = useState('')
  const [csqttManualHashes, setCsqttManualHashes] = useState('')
  const [csqttHasManualHashes, setCsqttHasManualHashes] = useState(false)
  const [csqttLink, setCsqttLink] = useState('')
  const [csqttLinkParsed, setCsqttLinkParsed] = useState(false)
  const [csqttHasPassword, setCsqttHasPassword] = useState(false)
  const [csqttHasVkToken, setCsqttHasVkToken] = useState(false)
  const [csqttError, setCsqttError] = useState('')
  const [savingCsqtt, setSavingCsqtt] = useState(false)
  const [generatingCsqtt, setGeneratingCsqtt] = useState(false)
  const [csqttRestartRequired, setCsqttRestartRequired] = useState(false)
  const [csqttSavedValues, setCsqttSavedValues] = useState({ hashes: 4, workers: 81, peer: '', hashMode: 'auto_js', obfs: 'audio', turnTransport: 'udp' })
  const validCsqttNumbers = Number.isInteger(Number(csqttHashes)) && Number(csqttHashes) >= 1 && Number(csqttHashes) <= 6
    && Number.isInteger(Number(csqttWorkers)) && Number(csqttWorkers) >= 9 && Number(csqttWorkers) <= 126 && Number(csqttWorkers) % 9 === 0

  function parseCsqttLink() {
    try {
      const link = new URL(csqttLink.trim())
      if (link.protocol !== 'csqtt:') throw new Error('Нужна ссылка csqtt://')
      const host = link.searchParams.get('host') || link.hostname
      const port = link.searchParams.get('peer') || link.port
      const password = link.searchParams.get('password') || decodeURIComponent(link.username)
      if (!host || !port || !password) throw new Error('В ссылке не найдены сервер, порт или пароль')
      setCsqttPeer(`${host}:${port}`)
      setCsqttPassword(password)
      setCsqttLink('')
      setCsqttLinkParsed(true)
      setCsqttError('')
      showToast('Ссылка CSQTT разобрана. Сохраните и примените параметры.')
    } catch (error) { setCsqttError(error instanceof Error ? error.message : 'Не удалось разобрать ссылку CSQTT') }
  }

  async function openCsqttSettings() {
    setCsqttError('')
    try {
      const result = await apiCall<{ success: boolean; hashes?: number; workers?: number; peer?: string; hashMode?: string; obfs?: string; turnTransport?: string; hasPassword?: boolean; hasVkToken?: boolean; hasManualHashes?: boolean; clientVersion?: string; error?: string }>('GET', 'csqtt/settings')
      if (!result.success || !result.hashes || !result.workers) throw new Error(result.error || 'Не удалось прочитать параметры CSQTT')
      setCsqttHashes(String(result.hashes))
      setCsqttClientVersion(result.clientVersion ?? '2.0')
      setCsqttWorkers(String(result.workers))
      setCsqttPeer(result.peer ?? '')
      setCsqttHashMode(result.hashMode ?? 'auto_js')
      setCsqttObfs(result.obfs ?? 'audio')
      setCsqttTurnTransport(result.turnTransport ?? 'udp')
      setCsqttPassword('')
      setCsqttVkToken('')
      setCsqttManualHashes('')
      setCsqttHasManualHashes(!!result.hasManualHashes)
      setCsqttLink('')
      setCsqttLinkParsed(false)
      setCsqttHasPassword(!!result.hasPassword)
      setCsqttHasVkToken(!!result.hasVkToken)
      setCsqttSavedValues({ hashes: result.hashes, workers: result.workers, peer: result.peer ?? '', hashMode: result.hashMode ?? 'auto_js', obfs: result.obfs ?? 'audio', turnTransport: result.turnTransport ?? 'udp' })
      setEditingCsqtt(true)
    } catch (error) { setCsqttError(error instanceof Error ? error.message : 'Ошибка CSQTT') }
  }

  async function saveCsqttSettings() {
    setSavingCsqtt(true)
    setCsqttError('')
    try {
      const result = await apiCall<{ success: boolean; error?: string }>('PUT', 'csqtt/settings', {
        hashes: Number(csqttHashes), workers: Number(csqttWorkers), peer: csqttPeer.trim(),
        password: csqttPassword, vkToken: csqttVkToken.trim(), hashMode: csqttHashMode,
        obfs: csqttObfs, turnTransport: csqttTurnTransport, manualHashes: csqttManualHashes.trim(),
      })
      if (!result.success) throw new Error(result.error || 'Не удалось сохранить параметры CSQTT')
      setCsqttRestartRequired(true)
      setCsqttSavedValues({ hashes: Number(csqttHashes), workers: Number(csqttWorkers), peer: csqttPeer.trim(), hashMode: csqttHashMode, obfs: csqttObfs, turnTransport: csqttTurnTransport })
      if (csqttPassword) setCsqttHasPassword(true)
      if (csqttVkToken) setCsqttHasVkToken(true)
      if (csqttManualHashes.trim()) setCsqttHasManualHashes(true)
      setCsqttPassword('')
      setCsqttVkToken('')
      setCsqttManualHashes('')
      setCsqttLinkParsed(false)
      showToast('Параметры CSQTT сохранены. Нажмите «Применить» для перезапуска CSQTT.')
    } catch (error) { setCsqttError(error instanceof Error ? error.message : 'Ошибка CSQTT') }
    finally { setSavingCsqtt(false) }
  }

  async function generateCsqttManualHashes() {
    setGeneratingCsqtt(true)
    setCsqttError('')
    try {
      const result = await apiCall<{ success: boolean; hashes?: string; error?: string }>('POST', 'csqtt/manual-hashes', { count: Number(csqttHashes) })
      if (!result.success || !result.hashes) throw new Error(result.error || 'VK не вернул хеши')
      setCsqttManualHashes(result.hashes)
      showToast(`${csqttHashes} хеш(а) создано. Сохраните и примените настройки в течение 10 минут.`)
    } catch (error) { setCsqttError(error instanceof Error ? error.message : 'Не удалось создать хеши') }
    finally { setGeneratingCsqtt(false) }
  }

  async function restartCsqtt() {
    setSavingCsqtt(true)
    setCsqttError('')
    try {
      const result = await apiCall<{ success: boolean; error?: string }>('POST', 'csqtt/restart', {})
      if (!result.success) throw new Error(result.error || 'Не удалось перезапустить CSQTT')
      setCsqttRestartRequired(false)
      setEditingCsqtt(false)
      await refreshCsqttStatus()
      showToast('CSQTT перезапущен с сохранёнными параметрами')
    } catch (error) { setCsqttError(error instanceof Error ? error.message : 'Ошибка CSQTT') }
    finally { setSavingCsqtt(false) }
  }

  async function refreshCsqttStatus() {
    try {
      setCsqttStatus(await apiCall<CsqttStatus>('GET', 'csqtt/status'))
    } catch {
      setCsqttStatus(null)
    }
  }

  async function runCsqttSpeedtest() {
    setSpeedtestPending(true)
    setSpeedtestError('')
    setSpeedtestResult(null)
    try {
      const response = await apiCall<{ success: boolean; result?: CsqttSpeedResult; error?: string }>('POST', 'csqtt/speedtest', {})
      if (!response.success || !response.result) throw new Error(response.error || 'Замер не завершился')
      setSpeedtestResult(response.result)
    } catch (error) { setSpeedtestError(error instanceof Error ? error.message : 'Ошибка замера скорости') }
    finally { setSpeedtestPending(false) }
  }

  async function refreshWdttStatus() {
    try { setWdttStatus(await apiCall<WdttStatus>('GET', 'wdtt-plus/status')) }
    catch { setWdttStatus(null) }
  }

  async function refreshNfqwsStatus() {
    try { setNfqwsStatus(await apiCall<NfqwsStatus>('GET', 'nfqws2/status')) }
    catch { setNfqwsStatus(null) }
  }

  async function controlNfqws(action: 'start' | 'stop') {
    setControlPending(true)
    setNfqwsError('')
    try {
      const result = await apiCall<{ success: boolean; error?: string }>('POST', 'nfqws2/control', { action })
      if (!result.success) throw new Error(result.error || 'Не удалось изменить состояние nfqws2')
      await refreshNfqwsStatus()
      showToast(action === 'start' ? 'nfqws2 запущен' : 'nfqws2 остановлен; очередь пропускает трафик')
    } catch (error) { setNfqwsError(error instanceof Error ? error.message : 'Ошибка nfqws2') }
    finally { setControlPending(false) }
  }

  async function attachNfqwsToXray() {
    if (!window.confirm('Подключить nfqws2 к маршрутизации Xray? Xray перезапустится, поэтому действующие VPN-соединения кратковременно прервутся.')) return
    setControlPending(true)
    setNfqwsError('')
    try {
      const result = await apiCall<{ success: boolean; error?: string }>('POST', 'nfqws2/attach-xray', {})
      if (!result.success) throw new Error(result.error || 'Не удалось подключить nfqws2 к Xray')
      showToast('nfqws2 подключён к Xray; теперь его можно выбрать в маршрутах')
      window.location.reload()
    } catch (error) { setNfqwsError(error instanceof Error ? error.message : 'Ошибка подключения nfqws2') }
    finally { setControlPending(false) }
  }

  async function manageAddon(addon: 'csqtt' | 'wdtt-plus' | 'nfqws2', action: 'install' | 'remove') {
    const name = addon === 'csqtt' ? 'CSQTT' : addon === 'wdtt-plus' ? 'WDTT Plus' : 'nfqws2 · zapret2'
    setAddonConfirmation({ addon, action, name })
  }

  const [addonConfirmation, setAddonConfirmation] = useState<{ addon: 'csqtt' | 'wdtt-plus' | 'nfqws2'; action: 'install' | 'remove'; name: string } | null>(null)

  async function submitAddon() {
    if (!addonConfirmation) return
    const { addon, action, name } = addonConfirmation
    setControlPending(true)
    setCsqttError('')
    setWdttError('')
    setNfqwsError('')
    try {
      const result = await apiCall<{ success: boolean; restarted?: boolean; error?: string }>('POST', `addons/${action}`, { addon, confirm: true })
      if (!result.success) throw new Error(result.error || `Не удалось ${action === 'remove' ? 'удалить' : 'установить'} ${name}`)
      await Promise.all([refreshCsqttStatus(), refreshWdttStatus(), refreshNfqwsStatus()])
      showToast(`${name} ${action === 'remove' ? 'удалён' : 'установлен'}${result.restarted ? '; Xray перезапущен' : ''}`)
      if (result.restarted) window.location.reload()
      else onRefreshStatus()
    } catch (error) {
      const message = error instanceof Error ? error.message : `Ошибка управления ${name}`
      if (addon === 'csqtt') setCsqttError(message)
      else if (addon === 'wdtt-plus') setWdttError(message)
      else setNfqwsError(message)
    } finally { setControlPending(false); setAddonConfirmation(null) }
  }

  async function controlWdtt(action: 'start' | 'stop' | 'restart') {
    setControlPending(true)
    setWdttError('')
    try {
      const result = await apiCall<{ success: boolean; error?: string }>('POST', 'wdtt-plus/control', { action })
      if (!result.success) throw new Error(result.error || 'Не удалось управлять WDTT Plus')
      showToast(action === 'stop' ? 'WDTT Plus остановлен' : 'WDTT Plus запускается; VK-звонки и SOCKS5 появятся после подключения')
      await refreshWdttStatus()
    } catch (error) { setWdttError(error instanceof Error ? error.message : 'Ошибка WDTT Plus') }
    finally { setControlPending(false) }
  }

  async function attachWdttToXray() {
    setControlPending(true)
    setWdttError('')
    try {
      const result = await apiCall<{ success: boolean; restarted?: boolean; error?: string }>('POST', 'wdtt-plus/attach-xray', {})
      if (!result.success) throw new Error(result.error || 'Не удалось добавить WDTT Plus в Xray')
      showToast(result.restarted ? 'WDTT Plus добавлен, Xray перезапущен с новым узлом' : 'WDTT Plus добавлен; Xray загрузит узел при переключении')
      await refreshWdttStatus()
      close()
      window.location.reload()
    } catch (error) { setWdttError(error instanceof Error ? error.message : 'Ошибка WDTT Plus') }
    finally { setControlPending(false) }
  }

  async function controlService(action: 'start' | 'stop' | 'hardRestart') {
    setControlPending(true)
    dispatch({ type: 'SET_SERVICE_STATUS', status: 'pending', pendingText: 'Управление ядром...' })
    try {
      const result = await apiCall<{ success: boolean; error?: string; output?: string }>('POST', 'control', { action })
      showToast(result.success ? action === 'start' ? 'Ядро запущено' : action === 'stop' ? 'Ядро остановлено' : 'Ядро перезапущено' : result.error || result.output || 'Ошибка управления ядром', result.success ? 'success' : 'error')
    } catch (error) { showToast(error instanceof Error ? error.message : 'Ошибка управления ядром', 'error') }
    finally { setControlPending(false); onRefreshStatus() }
  }

  async function controlCsqtt(action: 'start' | 'stop' | 'restart') {
    setControlPending(true)
    setCsqttError('')
    try {
      const result = await apiCall<{ success: boolean; error?: string }>('POST', 'csqtt/control', { action })
      if (!result.success) throw new Error(result.error || 'Не удалось управлять CSQTT')
      showToast(action === 'start' ? 'Процесс CSQTT запущен; проверяем туннель' : action === 'stop' ? 'CSQTT остановлен' : 'Процесс CSQTT перезапущен; проверяем туннель')
      await refreshCsqttStatus()
    } catch (error) { setCsqttError(error instanceof Error ? error.message : 'Ошибка CSQTT') }
    finally { setControlPending(false) }
  }

  useEffect(() => {
    if (modals.showCoreManageModal) {
      void refreshCsqttStatus()
      void refreshWdttStatus()
      void refreshNfqwsStatus()
    }
  }, [modals.showCoreManageModal])

  useEffect(() => {
    if (!modals.showCoreManageModal) return
    const timer = window.setInterval(() => { void refreshCsqttStatus(); void refreshWdttStatus(); void refreshNfqwsStatus() }, 5000)
    return () => window.clearInterval(timer)
  }, [modals.showCoreManageModal])

  const close = () => {
    setEditingCsqtt(false)
    setEditingWdtt(false)
    setEditingNfqws(false)
    setShowCsqttSpeedtest(false)
    setCsqttPassword('')
    setCsqttVkToken('')
    setCsqttManualHashes('')
    setCsqttLink('')
    setCsqttLinkParsed(false)
    dispatch({ type: 'SHOW_MODAL', modal: 'showCoreManageModal', show: false })
  }

  const closeCurrentView = () => {
    if (showCsqttSpeedtest) { setShowCsqttSpeedtest(false); return }
    if (editingWdtt) { setEditingWdtt(false); return }
    if (editingNfqws) { setEditingNfqws(false); return }
    if (editingCsqtt) { setEditingCsqtt(false); return }
    close()
  }

  return (
    <>
    <Dialog open={modals.showCoreManageModal} onOpenChange={(open) => !open && closeCurrentView()}>
      <DialogContent showCloseButton={!editingCsqtt && !editingWdtt && !editingNfqws && !showCsqttSpeedtest} className={editingCsqtt || editingWdtt || editingNfqws ? 'max-h-[95dvh] max-w-[min(96vw,900px)]! overflow-y-auto' : 'max-w-[min(96vw,760px)]!'}>
        {(editingCsqtt || editingWdtt || editingNfqws || showCsqttSpeedtest) && <Button variant="ghost" size="icon" className="text-ring hover:bg-muted! absolute top-4 right-4 transition-colors hover:text-white" aria-label="Вернуться к управлению ядром" onClick={closeCurrentView}><IconX className="size-6" /></Button>}
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pb-3">
          <IconCpu size={24} className="text-chart-2" /> {showCsqttSpeedtest ? 'Скорость CSQTT' : editingWdtt ? 'Настройка WDTT Plus' : editingCsqtt ? 'Настройка CSQTT' : editingNfqws ? 'Настройка nfqws2' : 'Управление ядром'}
          </DialogTitle>
        </DialogHeader>

        {showCsqttSpeedtest ? <div className="space-y-4">
          <p className="text-muted-foreground text-sm">Замер с роутера через интерфейс csqtt0. Показывает скорость до Cloudflare и не меняет маршруты устройств.</p>
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-muted/30 rounded-lg border p-4"><p className="text-muted-foreground text-sm">Загрузка</p><p className="text-2xl font-semibold">{speedtestResult ? speedtestResult.downloadMbps.toFixed(2) : '—'} <span className="text-sm font-normal">Мбит/с</span></p></div>
            <div className="bg-muted/30 rounded-lg border p-4"><p className="text-muted-foreground text-sm">Отдача</p><p className="text-2xl font-semibold">{speedtestResult ? speedtestResult.uploadMbps.toFixed(2) : '—'} <span className="text-sm font-normal">Мбит/с</span></p></div>
          </div>
          {speedtestResult && <p className="text-muted-foreground text-xs">Интерфейс: {speedtestResult.interface} · узел замера: {speedtestResult.endpoint} · отброшено пакетов: исходящих {speedtestResult.txDropped}, входящих {speedtestResult.rxDropped}</p>}
          {speedtestError && <p role="alert" className="text-sm text-red-500">{speedtestError}</p>}
          <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setShowCsqttSpeedtest(false)}>Назад</Button><Button disabled={speedtestPending || !csqttStatus?.ready} onClick={() => void runCsqttSpeedtest()}>{speedtestPending ? 'Измеряется…' : 'Начать замер'}</Button></div>
        </div> : editingWdtt ? <WdttPlusSettings onBack={() => setEditingWdtt(false)} onRefresh={() => void refreshWdttStatus()} /> : editingNfqws ? <Nfqws2Settings onBack={() => setEditingNfqws(false)} onRefresh={() => void refreshNfqwsStatus()} /> : editingCsqtt ? <div className="space-y-2">
          <p className="text-xs text-green-400">Клиент CSQTT {csqttClientVersion}</p>
          <p className="text-muted-foreground text-xs">Ссылка разбирается на адрес и пароль; исходная ссылка не хранится. Сохранённые секреты скрыты. Пустые поля пароля и токена оставляют прежние значения. Изменения вступят в силу после «Применить».</p>
          <p className="text-muted-foreground text-xs">Ручной использует сохранённые ссылки или хеши VK. Авто API создаёт звонки через calls.start и завершает их при остановке. Авто ВК использует встроенный вход клиента.</p>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
            <label className="min-w-0 text-sm font-medium">Ссылка CSQTT<Input type="password" autoComplete="off" value={csqttLink} onChange={(event) => setCsqttLink(event.target.value)} placeholder="csqtt://connect?..." /></label>
            <Button size="sm" variant="outline" disabled={!csqttLink.trim()} onClick={parseCsqttLink}>Разобрать</Button>
          </div>
          {csqttLinkParsed && <p className="text-xs text-green-400">Ссылка разобрана. Адрес и пароль будут сохранены после нажатия «Сохранить».</p>}
          {!csqttLinkParsed && csqttPeer && <p className="text-xs text-green-400">Адрес CSQTT сохранён. Исходная ссылка намеренно не показывается.</p>}
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <label className="min-w-0 text-sm font-medium">Сервер:порт<Input value={csqttPeer} onChange={(event) => setCsqttPeer(event.target.value)} placeholder="server.example:46000" /></label>
            <label className="min-w-0 text-sm font-medium">Пароль сервера <span className={csqttHasPassword ? 'text-green-400' : 'text-amber-400'}>{csqttHasPassword ? '· сохранён' : '· не сохранён'}</span><Input type="password" autoComplete="new-password" value={csqttPassword} onChange={(event) => setCsqttPassword(event.target.value)} placeholder={csqttHasPassword ? 'Новый пароль (пусто = без изменений)' : 'Введите пароль'} /></label>
            <label className="min-w-0 text-sm font-medium">VK OAuth access_token <span className={csqttHasVkToken ? 'text-green-400' : 'text-amber-400'}>{csqttHasVkToken ? '· сохранён' : '· не сохранён'}</span><Input type="password" autoComplete="off" value={csqttVkToken} onChange={(event) => setCsqttVkToken(event.target.value)} placeholder={csqttHasVkToken ? 'Новый токен (пусто = без изменений)' : 'Введите токен'} /></label>
            <div className="grid grid-cols-2 gap-2">
              {csqttClientVersion === '2.1.9' && csqttHashMode === 'auto_js'
                ? <label className="min-w-0 text-sm font-medium">Звонки<Input className="mt-1" value="1 · Авто ВК" readOnly /></label>
                : <label className="min-w-0 text-sm font-medium">Хеши{csqttHashMode === 'auto_api' ? ' · автоматически' : ''}<select className="bg-input-background border-border mt-1 h-9 w-full rounded-md border px-2 text-sm disabled:opacity-50" value={csqttHashes} disabled={csqttHashMode === 'auto_api'} onChange={(event) => setCsqttHashes(event.target.value)}>{Array.from({ length: 6 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}</select></label>}
              <label className="min-w-0 text-sm font-medium">Потоки<select className="bg-input-background border-border mt-1 h-9 w-full rounded-md border px-2 text-sm" value={csqttWorkers} onChange={(event) => setCsqttWorkers(event.target.value)}>{Array.from({ length: 14 }, (_, i) => <option key={(i + 1) * 9} value={(i + 1) * 9}>{(i + 1) * 9}</option>)}</select></label>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground text-xs">ARM64:</span>
            <Button size="sm" variant="outline" onClick={() => { setCsqttHashes('1'); setCsqttWorkers('27') }}>{csqttClientVersion === '2.1.9' ? '27 потоков' : '1 / 27'}</Button>
            <Button size="sm" variant="outline" onClick={() => { setCsqttHashes('2'); setCsqttWorkers('36') }}>{csqttClientVersion === '2.1.9' ? '36 потоков' : '2 / 36'}</Button>
            <Button size="sm" variant="outline" onClick={() => { setCsqttHashes('1'); setCsqttWorkers('9') }}>{csqttClientVersion === '2.1.9' ? 'Диагностика: 9 потоков' : 'Диагностика 1 / 9'}</Button>
            <span className="text-muted-foreground text-xs">Потоки 9–126, шаг 9</span>
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            <label className="text-sm font-medium">Режим хешей<select className="bg-input-background border-border mt-1 h-9 w-full rounded-md border px-2 text-sm" value={csqttHashMode} onChange={(event) => setCsqttHashMode(event.target.value)}><option value="manual">Ручной</option><option value="auto_api">Авто API</option><option value="auto_js">Авто ВК</option></select></label>
            <label className="text-sm font-medium">Маскировка<select className="bg-input-background border-border mt-1 h-9 w-full rounded-md border px-2 text-sm" value={csqttObfs} onChange={(event) => setCsqttObfs(event.target.value)}><option value="audio">Простая</option><option value="video">Средняя</option></select></label>
            <label className="text-sm font-medium">Транспорт<select className="bg-input-background border-border mt-1 h-9 w-full rounded-md border px-2 text-sm" value={csqttTurnTransport} onChange={(event) => setCsqttTurnTransport(event.target.value)}><option value="udp">UDP</option><option value="tcp_tls">TCP (TLS при turns:)</option></select></label>
          </div>
          {csqttHashMode === 'manual' && <div className="space-y-2"><label className="block text-sm font-medium">Ссылки или хеши VK <span className={csqttHasManualHashes ? 'text-green-400' : 'text-amber-400'}>{csqttHasManualHashes ? '· сохранены' : '· не сохранены'}</span><Input type="password" autoComplete="off" value={csqttManualHashes} onChange={(event) => setCsqttManualHashes(event.target.value)} placeholder={csqttHasManualHashes ? 'Новые ссылки через запятую (пусто = без изменений)' : 'До 6 ссылок через запятую'} /></label><Button size="sm" variant="outline" disabled={generatingCsqtt || !validCsqttNumbers || !csqttHasVkToken} onClick={() => void generateCsqttManualHashes()}>{generatingCsqtt ? 'Создание звонков…' : `Создать и заполнить ${csqttHashes} хеш(а)`}</Button><p className="text-muted-foreground text-xs">Нужен сохранённый VK-токен. После генерации сохраните и примените настройки в течение 10 минут; незадействованные звонки завершатся автоматически.</p></div>}
          {csqttHashMode === 'auto_api' && <p className="text-muted-foreground text-xs">Авто API создаст {Math.ceil(Number(csqttWorkers) / 27)} звонка(ов) для {csqttWorkers} потоков: один звонок на каждые 27 потоков. Значение поля «Хеши» в этом режиме не используется. Нужен сохранённый VK-токен.</p>}
          {csqttClientVersion === '2.1.9' && csqttHashMode === 'auto_js' && <p className="text-muted-foreground text-xs">Авто ВК создаёт один звонок и распределяет потоки по учётным данным этого звонка. Поле «Хеши» не используется.</p>}
          {csqttError && <p role="alert" className="text-sm text-red-500">{csqttError}</p>}
          <div className="bg-card sticky bottom-0 flex justify-end gap-2 border-t pt-3 pb-1"><Button variant="outline" onClick={() => setEditingCsqtt(false)}>Назад</Button><Button disabled={savingCsqtt || !validCsqttNumbers || !csqttPeer.trim() || (csqttHashMode === 'manual' && !csqttHasManualHashes && !csqttManualHashes.trim())} onClick={saveCsqttSettings}>Сохранить</Button>{csqttRestartRequired && <Button disabled={savingCsqtt || Number(csqttHashes) !== csqttSavedValues.hashes || Number(csqttWorkers) !== csqttSavedValues.workers || csqttPeer.trim() !== csqttSavedValues.peer || csqttHashMode !== csqttSavedValues.hashMode || csqttObfs !== csqttSavedValues.obfs || csqttTurnTransport !== csqttSavedValues.turnTransport || !!csqttPassword || !!csqttVkToken || !!csqttManualHashes} onClick={restartCsqtt}>Применить</Button>}</div>
        </div> : <div className="space-y-4">
          {CORES.map((core, i) => {
            const isActive = currentCore === core.id
            const isInstalled = availableCores.includes(core.id)
            const version = coreVersions[core.id as keyof typeof coreVersions]

            return (
              <div key={core.id}>
                {i > 0 && <Separator className="mb-4" />}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-medium">{core.label}</span>
                      {isActive && (
                        <Badge variant="outline" className="rounded-sm border-none bg-green-500/10 px-2 text-xs text-green-400">
                          Активно
                        </Badge>
                      )}
                      {!isInstalled && (
                        <Badge variant="outline" className="rounded-sm border-none bg-red-500/10 px-2 text-xs text-red-400">
                          Не установлено
                        </Badge>
                      )}
                    </div>
                    {isInstalled && <p className="text-muted-foreground mt-0.5 text-xs">{version || 'Установлено'}</p>}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {isInstalled && <Button variant="outline" size="sm" onClick={() => { close(); onOpenSubscriptions(core.id) }}>Подписки</Button>}
                    {!isActive && isInstalled && (
                      <Button
                        size="sm"
                        disabled={controlPending || serviceStatus === 'pending'}
                        onClick={() => {
                          close()
                          onSwitchCore(core.id)
                        }}
                      >
                        Переключить
                      </Button>
                    )}
                    {isActive && <>
                      {serviceStatus === 'running' ? <>
                        <Button variant="outline" size="sm" disabled={controlPending} onClick={() => void controlService('hardRestart')}>Перезапустить</Button>
                        <Button variant="outline" size="sm" disabled={controlPending} onClick={() => void controlService('stop')}>Остановить</Button>
                      </> : <Button variant="outline" size="sm" disabled={controlPending || serviceStatus === 'pending'} onClick={() => void controlService('start')}>Запустить</Button>}
                    </>}
                    {!isInstalled && <Button variant="outline" size="sm" onClick={() => { close(); onOpenUpdate(core.id) }}>Установить</Button>}
                  </div>
                </div>
              </div>
            )
          })}
          <Separator />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium">CSQTT</span>
                {csqttStatus && (
                  <Badge variant="outline" className={csqttStatus.running ? 'rounded-sm border-none bg-green-500/10 px-2 text-xs text-green-400' : 'rounded-sm border-none bg-amber-500/10 px-2 text-xs text-amber-400'}>
                    {csqttStatus.ready ? 'Адрес получен' : csqttStatus.running ? 'Нет туннеля' : csqttStatus.installed ? 'Остановлен' : 'Не установлен'}
                  </Badge>
                )}
              </div>
              <p className="text-muted-foreground mt-0.5 text-xs">Отдельный сервис{csqttStatus?.clientVersion ? ` · v${csqttStatus.clientVersion}` : ''}{csqttStatus?.interface ? ' · интерфейс csqtt0 доступен' : ''}</p>
              {csqttStatus?.vkApiNotice && <p className="mt-1 max-w-100 text-xs text-amber-400">{csqttStatus.vkApiNotice}</p>}
              {csqttStatus && !csqttStatus.ready && (csqttStatus.running || csqttStatus.diagnostic) && <p className="mt-1 max-w-100 text-xs text-amber-400">{csqttStatus.diagnostic || 'Клиент запущен, но адрес туннеля ещё не получен'}</p>}
            </div>
            <div className="ml-auto flex max-w-full flex-wrap justify-end gap-2">
              <Button variant="outline" size="sm" disabled={!csqttStatus?.installed} onClick={() => void openCsqttSettings()}>Настроить</Button>
              <Button variant="outline" size="sm" disabled={!csqttStatus?.installed} onClick={() => { setSpeedtestResult(null); setSpeedtestError(''); setShowCsqttSpeedtest(true) }}>Замер скорости</Button>
              {csqttStatus?.installed && (csqttStatus.running ? <>
                <Button variant="outline" size="sm" disabled={controlPending} onClick={() => void controlCsqtt('restart')}>Перезапустить</Button>
                <Button variant="outline" size="sm" disabled={controlPending} onClick={() => void controlCsqtt('stop')}>Остановить</Button>
              </> : <>
                <Button variant="outline" size="sm" disabled={controlPending || Boolean(csqttStatus.vkApiNotice)} onClick={() => void controlCsqtt('start')}>Запустить</Button>
                {csqttStatus.vkApiNotice && <Button variant="outline" size="sm" disabled={controlPending} onClick={() => void controlCsqtt('stop')}>Остановить</Button>}
              </>)}
              <Button variant="outline" size="sm" disabled={controlPending} onClick={() => void refreshCsqttStatus()}>Обновить статус</Button>
              {csqttStatus && <Button variant="outline" size="sm" disabled={controlPending} onClick={() => void manageAddon('csqtt', csqttStatus.installed ? 'remove' : 'install')}>{csqttStatus.installed ? 'Удалить' : 'Установить'}</Button>}
            </div>
          </div>
          {csqttError && <p role="alert" className="text-sm text-red-500">{csqttError}</p>}
          <Separator />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium">WDTT Plus</span>
                {wdttStatus && <Badge variant="outline" className={wdttStatus.ready ? 'rounded-sm border-none bg-green-500/10 px-2 text-xs text-green-400' : 'rounded-sm border-none bg-amber-500/10 px-2 text-xs text-amber-400'}>{wdttStatus.ready ? 'Туннель отвечает' : wdttStatus.running ? 'Туннель не отвечает' : wdttStatus.installed ? 'Остановлен' : 'Не установлен'}</Badge>}
              </div>
              <p className="text-muted-foreground mt-0.5 text-xs">Отдельный сервис · {wdttStatus?.clientVersion ?? 'v18'} · SOCKS5 с UDP · {wdttStatus?.attached ? 'узел Xray добавлен' : 'узел Xray не добавлен'}</p>
            </div>
            <div className="ml-auto flex max-w-full flex-wrap justify-end gap-2">
              <Button variant="outline" size="sm" disabled={!wdttStatus?.installed} onClick={() => setEditingWdtt(true)}>Настроить</Button>
              {wdttStatus?.installed && (wdttStatus.running ? <>
                <Button variant="outline" size="sm" disabled={controlPending} onClick={() => void controlWdtt('restart')}>Перезапустить</Button>
                <Button variant="outline" size="sm" disabled={controlPending} onClick={() => void controlWdtt('stop')}>Остановить</Button>
              </> : <Button variant="outline" size="sm" disabled={controlPending} onClick={() => void controlWdtt('start')}>Запустить</Button>)}
              {wdttStatus?.ready && !wdttStatus.attached && <Button variant="outline" size="sm" disabled={controlPending} onClick={() => void attachWdttToXray()}>Добавить в Xray</Button>}
              <Button variant="outline" size="sm" disabled={controlPending} onClick={() => void refreshWdttStatus()}>Обновить статус</Button>
              {wdttStatus && <Button variant="outline" size="sm" disabled={controlPending} onClick={() => void manageAddon('wdtt-plus', wdttStatus.installed ? 'remove' : 'install')}>{wdttStatus.installed ? 'Удалить' : 'Установить'}</Button>}
            </div>
          </div>
          {wdttError && <p role="alert" className="text-sm text-red-500">{wdttError}</p>}
          <Separator />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium">nfqws2 · zapret2</span>
                {nfqwsStatus && <Badge variant="outline" className={nfqwsStatus.running ? 'rounded-sm border-none bg-green-500/10 px-2 text-xs text-green-400' : 'rounded-sm border-none bg-amber-500/10 px-2 text-xs text-amber-400'}>{nfqwsStatus.running ? nfqwsStatus.mode === 'global' ? 'Активен' : 'Пробный режим' : nfqwsStatus.installed ? 'Остановлен' : 'Не установлен'}</Badge>}
                {nfqwsStatus?.installed && <Badge variant="outline" className={nfqwsStatus.running && ['tcp', 'tcp-quic'].includes(nfqwsStatus.verifiedTransport) ? 'rounded-sm border-green-500/30 bg-green-500/10 px-2 text-xs text-green-400' : 'rounded-sm border-amber-500/30 bg-amber-500/10 px-2 text-xs text-amber-400'}>{nfqwsStatus.verifiedTransport === 'tcp-quic' ? 'TCP + QUIC · проверено' : nfqwsStatus.verifiedTransport === 'tcp' ? 'TCP · проверено' : `${nfqwsStatus.strategyMode === 'tcp' ? 'TCP' : 'TCP + QUIC'} · не проверено`}</Badge>}
              </div>
            </div>
            <div className="ml-auto flex flex-wrap gap-2">
              {nfqwsStatus?.installed && <Button size="sm" variant="outline" onClick={() => setEditingNfqws(true)}>Настроить</Button>}
              {nfqwsStatus?.installed && !nfqwsStatus.globalReady && <Button size="sm" variant="outline" disabled={controlPending} onClick={() => void attachNfqwsToXray()}>Подключить к Xray</Button>}
              {nfqwsStatus?.installed && <Button size="sm" variant="outline" disabled={controlPending} onClick={() => void controlNfqws(nfqwsStatus.running ? 'stop' : 'start')}>{nfqwsStatus.running ? 'Остановить' : 'Запустить'}</Button>}
              <Button size="sm" variant="outline" disabled={controlPending} onClick={() => void refreshNfqwsStatus()}>Обновить статус</Button>
              {nfqwsStatus && <Button size="sm" variant="outline" disabled={controlPending} onClick={() => void manageAddon('nfqws2', nfqwsStatus.installed ? 'remove' : 'install')}>{nfqwsStatus.installed ? 'Удалить' : 'Установить'}</Button>}
            </div>
          </div>
          {nfqwsError && <p role="alert" className="text-sm text-red-500">{nfqwsError}</p>}
        </div>}
      </DialogContent>
    </Dialog>
    <AlertDialog open={Boolean(addonConfirmation)} onOpenChange={open => { if (!open && !controlPending) setAddonConfirmation(null) }}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{addonConfirmation?.action === 'remove' ? 'Удалить' : 'Установить'} {addonConfirmation?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {addonConfirmation?.action === 'remove'
              ? 'Клиент будет удалён, настройки сохранятся. Перед удалением проверим пакет для повторной установки. Для восстановления потребуется доступ к GitHub. Сначала переключите маршруты, использующие этот компонент.'
              : 'Скачаем клиент из GitHub и используем сохранённые настройки.'}
            {' При изменении конфигурации Xray VPN-соединения кратковременно прервутся.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" disabled={controlPending} onClick={() => setAddonConfirmation(null)}>Отмена</Button>
          <Button variant={addonConfirmation?.action === 'remove' ? 'destructive' : 'default'} disabled={controlPending} onClick={() => void submitAddon()}>{controlPending ? 'Выполняется…' : addonConfirmation?.action === 'remove' ? 'Удалить' : 'Установить'}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  )
}

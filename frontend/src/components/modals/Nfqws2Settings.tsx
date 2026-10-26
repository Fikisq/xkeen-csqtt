import { SettingInfo } from '@/components/ui/setting-info'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { IconListCheck, IconLoader2 } from '@tabler/icons-react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { NfqwsStrategyLists } from './NfqwsStrategyLists'
import { NfqwsResources, type ResourceConfiguration } from './NfqwsResources'
import { NfqwsSessionCheck } from './NfqwsSessionCheck'
import { apiCall } from '@/lib/api'
import { useAppContext } from '@/lib/store'

interface Settings {
  strategyName: string
  requiredTcpSites: number
  resources: ResourceConfiguration
  mode: 'tcp' | 'tcp-quic'
  source: 'preset' | 'custom'
  customArgs: string
  globalReady: boolean
  tcpLua: string[]
  quicLua: string | null
  scope: string
  lastCheck?: CheckResult | null
  library?: SavedStrategy[]
}

interface SavedStrategy { description?: string; siteCount?: number; results?: ProbeResult[]; id: string; name?: string; games?: boolean; mode: 'tcp' | 'tcp-quic'; args: string; checkedAt: string; tcpSites: number; http3Sites: number }
interface SearchStatus { stopping?: boolean; automatic?: boolean; success?: boolean; best?: {tcpSites: number; http3Sites: number}; historyLimit?: number; id?: string; startedAt?: string; finishedAt?: string; mode?: 'tcp' | 'tcp-quic'; games?: boolean; current?: { name: string; mode: string; args: string }; candidates?: CheckResult['candidates']; running: boolean; phase?: string; completed?: number; total?: number; result?: CheckResult; error?: string; library?: SavedStrategy[]; gamesArgs?: string; listStrategyCount?: number }

interface CheckResult {
  success: boolean
  confirmationChanged?: boolean
  initialHttp3Sites?: number
  error?: string
  checkedAt?: string
  stale?: boolean
  mode?: 'tcp' | 'tcp-quic'
  selectedVariant?: number
  selectedQuicVariant?: number | null
  tcpWorking?: boolean
  quicWorking?: boolean
  tcpSites?: number
  http3Sites?: number
  siteCount?: number
  args?: string
  durationSeconds?: number
  verifiedTransport?: 'tcp' | 'tcp-quic' | 'none'
  candidates?: Array<{ name?: string; args?: string; siteCount?: number; results?: ProbeResult[]; variant?: number; quicVariant?: number; phase?: 'tcp' | 'quic'; mode: 'tcp' | 'tcp-quic'; tcpSites?: number; http3Sites?: number; error?: string }>
  results?: Array<{ protocol: 'tcp' | 'h3'; url: string; ok: boolean; status?: number; error?: string; errorStage?: string; remoteIp?: string }>
}

type ProbeResult = NonNullable<CheckResult['results']>[number]

function siteName(url: string) {
  try {
    const host = new URL(url).hostname
    if (host === 'youtube.com' || host.endsWith('.youtube.com')) return 'YouTube'
    if (host === 'discord.com' || host.endsWith('.discord.com')) return 'Discord'
    if (host === 'instagram.com' || host.endsWith('.instagram.com')) return 'Instagram'
    return host
  } catch { return url }
}

function errorStageLabel(item: ProbeResult) {
  const labels: Record<string, string> = { dns: 'DNS', 'tcp-connect': 'TCP-соединение', 'tls-handshake': 'TLS', 'quic-handshake': 'QUIC', 'http-response': 'HTTP-ответ', 'http-body': 'HTTP-данные' }
  return item.errorStage ? labels[item.errorStage] || item.errorStage : ''
}

function probeStatus(item?: ProbeResult) {
  if (!item) return <span className="text-muted-foreground">—</span>
  const failure = item.status ? `HTTP ${item.status}` : /timeout|timed out|deadline/i.test(item.error || '') ? 'Тайм-аут' : item.errorStage === 'quic-handshake' ? 'Нет ответа' : errorStageLabel(item) || 'Нет ответа'
  return <span className={item.ok ? 'text-green-400' : 'text-red-400'} title={[item.error, item.remoteIp].filter(Boolean).join(' · ') || undefined}>
    {item.ok ? `✓ ${item.status ? `HTTP ${item.status}` : 'Ответ есть'}` : `✕ ${failure}`}
  </span>
}

function failedTcpSites(results?: ProbeResult[]) {
  const failed = results?.filter(item => item.protocol === 'tcp' && !item.ok) || []
  if (!failed.length) return null
  return <p className="mt-2 text-xs text-yellow-400">Нет ответа по TCP: {failed.map(item => {
    const site = siteName(item.url)
    return errorStageLabel(item) ? `${site} (${errorStageLabel(item)}${item.remoteIp ? ` · ${item.remoteIp}` : ''})` : site
  }).join(', ')}</p>
}

function renderCount(label: string, passed?: number, checked = true, total = 3) {
  const color = !checked || passed === undefined ? 'text-muted-foreground' : passed === total ? 'text-green-400' : passed > 0 ? 'text-yellow-400' : 'text-red-400'
  return <span className={`whitespace-nowrap font-medium tabular-nums ${color}`}>{label} {checked && passed !== undefined ? `${passed}/${total}` : '—'}</span>
}

function ResourceTable({ displayReport, title, busy = false, urls, names }: { names?: Record<string,string>; urls?: string[]; displayReport?: CheckResult | null; title: string; busy?: boolean }) {
  const staleReport = displayReport?.stale || (!!displayReport?.checkedAt && Date.now() - Date.parse(displayReport.checkedAt) >= 20 * 60 * 1000)
  const siteRows = (urls || ['https://www.youtube.com/generate_204', 'https://discord.com/', 'https://www.instagram.com/']).map(url => ({
    url, name: names?.[url] || siteName(url),
    tcp: displayReport?.results?.find(item => item.url === url && item.protocol === 'tcp'),
    quic: displayReport?.results?.find(item => item.url === url && item.protocol === 'h3'),
  }))
  return <div className="rounded-lg border border-border/70 bg-card p-3 text-sm">
        <p className="font-medium">{title} {displayReport?.checkedAt ? `· ${new Date(displayReport.checkedAt).toLocaleString('ru-RU')}` : ''}</p>
        {!displayReport?.results && <p className="text-muted-foreground mt-1 text-xs">Сайты ещё не проверены. Нажмите «Проверить стратегию».</p>}
        {staleReport && <p className="mt-1 text-xs text-yellow-400">Результат устарел — повторите проверку.</p>}
        {busy && <p role="status" className="text-muted-foreground mt-1 text-xs">Проверка идёт; ниже остаётся предыдущий результат.</p>}
        <div className="mt-2 overflow-x-auto rounded-md border">
          <table className="w-full min-w-[320px] table-fixed text-left text-sm">
            <thead className="bg-card text-foreground"><tr><th className="w-[36%] px-2.5 py-1.5 font-medium">Ресурс<SettingInfo label="Проверка сайтов">Ответы выбранных ресурсов по TCP и HTTP/3. Тайм-аут не указывает точную причину сбоя; HTTP-код показывается только при ответе сервера.</SettingInfo></th><th className="w-[32%] px-2.5 py-1.5 font-medium">TCP<SettingInfo label="TCP">Успех — ответы всех выбранных ресурсов. Это проверка веб-доступности, не голосовых или игровых соединений.</SettingInfo></th><th className="w-[32%] px-2.5 py-1.5 font-medium">QUIC<SettingInfo label="QUIC">Проверяется HTTP/3 по UDP. Для стратегии TCP + QUIC нужен хотя бы один успешный ответ.</SettingInfo></th></tr></thead>
            <tbody>{siteRows.map(row => <tr key={row.url} className="border-t align-top">
              <th scope="row" className="px-2.5 py-1.5 font-medium">{row.name}</th>
              <td className="break-words px-2.5 py-1.5">{probeStatus(row.tcp)}</td>
              <td className="break-words px-2.5 py-1.5">{probeStatus(row.quic)}</td>
            </tr>)}</tbody>
          </table>
        </div>
        {displayReport?.confirmationChanged && <p className="mt-3 text-xs text-yellow-400">Результат изменился при подтверждении: QUIC {displayReport.initialHttp3Sites}/{siteRows.length} → {displayReport.http3Sites}/{siteRows.length}. Показана последняя проверка.</p>}

      </div>
}

export function Nfqws2Settings({ onBack, onRefresh }: { onBack: () => void; onRefresh: () => void }) {
  const { showToast } = useAppContext()
  const [mode, setMode] = useState<'tcp' | 'tcp-quic'>('tcp-quic')
  const [source, setSource] = useState<'preset' | 'custom'>('preset')
  const [customArgs, setCustomArgs] = useState('')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [checking, setChecking] = useState(false)
  const [report, setReport] = useState<CheckResult | null>(null)
  const [error, setError] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchMode, setSearchMode] = useState<'tcp' | 'tcp-quic'>('tcp-quic')
  const [searchJob, setSearchJob] = useState<SearchStatus | null>(null)
  const [games, setGames] = useState(false)
  const [parametersOpen, setParametersOpen] = useState(false)
  const [section, setSection] = useState<'main' | 'lists' | 'resources'>('main')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerTab, setPickerTab] = useState<'working' | 'attempts'>('working')
  const appliedJob = useRef('')
  const activeCheckedAt = useRef(0)
  const pollEpoch = useRef(0)
  const pollNow = useRef<() => void>(() => {})

  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout> | undefined
    async function poll() {
      const epoch = ++pollEpoch.current
      try {
        const job = await apiCall<SearchStatus>('GET', 'nfqws2/search')
        if (!active || epoch !== pollEpoch.current) return
        setSearchJob(job)
        setSearching(job.running)
        const key = job.id || job.result?.checkedAt || ''
        if (job.running) {
          if (job.mode) setSearchMode(job.mode)
          setGames(!!job.games)
        } else if (key && appliedJob.current !== key) {
          appliedJob.current = key
          if (job.automatic) {
            const current = await apiCall<Settings>('GET','nfqws2/settings')
            if (active && epoch === pollEpoch.current) { setSettings(current); setReport(null); onRefresh() }
          }
          if (job.success !== false && job.result && (job.result.tcpSites || 0) >= (job.result.siteCount || 3) && Date.parse(job.result.checkedAt || '') >= activeCheckedAt.current) {
            setReport(job.result)
            setCustomArgs(job.result.args || '')
            setGames(!!job.result.args?.includes('--filter-udp=1024-65535'))
            setSource('preset')
            setMode(job.result.mode || 'tcp')
          }
        }
        timer = setTimeout(() => void poll(), job.running ? 1500 : 5000)
      } catch {
        if (active && epoch === pollEpoch.current) timer = setTimeout(() => void poll(), 3000)
      }
    }
    pollNow.current = () => { if (timer) clearTimeout(timer); void poll() }
    async function load() {
      try {
        const value = await apiCall<Settings>('GET', 'nfqws2/settings')
        if (!active) return
        setSettings(value); setMode(value.mode); setSource(value.source)
        setCustomArgs(value.customArgs)
        setGames(value.customArgs.includes('--filter-udp=1024-65535'))
        activeCheckedAt.current = Date.parse(value.lastCheck?.checkedAt || '') || 0
        setReport(value.lastCheck ?? null)
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить настройки')
      } finally {
        if (active) { setLoading(false); void poll() }
      }
    }
    void load()
    return () => { active = false; if (timer) clearTimeout(timer); pollNow.current = () => {} }
  }, [])

  async function startSearch() {
    ++pollEpoch.current
    setError(''); setSearching(true)
    try {
      const result = await apiCall<{success: boolean; error?: string}>('POST', 'nfqws2/search', {mode: searchMode, games, plan: 'lists'})
      if (!result.success) throw new Error(result.error || 'Не удалось начать подбор')
      pollNow.current()
    } catch (cause) {
      setSearching(false)
      setError(cause instanceof Error ? cause.message : 'Ошибка подбора')
    }
  }

  async function cancelSearch() {
    try { await apiCall('POST', 'nfqws2/search/cancel'); pollNow.current() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось отменить подбор') }
  }

  function withGames(args: string) {
    const extra = searchJob?.gamesArgs || ''
    const base = args.trim() ? args : `--filter-tcp=443\n--payload=tls_client_hello\n${settings?.tcpLua.join('\n') || ''}\n${mode === 'tcp-quic' ? `--new\n--filter-udp=443\n--payload=quic_initial\n${settings?.quicLua || ''}\n` : ''}`
    const clean = extra && base.endsWith(extra) ? base.slice(0, -extra.length) : base
    return games && extra ? `${clean.trimEnd()}\n${extra}` : clean
  }

  async function save() {
    setSaving(true)
    setError('')
    try {
      const result = await apiCall<{ success: boolean; settings?: Settings; check?: CheckResult; error?: string }>('POST', 'nfqws2/settings', { source, customArgs: withGames(customArgs), allowTcpOnly: searchMode === 'tcp' })
      if (!result.success) throw new Error(result.error || 'Не удалось сохранить nfqws2')
      if (result.settings) {
        setSettings(result.settings)
        setMode(result.settings.mode)
        setCustomArgs(result.settings.customArgs)
      }
      activeCheckedAt.current = Date.parse(result.check?.checkedAt || '') || Date.now()
      setReport(result.check ?? null)
      onRefresh()
      showToast(`Стратегия сохранена: TCP ${result.check?.tcpSites ?? '—'}/${result.check?.siteCount || settings?.requiredTcpSites || 3}, HTTP/3 ${result.check?.http3Sites ?? '—'}/${result.check?.siteCount || settings?.requiredTcpSites || 3}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Ошибка nfqws2')
    } finally {
      setSaving(false)
    }
  }

  async function check(draftSource = source, draftArgs = customArgs) {
    setChecking(true)
    setError('')
    try {
      const result = await apiCall<CheckResult>('POST', 'nfqws2/check', { source: draftSource, customArgs: withGames(draftArgs) })
      if (!result.success) throw new Error(result.error || 'Проверка не завершилась')
      activeCheckedAt.current = Date.parse(result.checkedAt || '') || Date.now()
      setReport(result)
      const active = await apiCall<Settings>('GET', 'nfqws2/settings')
      setSettings(active)
      onRefresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Ошибка проверки')
    } finally {
      setChecking(false)
    }
  }

  const canonicalArgs = (args = '') => args.split('\n').map(line => line.trim()).filter(Boolean).join('\n')
  const draftArgs = withGames(customArgs)
  const draftMatchesActive = !!settings && canonicalArgs(draftArgs) === canonicalArgs(settings.customArgs)
  const selectedUrls = settings?.resources.sites.filter(site => settings.resources.config.selected.includes(site.id)).map(site => site.url) || []
  const measured = draftMatchesActive ? settings?.lastCheck : report && canonicalArgs(report.args) === canonicalArgs(draftArgs) ? report : null
  // Counts and rows must describe the same measurement and resource selection.
  const displayReport = measured ? {...measured,
    tcpSites: measured.results?.filter(row => selectedUrls.includes(row.url) && row.protocol === 'tcp' && row.ok).length,
    http3Sites: measured.results?.filter(row => selectedUrls.includes(row.url) && row.protocol === 'h3' && row.ok).length,
  } : null
  const total = settings?.requiredTcpSites || 3
  const checkCount = (label: string, passed?: number, checked = true) => renderCount(label, passed, checked, total)

  const history = searchJob?.candidates || displayReport?.candidates || []
  const library = (searchJob?.library || settings?.library || []).filter(item => item.tcpSites >= total && (item.mode === 'tcp' || item.http3Sites >= 1))

  const selectedName = draftMatchesActive ? settings?.strategyName : library.find(item => canonicalArgs(item.args) === canonicalArgs(draftArgs))?.name || 'Ручные параметры'
  const searchMeasurement = !searching && searchJob?.result ? searchJob.result : searchJob?.best

  function selectStrategy(args: string, selectedMode: 'tcp' | 'tcp-quic', result?: CheckResult) {
    setSource('custom'); setCustomArgs(args); setMode(selectedMode)
    setGames(args.includes('--filter-udp=1024-65535')); setReport(result || null)
    setError(''); setPickerOpen(false)
  }

  return <div className="flex min-h-0 flex-col gap-2">
    <div role="tablist" aria-label="Разделы nfqws2" className="flex w-fit max-w-full shrink-0 flex-wrap justify-start gap-1 rounded-lg border border-border/70 bg-input-background p-1">
      <Button id="nfqws-main-tab" role="tab" aria-selected={section === 'main'} aria-controls="nfqws-main-panel" variant={section === 'main' ? 'default' : 'ghost'} size="sm" onClick={() => setSection('main')}>Главная</Button>
      <Button id="nfqws-resources-tab" role="tab" aria-selected={section === 'resources'} aria-controls="nfqws-resources-panel" variant={section === 'resources' ? 'default' : 'ghost'} size="sm" onClick={() => setSection('resources')}>Ресурсы</Button>
      <Button id="nfqws-lists-tab" role="tab" aria-selected={section === 'lists'} aria-controls="nfqws-lists-panel" variant={section === 'lists' ? 'default' : 'ghost'} size="sm" onClick={() => setSection('lists')}>Списки стратегий</Button>
    </div>
    <div className="min-h-0 min-w-0 space-y-2 overflow-y-auto pr-1">
    <div id="nfqws-main-panel" role="tabpanel" aria-labelledby="nfqws-main-tab" hidden={section !== 'main'} className="space-y-2">
    {loading ? <p className="text-muted-foreground text-sm">Загрузка настроек…</p> : <>
      <div className="grid items-end gap-2 sm:grid-cols-3">
        <label className="text-sm font-medium">Стратегия<SettingInfo label="Стратегия">Автоподбор использует списки; «Своя» — ручные параметры. Активная стратегия меняется только после сохранения и применения.</SettingInfo>
          <select className="bg-input-background border-border mt-1 h-9 w-full rounded-md border px-2 text-sm" value={source} onChange={(event) => { setSource(event.target.value as 'preset' | 'custom'); setReport(null) }}>
            <option value="preset">Автоподбор</option>
            <option value="custom">Своя</option>
          </select>
        </label>
        <div className="rounded-lg border border-border/70 bg-card px-2.5 py-2 text-sm">
          <div className="font-medium">{draftMatchesActive ? 'Активная' : 'Не применена'}: {source === 'custom' ? customArgs.split('\n').some((line) => line.trim() === '--filter-udp=443') ? 'TCP + QUIC' : 'TCP' : mode === 'tcp' ? 'TCP' : 'TCP + QUIC'}</div>
          <div className="mt-1 flex gap-3 text-xs">{checkCount('TCP', displayReport?.tcpSites)}{checkCount('QUIC', displayReport?.http3Sites, displayReport?.mode === 'tcp-quic')}</div>
        </div>
        <div className="flex items-center justify-between gap-2 rounded-lg border border-border/70 bg-card px-2.5 py-2">
          <label htmlFor="nfqws-games" className="cursor-pointer text-sm font-medium" title="Добавляет фиксированные TCP/UDP-правила после «Сохранить и применить». Проверьте вход в Roblox и подключение к голосовому каналу Discord: TCP всех выбранных сайтов не подтверждает их работу.">Roblox и голос Discord<SettingInfo label="Roblox и голос Discord">Добавляет TCP/UDP-правила после сохранения и применения. Успех сайта не подтверждает игру или голос: для этого нужен реальный сеанс на устройстве.</SettingInfo></label>
          <Switch id="nfqws-games" size="lg" checked={games} disabled={searching || checking || saving || !searchJob?.gamesArgs} onCheckedChange={checked => { setGames(checked); setReport(null) }} />
        </div>
      </div>
      <p className="px-1 text-sm"><span className="text-muted-foreground">{draftMatchesActive ? 'Активная стратегия: ' : 'Выбрана, не применена: '}</span>{selectedName}</p>
      {!settings?.globalReady && <p className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">Выход nfqws2 ещё не доступен в Xray.</p>}
      <div className="rounded-lg border border-border/70 bg-card px-3 py-2.5">
        <div className="flex items-center gap-1">
          <button type="button" className="flex flex-1 cursor-pointer items-center gap-2 text-left text-sm font-medium" aria-expanded={parametersOpen} aria-controls="nfqws-strategy-parameters" onClick={() => setParametersOpen(value => !value)}><span aria-hidden="true">{parametersOpen ? '▾' : '▸'}</span>Параметры стратегии</button>
          <SettingInfo label="Параметры стратегии">Показан черновик. Ручные параметры можно редактировать в режиме «Своя». Применение — после сохранения.</SettingInfo>
        </div>
        {parametersOpen && <div id="nfqws-strategy-parameters">
          {source === 'custom' ? <label className="mt-2 block text-sm">Один параметр nfqws2 в строке
<Textarea className="mt-1 min-h-44 font-mono text-xs" value={customArgs} onChange={(event) => { setCustomArgs(event.target.value); setReport(null) }} onPaste={(event) => {
          event.preventDefault()
          const field = event.currentTarget
          const next = customArgs.slice(0, field.selectionStart) + event.clipboardData.getData('text') + customArgs.slice(field.selectionEnd)
          setCustomArgs(next)
          setReport(null)
          void check('custom', next)
        }} spellCheck={false} placeholder={'--filter-tcp=443\n--payload=tls_client_hello\n--lua-desync=...'} />
          </label> : <>
            <div className="text-muted-foreground mt-2 text-xs">TCP</div>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all text-xs">{withGames(customArgs).split('--new')[0]}</pre>
            {mode === 'tcp-quic' && <><div className="text-muted-foreground mt-2 text-xs">QUIC</div><pre className="overflow-x-auto whitespace-pre-wrap break-all text-xs">{withGames(customArgs).split('--new').find(block => block.includes('--filter-udp=443'))?.trim() || settings?.quicLua}</pre></>}
          </>}
        </div>}
      </div>
      <div className="space-y-2 rounded-lg border border-border/70 bg-card p-3">
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Транспорт для подбора" className="bg-input-background border-border h-8 rounded-md border px-2 text-sm" value={searchMode} disabled={searching || checking || saving} onChange={event => { setSearchMode(event.target.value as 'tcp' | 'tcp-quic') }}><option value="tcp-quic">TCP + QUIC</option><option value="tcp">Только TCP</option></select>
          <Button size="sm" disabled={saving || checking || searching} onClick={() => void startSearch()}>{searching && <IconLoader2 className="size-4 animate-spin" />}{searching ? 'Подбор идёт…' : 'Подобрать стратегии'}</Button>
          <Button size="sm" variant="outline" disabled={loading} onClick={() => setPickerOpen(true)}><IconListCheck className="size-4" />Выбрать стратегию{library.length ? ` (${library.length})` : ''}</Button>
          <NfqwsSessionCheck /><SettingInfo label="Подбор и проверка">Подбор выполняется в фоне по включённым спискам; обновление страницы его не останавливает. Быстрый проход — до 3 секунд, подтверждение — до 6. Успех: TCP всех выбранных сайтов, для TCP + QUIC также нужен ответ HTTP/3. Выбор результата заполняет черновик.</SettingInfo>
          {searching && <Button variant="outline" disabled={searchJob?.stopping} onClick={() => void cancelSearch()}>{searchJob?.stopping ? 'Остановка…' : 'Остановить'}</Button>}
        </div>
        {searching && <div role="status" className="rounded-lg border border-primary/30 bg-primary/10 p-3 text-sm"><p className="font-medium">{searchJob?.phase || 'Подготовка'}</p><p className="text-muted-foreground mt-1 text-xs">Завершено проверок: {searchJob?.completed || 0}{searchJob?.total ? ` · до ${searchJob.total} вариантов` : ''}. Можно закрыть окно или обновить страницу.</p></div>}
        {searchMeasurement && <p className="flex gap-3 text-xs">{searching ? 'Лучший результат текущего подбора' : searchJob?.result ? 'Итог подбора' : 'Лучший замер последнего подбора'}{searchJob?.finishedAt || searchJob?.startedAt ? ` · ${new Date(searchJob?.finishedAt || searchJob?.startedAt!).toLocaleString('ru-RU')}` : ''}: {checkCount('TCP', searchMeasurement.tcpSites)}{checkCount('QUIC', searchMeasurement.http3Sites)}<SettingInfo label="Результат подбора">Во время подбора показан лучший замер, после завершения — подтверждённый итог. Счётчики сверху и таблица ресурсов относятся к выбранному варианту. В «Ядрах» показана активная стратегия; выбор применяется после сохранения.</SettingInfo></p>}


      </div>
      <ResourceTable displayReport={displayReport} title={draftMatchesActive ? "Ресурсы активной стратегии" : "Ресурсы выбранной стратегии · не применена"} busy={checking} names={Object.fromEntries((settings?.resources.sites || []).map(site => [site.url,site.name]))} urls={settings?.resources.sites.filter(site => settings.resources.config.selected.includes(site.id)).map(site => site.url)} />

      {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
      <div className="bg-card sticky bottom-0 flex flex-wrap justify-end gap-2 border-t py-2"><Button variant="outline" onClick={onBack}>Назад</Button><Button variant="outline" disabled={saving || checking || searching || (source === 'custom' && !customArgs.trim())} onClick={() => void check()}>{checking ? 'Проверка…' : 'Проверить стратегию'}</Button><Button disabled={saving || checking || searching || (source === 'custom' && !customArgs.trim())} onClick={() => void save()}>{saving ? 'Сохраняется…' : 'Сохранить и применить'}</Button></div>
    </>}
    </div>
    <div id="nfqws-resources-panel" role="tabpanel" aria-labelledby="nfqws-resources-tab" hidden={section !== 'resources'}>
      <NfqwsResources active={section === 'resources'} disabled={searching || checking || saving} report={displayReport} onCheck={() => void check()} onSaved={() => {
        setReport(null)
        void apiCall<Settings>('GET','nfqws2/settings').then(setSettings).catch(cause => setError(String(cause)))
        pollNow.current()
        onRefresh()
        showToast('Ресурсы и расписание сохранены')
      }} />
    </div>
    <div id="nfqws-lists-panel" role="tabpanel" aria-labelledby="nfqws-lists-tab" hidden={section !== 'lists'}>
      <NfqwsStrategyLists active={section === 'lists'} readOnly={searching || checking || saving} />
    </div>
    </div>
    <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
      <DialogContent className="flex! max-h-[90dvh] max-w-[min(96vw,920px)]! flex-col gap-4 overflow-hidden">
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle className="flex items-center gap-2"><IconListCheck className="text-chart-2 size-6" />Выбрать стратегию</DialogTitle>
          <DialogDescription>Успешная стратегия: TCP {total}/{total}. Для TCP + QUIC также нужен ответ по QUIC. Выбор заполняет черновик; применение — после сохранения.</DialogDescription>
        </DialogHeader>
        {searching && <div role="status" className="shrink-0 rounded-xl border border-primary/30 bg-primary/10 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><p className="flex items-center gap-2 font-medium"><IconLoader2 className="size-4 animate-spin" />{searchJob?.phase || 'Подготовка'}</p><Button size="sm" variant="outline" disabled={searchJob?.stopping} onClick={() => void cancelSearch()}>{searchJob?.stopping ? 'Остановка…' : 'Остановить подбор'}</Button></div>
          <p className="text-muted-foreground mt-1 text-xs">Завершено проверок: {searchJob?.completed || 0}{searchJob?.total ? ` из ${searchJob.total}` : ''}. Закрытие окна не останавливает подбор.</p>
          {searchJob?.current && <details className="mt-2 text-xs"><summary className="cursor-pointer">Сейчас: {searchJob.current.name}</summary><pre className="text-muted-foreground mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono">{searchJob.current.args}</pre></details>}
        </div>}
        <div className="flex shrink-0 flex-wrap gap-2 border-b pb-3" aria-label="Разделы результатов">
          <Button size="sm" variant={pickerTab === 'working' ? 'default' : 'outline'} aria-pressed={pickerTab === 'working'} onClick={() => setPickerTab('working')}>Успешные ({library.length})</Button>
          <Button size="sm" variant={pickerTab === 'attempts' ? 'default' : 'outline'} aria-pressed={pickerTab === 'attempts'} onClick={() => setPickerTab('attempts')}>Все проверки ({searchJob?.completed || history.length})</Button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          {pickerTab === 'working' && <>
            {!library.length && <p className="text-muted-foreground rounded-xl border border-dashed p-6 text-center">Стратегий с TCP {total}/{total} пока нет. Неполные результаты доступны в разделе «Все проверки». Запустите подбор или проверьте свой вариант.</p>}
            {library.map(item => <div key={item.id} className={`rounded-xl border p-4 ${item.args === customArgs ? 'border-primary/40 bg-primary/10' : 'border-border/70 bg-card'}`}>
              <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1"><p className="break-words font-medium">{item.name || 'Своя стратегия'}{item.games ? ' · Roblox и голос Discord' : ''}</p>{item.description && <p className="mt-1 text-sm text-muted-foreground">{item.description}</p>}<div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">{checkCount('TCP', item.tcpSites)}{checkCount('QUIC', item.http3Sites, item.mode === 'tcp-quic')}<span className="text-muted-foreground">{new Date(item.checkedAt).toLocaleString('ru-RU')}</span></div></div>
                <Button size="sm" disabled={searching || checking || saving} onClick={() => selectStrategy(item.args, item.mode, {success: true, mode: item.mode, args: item.args, checkedAt: item.checkedAt, tcpSites: item.tcpSites, http3Sites: item.http3Sites, results: item.results})}>Выбрать</Button>
              </div>
              <details className="text-muted-foreground mt-3 text-xs"><summary className="cursor-pointer">Результаты и параметры</summary>{item.results?.map(row => <div key={`${row.url}:${row.protocol}`} className="mt-2 flex flex-wrap justify-between gap-1"><span>{siteName(row.url)} · {row.protocol === 'h3' ? 'QUIC' : 'TCP'}</span>{probeStatus(row)}</div>)}<pre className="mt-3 whitespace-pre-wrap break-all font-mono">{item.args}</pre></details>
            </div>)}
          </>}
          {pickerTab === 'attempts' && <>
            {!!searchJob?.historyLimit && (searchJob.completed || 0) > searchJob.historyLimit && <p className="text-muted-foreground text-xs">Показаны последние {searchJob.historyLimit} проверок из {searchJob.completed}.</p>}
            {!history.length && <p className="text-muted-foreground rounded-xl border border-dashed p-6 text-center">После запуска подбора здесь появятся результаты каждой попытки.</p>}
            {history.map((item, index) => <div key={index} className="rounded-xl border border-border/70 bg-card p-3">
              <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1"><p className="break-words font-medium"><span className="text-muted-foreground mr-2 tabular-nums">{Math.max(0, (searchJob?.completed || history.length) - history.length) + index + 1}.</span>{item.name || 'Стратегия'}</p><div className="mt-2 flex flex-wrap gap-3 text-xs">{item.error ? <span className="text-destructive break-words">{item.error}</span> : <>{checkCount('TCP', item.tcpSites)}{checkCount('QUIC', item.http3Sites, item.mode === 'tcp-quic')}</>}</div>{failedTcpSites(item.results)}</div>
                {item.args && !item.error && (item.tcpSites || 0) >= total && (item.mode === 'tcp' || (item.http3Sites || 0) >= 1) && <Button size="sm" disabled={searching || checking || saving} onClick={() => selectStrategy(item.args!, item.mode)}>Выбрать</Button>}
              </div>
              <details className="text-muted-foreground mt-3 text-xs"><summary className="cursor-pointer">Результаты и параметры</summary>{item.results?.map(row => <div key={`${row.url}:${row.protocol}`} className="mt-2 flex flex-wrap justify-between gap-1"><span>{siteName(row.url)} · {row.protocol === 'h3' ? 'QUIC' : 'TCP'}</span>{probeStatus(row)}</div>)}{item.args && <pre className="mt-3 whitespace-pre-wrap break-all font-mono">{item.args}</pre>}</details>
            </div>)}
          </>}
          {searchJob?.error && <p role="alert" className="text-destructive text-sm">{searchJob.error}</p>}
        </div>
        <DialogFooter className="shrink-0 border-t pt-3"><Button variant="outline" onClick={() => setPickerOpen(false)}>Закрыть</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
}

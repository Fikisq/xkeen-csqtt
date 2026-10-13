import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { apiCall } from '@/lib/api'
import { useAppContext } from '@/lib/store'

interface Settings {
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

interface SavedStrategy { id: string; name?: string; games?: boolean; mode: 'tcp' | 'tcp-quic'; args: string; checkedAt: string; tcpSites: number; http3Sites: number }
interface SearchStatus { running: boolean; phase?: string; completed?: number; total?: number; result?: CheckResult; error?: string; library?: SavedStrategy[]; gamesArgs?: string; flowsealCount?: number }

interface CheckResult {
  success: boolean
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
  candidates?: Array<{ name?: string; variant: number; quicVariant?: number; phase?: 'tcp' | 'quic'; mode: 'tcp' | 'tcp-quic'; tcpSites?: number; http3Sites?: number; error?: string }>
  results?: Array<{ protocol: 'tcp' | 'h3'; url: string; ok: boolean; status?: number; error?: string }>
}

type ProbeResult = NonNullable<CheckResult['results']>[number]

function probeStatus(item?: ProbeResult) {
  if (!item) return <span className="text-muted-foreground">—</span>
  return <span className={item.ok ? 'text-green-400' : 'text-amber-400'} title={item.error || undefined}>
    {item.ok ? `✓ ${item.status ? `HTTP ${item.status}` : 'Ответ есть'}` : '○ Нет ответа'}
  </span>
}

function checkCount(label: string, passed?: number, checked = true) {
  const color = !checked || passed === undefined ? 'text-muted-foreground' : passed === 3 ? 'text-green-400' : passed > 0 ? 'text-amber-400' : 'text-red-400'
  return <span className={`whitespace-nowrap font-medium tabular-nums ${color}`}>{label} {checked && passed !== undefined ? `${passed}/3` : '—'}</span>
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
  const sawRunning = useRef(false)

  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout> | undefined
    async function poll() {
      try {
        const job = await apiCall<SearchStatus>('GET', 'nfqws2/search')
        if (!active) return
        setSearchJob(job)
        if (job.running) { sawRunning.current = true; setSearching(true); timer = setTimeout(() => void poll(), 2000) }
        else {
          setSearching(false)
          if (sawRunning.current) {
            sawRunning.current = false
            if (job.result) { setReport(job.result); setCustomArgs(job.result.args || ''); setGames(!!job.result.args?.includes('--filter-udp=1024-65535')); setSource('preset'); setMode(job.result.mode || 'tcp') }
            else if (job.error) setError(job.error)
          }
        }
      } catch { if (active && searching) timer = setTimeout(() => void poll(), 3000) }
    }
    void poll()
    return () => { active = false; if (timer) clearTimeout(timer) }
  }, [searching])

  async function startSearch() {
    setError('')
    try {
      const result = await apiCall<{success: boolean; error?: string}>('POST', 'nfqws2/search', {mode: searchMode, games})
      if (!result.success) throw new Error(result.error || 'Не удалось начать подбор')
      sawRunning.current = true; setSearching(true)
    } catch (error) { setError(error instanceof Error ? error.message : 'Ошибка подбора') }
  }

  useEffect(() => {
    let active = true
    void apiCall<Settings>('GET', 'nfqws2/settings').then((value) => {
      if (!active) return
      setSettings(value)
      setMode(value.mode)
      setSource(value.source)
      setCustomArgs(value.customArgs)
      setGames(value.customArgs.includes('--filter-udp=1024-65535'))
      setReport(value.lastCheck ?? null)
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить настройки')
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

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
      setReport(result.check ?? null)
      onRefresh()
      showToast(`Стратегия сохранена: TCP ${result.check?.tcpSites ?? '—'}/3, HTTP/3 ${result.check?.http3Sites ?? '—'}/3`)
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
      setReport(result)
      onRefresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Ошибка проверки')
    } finally {
      setChecking(false)
    }
  }

  const displayReport = report ?? settings?.lastCheck
  const staleReport = displayReport?.stale || (!!displayReport?.checkedAt && Date.now() - Date.parse(displayReport.checkedAt) >= 30 * 60 * 1000)
  const siteRows = ['https://www.youtube.com/generate_204', 'https://discord.com/', 'https://www.instagram.com/'].map(url => ({
    url,
    name: url.includes('youtube') ? 'YouTube' : url.includes('discord') ? 'Discord' : url.includes('instagram') ? 'Instagram' : url,
    tcp: displayReport?.results?.find(item => item.url === url && item.protocol === 'tcp'),
    quic: displayReport?.results?.find(item => item.url === url && item.protocol === 'h3'),
  }))

  return <div className="space-y-4">
    {loading ? <p className="text-muted-foreground text-sm">Загрузка настроек…</p> : <>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-medium">Стратегия
          <select className="bg-input-background border-border mt-1 h-9 w-full rounded-md border px-2 text-sm" value={source} onChange={(event) => { setSource(event.target.value as 'preset' | 'custom'); setReport(null) }}>
            <option value="preset">Автоподбор</option>
            <option value="custom">Своя</option>
          </select>
        </label>
        <div className="rounded-md border p-3 text-sm">
          <div className="font-medium">Настроено: {source === 'custom' ? customArgs.split('\n').some((line) => line.trim() === '--filter-udp=443') ? 'TCP + QUIC' : 'TCP' : mode === 'tcp' ? 'TCP' : 'TCP + QUIC'}</div>
          <div className="mt-1 flex gap-3 text-xs">{checkCount('TCP', displayReport?.tcpSites)}{checkCount('QUIC', displayReport?.http3Sites, displayReport?.mode === 'tcp-quic')}</div>
        </div>
      </div>
      {!settings?.globalReady && <p className="rounded-md border border-amber-500/40 px-3 py-2 text-xs text-amber-500">Выход nfqws2 ещё не доступен в Xray.</p>}
      {source === 'custom' && <label className="block text-sm font-medium">Своя стратегия · один параметр nfqws2 в строке
        <Textarea className="mt-1 min-h-44 font-mono text-xs" value={customArgs} onChange={(event) => { setCustomArgs(event.target.value); setReport(null) }} onPaste={(event) => {
          event.preventDefault()
          const field = event.currentTarget
          const next = customArgs.slice(0, field.selectionStart) + event.clipboardData.getData('text') + customArgs.slice(field.selectionEnd)
          setCustomArgs(next)
          setReport(null)
          void check('custom', next)
        }} spellCheck={false} placeholder={'--filter-tcp=443\n--payload=tls_client_hello\n--lua-desync=...'} />
      </label>}
      {source === 'preset' && <details className="rounded-md border p-3">
        <summary className="cursor-pointer text-sm font-medium">Параметры стратегии</summary>
        <div className="text-muted-foreground mt-2 text-xs">TCP</div>
        <pre className="overflow-x-auto whitespace-pre-wrap break-all text-xs">{withGames(customArgs).split('--new')[0]}</pre>
        {mode === 'tcp-quic' && <><div className="text-muted-foreground mt-2 text-xs">QUIC</div><pre className="overflow-x-auto whitespace-pre-wrap break-all text-xs">{withGames(customArgs).split('--new').find(block => block.includes('--filter-udp=443'))?.trim() || settings?.quicLua}</pre></>}
      </details>}
      <div className="space-y-3 rounded-md border p-3">
        <div className="flex flex-wrap items-center gap-2"><select className="bg-input-background rounded-md border px-2 py-2 text-sm" value={searchMode} disabled={searching} onChange={event => setSearchMode(event.target.value as 'tcp' | 'tcp-quic')}><option value="tcp-quic">TCP + QUIC</option><option value="tcp">Только TCP</option></select><Button variant="outline" disabled={saving || checking || searching} onClick={() => void startSearch()}>Подобрать стратегию</Button>{searching && <Button variant="outline" onClick={() => void apiCall('POST', 'nfqws2/search/cancel')}>Отменить подбор</Button>}</div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={games} disabled={searching || checking || saving || !searchJob?.gamesArgs} onChange={event => { setGames(event.target.checked); setReport(null) }} />Голос Discord и игры (Roblox) · UDP</label>
        {searching && <p role="status" className="text-sm">{searchJob?.phase || 'Подготовка'} · проверено {searchJob?.completed || 0} из {searchJob?.total || '…'}</p>}
        <p className="text-muted-foreground text-xs">Подбор — до 2 минут. Применение — после сохранения.</p>
        <h4 className="text-sm font-medium">Проверенные стратегии</h4>
        <div className="max-h-44 space-y-2 overflow-y-auto">{(searchJob?.library || settings?.library || []).map(item => <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm"><div className="min-w-0 flex-1"><p className="break-words">{item.name || item.args.split('\n').filter(line => line.startsWith('--lua-desync=') && !line.includes('quic_initial')).slice(0, 2).map(line => line.slice(13).split(':')[0]).join(' + ') || 'Своя стратегия'}{item.games ? ' · Голос/игры' : ''}</p><div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">{checkCount('TCP', item.tcpSites)}{checkCount('QUIC', item.http3Sites, item.mode === 'tcp-quic')}<span className="text-muted-foreground">{new Date(item.checkedAt).toLocaleString('ru-RU')}</span></div></div><Button size="sm" variant="outline" disabled={searching || checking || saving} onClick={() => { setSource('custom'); setCustomArgs(item.args); setMode(item.mode); setGames(!!item.games); setReport(null) }}>Выбрать</Button></div>)}{!(searchJob?.library || settings?.library || []).length && <p className="text-muted-foreground text-sm">Пока нет проверенных стратегий.</p>}</div>
      </div>
      <div className="rounded-md border p-3 text-sm">
        <p className="font-medium">Проверка сайтов {displayReport?.checkedAt ? `· ${new Date(displayReport.checkedAt).toLocaleString('ru-RU')}` : ''}</p>
        {!displayReport?.results && <p className="text-muted-foreground mt-1 text-xs">Сайты ещё не проверены. Нажмите «Проверить стратегию».</p>}
        {staleReport && <p className="mt-1 text-xs text-amber-400">Результат устарел — повторите проверку.</p>}
        {!report && displayReport && <p className="text-muted-foreground mt-1 text-xs">Показана прежняя проверка.</p>}
        {(searching || checking) && <p role="status" className="text-muted-foreground mt-1 text-xs">Проверка идёт; ниже остаётся предыдущий результат.</p>}
        <div className="mt-2 overflow-x-auto rounded-md border">
          <table className="w-full min-w-[650px] table-fixed text-left text-sm">
            <thead className="bg-input-background text-foreground"><tr><th className="w-[18%] px-3 py-2 font-medium">Ресурс</th><th className="w-[27%] px-3 py-2 font-medium">TCP</th><th className="w-[27%] px-3 py-2 font-medium">QUIC</th><th className="w-[28%] px-3 py-2 font-medium">TCP + QUIC</th></tr></thead>
            <tbody>{siteRows.map(row => <tr key={row.url} className="border-t align-top">
              <th scope="row" className="px-3 py-2 font-medium">{row.name}</th>
              <td className="break-words px-3 py-2">{probeStatus(row.tcp)}</td>
              <td className="break-words px-3 py-2">{probeStatus(row.quic)}</td>
              <td className="px-3 py-2">{!row.tcp || !row.quic ? <span className="text-muted-foreground">—</span> : row.tcp.ok && row.quic.ok ? <span className="text-green-400">✓ Оба доступны</span> : <span className="text-amber-400">○ Не оба доступны</span>}</td>
            </tr>)}</tbody>
          </table>
        </div>
        {report?.candidates && <details className="mt-3 space-y-1 border-t pt-3">
          <summary className="cursor-pointer text-xs font-medium">Ход подбора · {report.candidates.length} проверок</summary>
          {report.candidates.map((item) => {
            const selected = typeof item.variant === 'number' && item.variant === report.selectedVariant && (item.mode === 'tcp' ? report.mode === 'tcp' : item.quicVariant === report.selectedQuicVariant && report.mode === 'tcp-quic')
            const name = item.name || ['TLS + Multisplit', 'Fake TLS', 'Multisplit', 'Fake TLS + Multidisorder'][item.variant] || 'Вариант'
            return <div key={item.name || `${item.variant}:${item.mode}:${item.quicVariant ?? 0}`} className={`flex flex-wrap justify-between gap-x-3 rounded px-2 py-1 text-xs ${selected ? 'bg-green-500/10 text-green-400' : 'text-muted-foreground'}`}>
              <span>{selected ? '✓ ' : ''}{name} · {item.name ? item.mode.toUpperCase() : item.mode === 'tcp-quic' ? `QUIC ${item.quicVariant === 1 ? '6' : '11'} повторов` : 'TCP'}</span>
              <span className="flex gap-3" title={item.error}>{item.error ? 'Проверка не удалась' : <>{checkCount('TCP', item.tcpSites)}{checkCount('QUIC', item.http3Sites, item.mode === 'tcp-quic')}</>}</span>
            </div>
          })}
        </details>}
      </div>
      <details className="text-muted-foreground text-xs"><summary className="cursor-pointer">О проверке</summary><p className="mt-2">Проверяются ответы сайтов, не звонки и игры. Результат можно применить в течение 5 минут; затем параметры проверяются снова. Подбор включает {searchJob?.flowsealCount ?? 38} адаптаций Flowseal.</p></details>
      {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2"><Button variant="outline" onClick={onBack}>Назад</Button><Button variant="outline" disabled={saving || checking || searching || (source === 'custom' && !customArgs.trim())} onClick={() => void check()}>{checking ? 'Проверка…' : 'Проверить стратегию'}</Button><Button disabled={saving || checking || searching || (source === 'custom' && !customArgs.trim())} onClick={() => void save()}>{saving ? 'Сохраняется…' : 'Сохранить и применить'}</Button></div>
    </>}
  </div>
}

import { useEffect, useState } from 'react'
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
}

interface CheckResult {
  success: boolean
  error?: string
  checkedAt?: string
  mode?: 'tcp' | 'tcp-quic'
  selectedVariant?: number
  selectedQuicVariant?: number | null
  tcpWorking?: boolean
  quicWorking?: boolean
  tcpSites?: number
  http3Sites?: number
  siteCount?: number
  verifiedTransport?: 'tcp' | 'tcp-quic' | 'none'
  candidates?: Array<{ variant: number; quicVariant?: number; phase?: 'tcp' | 'quic'; mode: 'tcp' | 'tcp-quic'; tcpSites?: number; http3Sites?: number; error?: string }>
  results?: Array<{ protocol: 'tcp' | 'h3'; url: string; ok: boolean; status?: number; error?: string }>
}

type ProbeResult = NonNullable<CheckResult['results']>[number]

function probeStatus(item?: ProbeResult) {
  if (!item) return <span className="text-muted-foreground">—</span>
  return <span className={item.ok ? 'text-green-400' : 'text-amber-400'} title={item.error || undefined}>
    {item.ok ? `✓ ${item.status ? `HTTP ${item.status}` : 'Ответ есть'}` : `○ ${item.error || 'Нет ответа'}`}
  </span>
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

  useEffect(() => {
    let active = true
    void apiCall<Settings>('GET', 'nfqws2/settings').then((value) => {
      if (!active) return
      setSettings(value)
      setMode(value.mode)
      setSource(value.source)
      setCustomArgs(value.customArgs)
      setReport(value.lastCheck ?? null)
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить настройки')
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  async function save() {
    setSaving(true)
    setError('')
    try {
      const result = await apiCall<{ success: boolean; settings?: Settings; check?: CheckResult; error?: string }>('POST', 'nfqws2/settings', { source, customArgs })
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
      const result = await apiCall<CheckResult>('POST', 'nfqws2/check', { source: draftSource, customArgs: draftArgs })
      if (!result.success) throw new Error(result.error || 'Проверка не завершилась')
      setReport(result)
      onRefresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Ошибка проверки')
    } finally {
      setChecking(false)
    }
  }

  const siteRows = [...new Set(report?.results?.map(item => item.url) ?? [])].map(url => ({
    url,
    name: url.includes('youtube') ? 'YouTube' : url.includes('discord') ? 'Discord' : url.includes('instagram') ? 'Instagram' : url,
    tcp: report?.results?.find(item => item.url === url && item.protocol === 'tcp'),
    quic: report?.results?.find(item => item.url === url && item.protocol === 'h3'),
  }))

  return <div className="space-y-4">
    {loading ? <p className="text-muted-foreground text-sm">Загрузка настроек…</p> : <>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-medium">Стратегия
          <select className="bg-input-background border-border mt-1 h-9 w-full rounded-md border px-2 text-sm" value={source} onChange={(event) => { setSource(event.target.value as 'preset' | 'custom'); setReport(null) }}>
            <option value="preset">Автоподбор стратегии и транспорта</option>
            <option value="custom">Своя</option>
          </select>
        </label>
        <div className="rounded-md border p-3 text-sm">
          <div className="font-medium">Настроено: {source === 'custom' ? customArgs.split('\n').some((line) => line.trim() === '--filter-udp=443') ? 'TCP + QUIC' : 'TCP' : mode === 'tcp' ? 'TCP' : 'TCP + QUIC'}</div>
          <div className="text-muted-foreground text-xs">{report?.success ? `Последняя проверка: TCP ${report.tcpSites ?? report.results?.filter(item => item.protocol === 'tcp' && item.ok).length ?? 0}/3, HTTP/3 ${report.http3Sites ?? report.results?.filter(item => item.protocol === 'h3' && item.ok).length ?? 0}/3` : 'Транспорт считается рабочим только после ответа сайта через диагностическую очередь.'}</div>
        </div>
      </div>
      <p className="text-muted-foreground text-xs">{settings?.scope}</p>
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
      {source === 'preset' && <div className="rounded-md border p-3">
        <p className="text-sm font-medium">Параметры выбранной стратегии</p>
        <p className="text-muted-foreground text-xs">Автоподбор проверяет четыре варианта TCP, затем два варианта QUIC с лучшим TCP. Проверки идут в отдельной очереди. Каждые 10 минут роутер проверяет выбранную стратегию; после двух неудач повторяет подбор. Если рабочей замены нет, текущая стратегия сохраняется.</p>
        <div className="text-muted-foreground mt-2 text-xs">TCP</div>
        <pre className="overflow-x-auto whitespace-pre-wrap break-all text-xs">{settings?.tcpLua.join('\n')}</pre>
        {mode === 'tcp-quic' && <><div className="text-muted-foreground mt-2 text-xs">QUIC</div><pre className="overflow-x-auto whitespace-pre-wrap break-all text-xs">{settings?.quicLua}</pre></>}
      </div>}
      {report?.results && <div className="rounded-md border p-3 text-sm">
        <p className="font-medium">Проверка сайтов {report.checkedAt ? `· ${new Date(report.checkedAt).toLocaleTimeString('ru-RU')}` : ''}</p>
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
        {report.candidates && <div className="mt-3 space-y-1 border-t pt-3">
          <p className="text-xs font-medium">Автоподбор · {report.candidates.length} проверок</p>
          {report.candidates.map((item) => {
            const selected = item.variant === report.selectedVariant && (item.mode === 'tcp' ? report.mode === 'tcp' : item.quicVariant === report.selectedQuicVariant && report.mode === 'tcp-quic')
            const name = ['TLS + Multisplit', 'Fake TLS', 'Multisplit', 'Fake TLS + Multidisorder'][item.variant] ?? `Вариант ${item.variant + 1}`
            return <div key={`${item.variant}:${item.mode}:${item.quicVariant ?? 0}`} className={`flex flex-wrap justify-between gap-x-3 rounded px-2 py-1 text-xs ${selected ? 'bg-green-500/10 text-green-400' : 'text-muted-foreground'}`}>
              <span>{selected ? '✓ ' : ''}{name} · {item.mode === 'tcp-quic' ? `QUIC ${item.quicVariant === 1 ? '6' : '11'} повторов` : 'TCP'}</span>
              <span title={item.error}>{item.error ? 'проверка не удалась' : `TCP ${item.tcpSites ?? 0}/3 · HTTP/3 ${item.http3Sites ?? 0}/3`}</span>
            </div>
          })}
        </div>}
        <p className="text-muted-foreground mt-2 text-xs">Проверка показывает ответ каждого сайта в момент замера; она не гарантирует доступность всех ресурсов.</p>
      </div>}
      <p className="text-muted-foreground text-xs">После проверки кнопка «Сохранить и применить» использует её результат в течение 5 минут. Если параметры изменились или срок истёк, проверка запускается снова.</p>
      {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2"><Button variant="outline" onClick={onBack}>Назад</Button><Button variant="outline" disabled={saving || checking || (source === 'custom' && !customArgs.trim())} onClick={() => void check()}>{checking ? 'Проверка…' : 'Проверить стратегию'}</Button><Button disabled={saving || checking || (source === 'custom' && !customArgs.trim())} onClick={() => void save()}>{saving ? 'Сохраняется…' : 'Сохранить и применить'}</Button></div>
    </>}
  </div>
}

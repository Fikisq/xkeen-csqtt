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
  tcpWorking?: boolean
  quicWorking?: boolean
  verifiedTransport?: 'tcp' | 'tcp-quic' | 'none'
  candidates?: Array<{ variant: number; mode: 'tcp' | 'tcp-quic'; tcpSites?: number; http3Sites?: number; error?: string }>
  results?: Array<{ protocol: 'tcp' | 'h3'; url: string; ok: boolean; status?: number; error?: string }>
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
      showToast(result.check?.verifiedTransport === 'tcp-quic' ? 'Стратегия сохранена: TCP + HTTP/3 проверены' : 'Стратегия сохранена: TCP проверен')
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
          <div className="text-muted-foreground text-xs">{report?.success ? `Последняя проверка: TCP ${report.tcpWorking ? 'доступен' : 'нет ответа'}, HTTP/3 ${report.quicWorking ? 'доступен' : 'нет ответа'}` : 'Транспорт считается рабочим только после ответа сайта через диагностическую очередь.'}</div>
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
        <p className="text-muted-foreground text-xs">Пул содержит шесть сочетаний: три набора TCP-параметров с QUIC и без него. Они собираются и проверяются в отдельной очереди. Каждые 10 минут роутер проверяет выбранный вариант; после двух неудачных проверок повторяет подбор. Если подходящего варианта нет, текущий сохраняется.</p>
        <div className="text-muted-foreground mt-2 text-xs">TCP</div>
        <pre className="overflow-x-auto whitespace-pre-wrap break-all text-xs">{settings?.tcpLua.join('\n')}</pre>
        {mode === 'tcp-quic' && <><div className="text-muted-foreground mt-2 text-xs">QUIC</div><pre className="overflow-x-auto whitespace-pre-wrap break-all text-xs">{settings?.quicLua}</pre></>}
      </div>}
      {report?.results && <div className="rounded-md border p-3 text-sm">
        <p className="font-medium">Проверка сайтов {report.checkedAt ? `· ${new Date(report.checkedAt).toLocaleTimeString('ru-RU')}` : ''}</p>
        <div className="mt-2 grid gap-1.5 sm:grid-cols-2">{report.results.map((item) => {
          const site = item.url.includes('youtube') ? 'YouTube' : item.url.includes('discord') ? 'Discord' : 'Instagram'
          return <div key={`${item.protocol}:${item.url}`} className="flex gap-2 text-xs"><span className={item.ok ? 'text-green-400' : 'text-amber-400'}>{item.ok ? '●' : '○'}</span><span>{site} · {item.protocol === 'h3' ? 'HTTP/3' : 'TCP'}: {item.ok ? `ответ ${item.status}` : item.error || 'нет ответа'}</span></div>
        })}</div>
        {report.candidates && <div className="mt-3 space-y-1 border-t pt-3">
          <p className="text-xs font-medium">Автоподбор · {report.candidates.length} проверок</p>
          {report.candidates.map((item) => {
            const selected = item.variant === report.selectedVariant && item.mode === report.mode
            const name = ['Комбинация TLS', 'Fake TLS', 'Multisplit'][item.variant] ?? `Вариант ${item.variant + 1}`
            return <div key={`${item.variant}:${item.mode}`} className={`flex flex-wrap justify-between gap-x-3 rounded px-2 py-1 text-xs ${selected ? 'bg-green-500/10 text-green-400' : 'text-muted-foreground'}`}>
              <span>{selected ? '✓ ' : ''}{name} · {item.mode === 'tcp-quic' ? 'TCP + QUIC' : 'TCP'}</span>
              <span>{item.error ? 'проверка не удалась' : `TCP ${item.tcpSites ?? 0}/3 · HTTP/3 ${item.http3Sites ?? 0}/3`}</span>
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

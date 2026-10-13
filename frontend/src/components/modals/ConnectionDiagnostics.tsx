import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { apiCall } from '@/lib/api'
import { useSettings } from '@/lib/store'
import { routeLabel } from '@/components/configuration/RouteIcon'

interface Result {
  success: boolean; error?: string; dnsAddresses: string[]; dnsError?: string; coreRunning: boolean
  predictions: Array<{ip: string; protocol: string; rule: string; outbound?: string; balancer?: string; uncertain: boolean; unchecked?: string[]}>
  observations: Array<{timestamp: string; protocol: string; destination: string; outbound: string}>
  errors: string[]
}
export function ConnectionDiagnostics({open, onOpenChange, devices, selectedDevice, titles}: {open: boolean; onOpenChange: (open: boolean) => void; devices: string[]; selectedDevice: string; titles: Record<string, string>}) {
  const timezone = useSettings(state => state.timezone)
  const label = (tag: string) => { const stable = tag.split('-xk-live-')[0]; return titles[stable] || stable }
  const time = (stamp: string) => {
    const parsed = Date.parse(stamp.replaceAll('/', '-').replace(' ', 'T').slice(0, 23) + 'Z')
    return Number.isFinite(parsed) ? new Date(parsed + timezone * 3600000).toISOString().slice(0, 19).replace('T', ' ') : stamp
  }
  const [device, setDevice] = useState(selectedDevice || devices[0] || '')
  const [resource, setResource] = useState('')
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { if (open && selectedDevice) setDevice(selectedDevice) }, [open, selectedDevice])
  async function inspect() {
    setPending(true); setError(''); setResult(null)
    try {
      const data = await apiCall<Result>('GET', `diagnostics/connections?device=${encodeURIComponent(device)}&resource=${encodeURIComponent(resource.trim())}`)
      if (!data.success) throw new Error(data.error || 'Не удалось получить диагностику')
      setResult(data)
    } catch (error) { setError(error instanceof Error ? error.message : 'Ошибка диагностики') }
    finally { setPending(false) }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="flex! max-h-[92dvh] max-w-[min(96vw,1000px)]! flex-col overflow-hidden">
    <DialogHeader className="shrink-0"><DialogTitle>Диагностика соединений</DialogTitle></DialogHeader>
    <div className="min-h-0 space-y-4 overflow-y-auto pr-2">
      <div className="grid gap-3 sm:grid-cols-[180px_1fr_auto]">
        <label className="text-sm">Устройство<Input value={device} onChange={event => setDevice(event.target.value)} list="diagnostic-devices" placeholder="192.168.0.130" /><datalist id="diagnostic-devices">{devices.map(ip => <option key={ip} value={ip} />)}</datalist></label>
        <label className="text-sm">Домен, IP или URL<Input value={resource} onChange={event => setResource(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !pending) void inspect() }} placeholder="youtube.com или 93.85.248.110:8080" /></label>
        <Button className="self-end" disabled={pending || !device || !resource.trim()} onClick={() => void inspect()}>{pending ? 'Загрузка…' : 'Показать'}</Button>
      </div>
      <p className="text-muted-foreground text-sm">Откройте ресурс на устройстве, затем нажмите «Показать». Диагностика читает журнал и конфигурацию, соединения от имени устройства не создаёт.</p>
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {result && <>
        {!result.coreRunning && <p className="text-amber-500">Xray остановлен. Ниже записи предыдущих соединений.</p>}
        <section className="space-y-2 rounded-md border p-3"><h3 className="font-medium">DNS роутера</h3><p className="break-all">{result.dnsAddresses.join(', ') || result.dnsError || 'Адреса не найдены'}</p><p className="text-muted-foreground text-xs">DNS устройства может вернуть другие адреса. У разных доменов на общем CDN могут совпадать IP.</p></section>
        <section className="space-y-2"><h3 className="font-medium">Фактический выход · access.log</h3>
          {!result.observations.length ? <p className="text-muted-foreground">В последней части журнала совпадений нет. Возможны кеш браузера, другой IP ресурса или обход Xray.</p> : <div className="overflow-x-auto rounded-md border"><table className="w-full text-left text-sm"><thead><tr>{['Время журнала', 'Сеть', 'Назначение', 'Выход'].map(title => <th className="p-2" key={title}>{title}</th>)}</tr></thead><tbody>{result.observations.map((row, index) => <tr className="border-t" key={index}><td className="p-2 whitespace-nowrap">{time(row.timestamp)}</td><td className="p-2">{row.protocol.toUpperCase()}</td><td className="p-2 break-all">{row.destination}</td><td className="p-2 break-all">{label(row.outbound)}</td></tr>)}</tbody></table></div>}
        </section>
        <section className="space-y-2"><h3 className="font-medium">Предполагаемое правило</h3><p className="text-muted-foreground text-xs">В журнале нет имени правила. Это расчёт по текущей конфигурации и DNS роутера для входов redirect/tproxy. Неизвестные условия отмечены «?».</p>{result.predictions.map((row, index) => <div key={index} title={row.unchecked?.join("; ")} className="flex flex-wrap justify-between gap-2 rounded-md border p-2 text-sm"><span>{row.protocol.toUpperCase()} · {row.ip}</span><span className="break-all">{row.uncertain ? '? ' : ''}{routeLabel(row.rule.replace(/^device:[^:]+:/, "").replace(/\|(selector|nfqws2|split|bypass)$/, ""))} → {row.outbound ? label(row.outbound) : row.balancer || "Не определён"}</span></div>)}</section>
        <section className="space-y-2"><h3 className="font-medium">Связанные сообщения · error.log</h3><p className="text-muted-foreground text-xs">Поиск по устройству, домену и IP. Сообщения только с идентификатором сессии сюда не попадут.</p>{result.errors.length ? <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all rounded-md border p-3 text-xs">{result.errors.join('\n')}</pre> : <p className="text-muted-foreground">Совпадающих сообщений нет.</p>}</section>
      </>}
    </div>
  </DialogContent></Dialog>
}

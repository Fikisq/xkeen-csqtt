import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { apiCall } from '@/lib/api'
import { ruleSetLabel } from '@/lib/geoLabels'

type Provider = { name: string; behavior: string; format: string; source: string; installed: boolean; size: number }

export function MihomoGeodata({ refresh = 0 }: { refresh?: number }) {
  const [files, setFiles] = useState<Array<{name: string; kind: string; format: string; installed: boolean; size: number}>>([])
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void apiCall<{success: boolean; error?: string; geofiles?: typeof files}>('GET', 'geo/mihomo').then(result => {
      if (!result.success) throw new Error(result.error || 'Не удалось прочитать геобазы')
      if (active) setFiles(result.geofiles ?? [])
    }).catch(error => { if (active) setError(String(error)) })
    return () => { active = false }
  }, [refresh])
  return <div className="space-y-3 px-4 pt-4"><p className="text-muted-foreground text-sm">Геобазы ядра Mihomo. GeoSite хранит категории доменов, GeoIP DAT и MMDB — IP. Для GeoIP DAT в конфигурации нужен geodata-mode: true. Проверка категорий ниже работает с .dat.</p>
    {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{files.map(file => <div key={file.name} className="bg-input-background rounded-lg border p-3"><div className="text-sm font-medium">{file.name}</div><div className="text-muted-foreground text-xs">{file.kind === 'domain' ? 'Домены' : file.kind === 'asn' ? 'ASN' : 'IP'} · {file.format.toUpperCase()} · {file.installed ? `${Math.ceil(file.size/1024)} КБ · установлен` : 'Не установлен'}</div></div>)}</div>
  </div>
}

export function MihomoGeoFiles({ kind, resources, onChange }: {
  kind?: 'domain' | 'ip'; resources?: string[]; onChange?: (resources: string[]) => void
}) {
  const [files, setFiles] = useState<Provider[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState(kind ?? 'all')
  const [preview, setPreview] = useState<{name: string; content: string; total: number; error?: string} | null>(null)
  const [reading, setReading] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void apiCall<{success: boolean; files?: Provider[]; error?: string}>('GET', 'geo/mihomo').then(result => {
      if (!result.success) throw new Error(result.error || 'Не удалось прочитать rule-set’ы Mihomo')
      if (active) setFiles(result.files ?? [])
    }).catch(error => { if (active) setError(String(error)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])
  async function show(provider: Provider) {
    setReading(provider.name); setPreview({name: provider.name, content: '', total: 0})
    try {
      const result = await apiCall<{success: boolean; content?: string; error?: string}>('GET', `ruleset?name=${encodeURIComponent(provider.name)}`)
      if (!result.success) throw new Error(result.error || 'Не удалось прочитать rule-set')
      const lines = (result.content ?? '').split(/\r?\n/).filter(Boolean)
      setPreview(current => current?.name === provider.name ? {name: provider.name, content: lines.slice(0,400).join('\n'), total: lines.length} : current)
    } catch (error) {
      setPreview(current => current?.name === provider.name ? {...current, error: String(error)} : current)
    } finally { setReading(null) }
  }
  const visible = files.filter(file => (filter === 'all' || file.behavior === (filter === 'ip' ? 'ipcidr' : 'domain')) && `${ruleSetLabel(file.name)} ${file.name} ${file.source}`.toLowerCase().includes(search.toLowerCase()))
  return <div className="space-y-4">
    <p className="text-muted-foreground text-sm">Наборы правил Mihomo: домены и IP в формате MRS. Просмотр работает при неактивном ядре и не меняет маршрутизацию.</p>
    <div className="flex flex-wrap gap-2"><Input className="min-w-48 flex-1" placeholder="Поиск базы или категории…" value={search} onChange={event => setSearch(event.target.value)} />
      {!kind && <select aria-label="Тип ресурсов Mihomo" className="border-input bg-input-background rounded-md border px-3" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">Домены и IP</option><option value="domain">Домены</option><option value="ip">IP</option></select>}
    </div>
    {loading && <p role="status" className="text-muted-foreground text-sm">Загрузка списка…</p>}
    {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    {!loading && !files.length && <p className="text-muted-foreground text-sm">В сохранённой конфигурации Mihomo ещё нет rule-provider’ов.</p>}
    <div className="border-border bg-input-background overflow-hidden rounded-xl border"><table className="w-full table-fixed text-left text-ui"><thead className="bg-card text-muted-foreground"><tr>{onChange&&<th className="w-10"/>}<th className="p-3 font-medium">База</th><th className="hidden w-36 p-3 font-medium sm:table-cell">Формат / размер</th><th className="w-28 p-3"/></tr></thead><tbody>{visible.map(file=>{
      const value=`RULE-SET,${file.name}`
      return <tr key={file.name} className="border-border border-t">{onChange&&<td className="p-3"><Checkbox aria-label={`Выбрать ${ruleSetLabel(file.name)}`} checked={resources?.includes(value)??false} onCheckedChange={checked=>onChange(checked?[...new Set([...(resources??[]),value])]:(resources??[]).filter(item=>item!==value))}/></td>}<td className="break-words p-3"><div className="font-medium">{ruleSetLabel(file.name)}</div><div className="text-muted-foreground text-xs">{file.behavior==='ipcidr'?'IP':file.behavior==='domain'?'Домены':'Смешанные правила'}</div></td><td className="text-muted-foreground hidden p-3 text-xs sm:table-cell">{file.format.toUpperCase()} · {file.installed?`${Math.max(1,Math.ceil(file.size/1024))} КБ`:'Не загружена'}</td><td className="p-3"><Button size="sm" variant="outline" disabled={!file.installed||reading!==null} onClick={()=>void show(file)}>{reading===file.name?'Чтение…':'Просмотр'}</Button></td></tr>
    })}</tbody></table></div>
    <Dialog open={preview !== null} onOpenChange={open => { if (!open) setPreview(null) }}>
      <DialogContent className="max-h-[85dvh] overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="pr-8">{preview ? ruleSetLabel(preview.name) : 'Просмотр rule-set'}</DialogTitle>
          <DialogDescription>{reading ? 'Чтение набора правил…' : preview?.error ? 'Не удалось открыть набор правил.' : `Записей: ${preview?.total ?? 0}`}</DialogDescription>
        </DialogHeader>
        {reading ? <p role="status" className="text-muted-foreground text-sm">Загрузка содержимого…</p>
          : preview?.error ? <p role="alert" className="text-sm text-red-400">{preview.error}</p>
          : <pre tabIndex={0} aria-label="Содержимое rule-set" className="bg-input-background max-h-[55dvh] overflow-auto rounded-lg border p-3 text-sm">{preview?.content || 'Набор правил пуст.'}</pre>}
        {!reading && (preview?.total ?? 0) > 400 && <p className="text-muted-foreground text-xs">Показаны первые 400 записей.</p>}
      </DialogContent>
    </Dialog>
  </div>
}

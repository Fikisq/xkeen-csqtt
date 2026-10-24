import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { apiCall } from '@/lib/api'
import { ruleSetLabel } from '@/lib/geoLabels'

type Provider = { name: string; behavior: string; format: string; source: string; installed: boolean; size: number }

export function MihomoGeoFiles({ kind, resources, onChange }: {
  kind?: 'domain' | 'ip'; resources?: string[]; onChange?: (resources: string[]) => void
}) {
  const [files, setFiles] = useState<Provider[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState(kind ?? 'all')
  const [preview, setPreview] = useState<{name: string; content: string; total: number} | null>(null)
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
    setReading(provider.name); setError(''); setPreview(null)
    try {
      const result = await apiCall<{success: boolean; content?: string; error?: string}>('GET', `ruleset?name=${encodeURIComponent(provider.name)}`)
      if (!result.success) throw new Error(result.error || 'Не удалось прочитать rule-set')
      const lines = (result.content ?? '').split(/\r?\n/).filter(Boolean)
      setPreview({name: provider.name, content: lines.slice(0,400).join('\n'), total: lines.length})
    } catch (error) { setError(String(error)) } finally { setReading(null) }
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
    <div className="grid gap-2 md:grid-cols-2">{visible.map(file => {
      const value = `RULE-SET,${file.name}`
      return <div key={file.name} className="border-border bg-input-background flex items-center gap-3 rounded-lg border p-3">
        {onChange && <Checkbox aria-label={`Выбрать ${ruleSetLabel(file.name)}`} checked={resources?.includes(value) ?? false} onCheckedChange={checked => onChange(checked ? [...new Set([...(resources ?? []), value])] : (resources ?? []).filter(item => item !== value))} />}
        <div className="min-w-0 flex-1"><div className="break-words text-sm font-medium">{ruleSetLabel(file.name)}</div><div className="text-muted-foreground text-xs">{file.behavior === 'ipcidr' ? 'IP' : file.behavior === 'domain' ? 'Домены' : 'Смешанные правила'} · {file.format.toUpperCase()} · {file.installed ? `${Math.max(1,Math.ceil(file.size/1024))} КБ` : 'Файл не загружен'}</div></div>
        <Button size="sm" variant="outline" disabled={!file.installed || reading !== null} onClick={() => void show(file)}>{reading === file.name ? 'Чтение…' : 'Просмотр'}</Button>
      </div>
    })}</div>
    {preview && <section className="space-y-2"><h3 className="text-sm font-medium">{ruleSetLabel(preview.name)} · записей: {preview.total}</h3><pre className="bg-input-background max-h-80 overflow-auto rounded-lg border p-3 text-xs">{preview.content}</pre>{preview.total > 400 && <p className="text-muted-foreground text-xs">Показаны первые 400 записей.</p>}</section>}
  </div>
}

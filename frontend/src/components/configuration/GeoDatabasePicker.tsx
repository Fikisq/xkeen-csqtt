import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { apiCall } from '@/lib/api'
import { cn } from '@/lib/utils'
import { geoCategoryLabel, geoDatabaseLabel, resourceLabel } from '@/lib/geoLabels'

type Category = { file: string; name: string; count: number }
type RecordEntry = { kind: string; value: string }
type Result<T> = { success: boolean; error?: string } & T
const aiDomains = ['geosite:openai', 'geosite:anthropic', 'geosite:perplexity', 'domain:gemini.google.com', 'domain:aistudio.google.com']

function resourceValue(kind: 'domain' | 'ip', item: Category): string {
  const name = item.name.toLowerCase()
  if (kind === 'domain' && item.file === 'geosite.dat') return `geosite:${name}`
  if (kind === 'ip' && item.file === 'geoip.dat') return `geoip:${name}`
  return `ext:${item.file}:${name}`
}

export function GeoDatabasePicker({ kind, resources, onChange, onPick, nativeOnly = false }: {
  kind: 'domain' | 'ip'
  resources: string[]
  onChange: (resources: string[]) => void
  onPick?: (name: string) => void
  nativeOnly?: boolean
}) {
  const [files, setFiles] = useState<string[]>([])
  const [fileFilter, setFileFilter] = useState('')
  const [search, setSearch] = useState('')
  const [categories, setCategories] = useState<Category[]>([])
  const [active, setActive] = useState<Category | null>(null)
  const [recordFilter, setRecordFilter] = useState('')
  const [page, setPage] = useState(0)
  const [records, setRecords] = useState<RecordEntry[]>([])
  const [recordTotal, setRecordTotal] = useState(0)
  const [error, setError] = useState('')
  const [recordError, setRecordError] = useState('')
  const [uploading, setUploading] = useState(false)
  const [loading, setLoading] = useState(false)
  const [recordLoading, setRecordLoading] = useState(false)
  const uploadInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let alive = true
    void apiCall<Result<{ site_files?: string[]; ip_files?: string[] }>>('GET', 'geo').then(result => {
      if (!result.success) throw new Error(result.error || 'Не удалось загрузить базы')
      if (alive) setFiles(((kind === 'ip' ? result.ip_files : result.site_files) ?? []).filter(file => !nativeOnly || file === (kind === 'ip' ? 'geoip.dat' : 'geosite.dat')))
    }).catch(e => { if (alive) setError(String(e)) })
    return () => { alive = false }
  }, [kind, nativeOnly])

  useEffect(() => {
    let alive = true
    setLoading(true)
    setCategories([])
    if (!files.length) { setLoading(false); return }
    void Promise.all(files.map(async file => {
      const result = await apiCall<Result<{ categories?: Array<{ name: string; count: number }> }>>('GET', `geo/categories?file=${encodeURIComponent(file)}&kind=${kind}`)
      if (!result.success) throw new Error(`${file}: ${result.error || 'Не удалось прочитать базу'}`)
      return (result.categories ?? []).map(item => ({ ...item, file }))
    })).then(groups => {
      if (alive) { setCategories(groups.flat().sort((a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file))); setError('') }
    }).catch(e => { if (alive) setError(String(e)) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [files, kind])

  useEffect(() => {
    let alive = true
    if (!active) { setRecords([]); setRecordTotal(0); return }
    setRecordLoading(true)
    setRecordError('')
    const timer = setTimeout(() => {
      const query = new URLSearchParams({ file: active.file, kind, category: active.name, filter: recordFilter, offset: String(page * 100) })
      void apiCall<Result<{ total?: number; entries?: RecordEntry[] }>>('GET', `geo/records?${query}`).then(result => {
        if (!result.success) throw new Error(result.error || 'Не удалось прочитать записи')
        if (alive) { setRecords(result.entries ?? []); setRecordTotal(result.total ?? 0) }
      }).catch(e => { if (alive) setRecordError(String(e)) }).finally(() => { if (alive) setRecordLoading(false) })
    }, recordFilter ? 250 : 0)
    return () => { alive = false; clearTimeout(timer) }
  }, [active, kind, page, recordFilter])

  async function upload(database: File) {
    if (!database.name.endsWith('.dat') || !database.size || database.size > 32 * 1024 * 1024) { setError('Нужна база Xray .dat размером до 32 МБ'); return }
    setUploading(true); setError('')
    try {
      const response = await fetch(`/api/geo/upload?file=${encodeURIComponent(database.name)}&kind=${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: database })
      if (response.status === 413) throw new Error('База превышает ограничение 32 МБ')
      const result = await response.json()
      if (!response.ok || !result.success) throw new Error(result.error || 'Не удалось загрузить базу')
      setFiles(current => [...new Set([...current, result.file])].sort())
      setFileFilter(result.file)
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось загрузить базу') }
    finally { setUploading(false); if (uploadInput.current) uploadInput.current.value = '' }
  }

  function toggle(item: Category) {
    const value = resourceValue(kind, item)
    if (resources.includes(value)) onChange(resources.filter(selected => selected !== value))
    else { onChange([...resources, value]); onPick?.(item.name) }
  }

  const visible = useMemo(() => categories.filter(item =>
    (!fileFilter || item.file === fileFilter) && `${item.name} ${geoCategoryLabel(item.name)} ${geoDatabaseLabel(item.file)}`.toLowerCase().includes(search.trim().toLowerCase())
  ), [categories, fileFilter, search])

  return <div className="space-y-3">
    <div className="flex flex-wrap gap-2">
      <select aria-label="Фильтр базы ресурсов" className="border-border bg-background min-w-0 flex-1 rounded-md border px-2 py-2 text-sm" value={fileFilter} onChange={event => setFileFilter(event.target.value)} disabled={uploading}>
        <option value="">Все базы ({files.length})</option>
        {files.map(name => <option key={name} value={name}>{geoDatabaseLabel(name)}</option>)}
      </select>
      {!nativeOnly && <><input ref={uploadInput} type="file" accept=".dat" className="hidden" onChange={event => { const selected = event.target.files?.[0]; if (selected) void upload(selected) }} /><Button size="sm" variant="outline" disabled={uploading} onClick={() => uploadInput.current?.click()}>{uploading ? 'Загрузка…' : 'Добавить базу .dat'}</Button></>}
    </div>
    <Input value={search} onChange={event => setSearch(event.target.value)} placeholder="Поиск категории во всех базах…" aria-label="Поиск категории базы" />
    {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    <div className="flex max-h-20 flex-wrap gap-1.5 overflow-y-auto" aria-label="Выбранные ресурсы">
      {resources.map(value => {
        const category = categories.find(item => resourceValue(kind, item) === value)
        return <span key={value} title={value} className="flex max-w-full items-center rounded-md border border-blue-400 bg-blue-500/20 text-xs text-blue-100">
          {category ? <button type="button" className="min-w-0 truncate py-1 pl-2 text-left hover:underline" onClick={() => { setActive(category); setRecordFilter(''); setPage(0) }} aria-label={`Посмотреть ${value}`}>{resourceLabel(value)}</button>
            : <span className="min-w-0 truncate py-1 pl-2">{resourceLabel(value)}</span>}
          <button type="button" onClick={() => onChange(resources.filter(item => item !== value))} aria-label={`Убрать ${value}`} title={`Убрать ${value}`} className="shrink-0 rounded-r-md px-2 py-1 hover:bg-red-500/20 hover:text-red-300">×</button>
        </span>
      })}
    </div>
    <div className="border-border grid h-[min(55vh,540px)] min-h-80 overflow-hidden rounded-md border md:grid-cols-2">
      <div className="border-border min-h-0 overflow-y-auto border-b p-1 md:border-r md:border-b-0">
        {kind === 'domain' && (!fileFilter || fileFilter === 'geosite.dat') && (!search.trim() || 'нейронки ai artificial intelligence'.includes(search.trim().toLowerCase())) && <button type="button" className="flex w-full justify-between rounded px-2 py-2 text-left text-sm hover:bg-blue-500/10" aria-pressed={aiDomains.every(value => resources.includes(value))} onClick={() => {
          const selected = aiDomains.every(value => resources.includes(value))
          onChange(selected ? resources.filter(value => !aiDomains.includes(value)) : [...new Set([...resources, ...aiDomains])])
          if (!selected) onPick?.('Нейронки')
        }}><span>{aiDomains.every(value => resources.includes(value)) ? '✓ ' : ''}Нейронки</span><span className="text-muted-foreground">набор</span></button>}
        {visible.slice(0, 250).map(item => {
          const selected = resources.includes(resourceValue(kind, item))
          const focused = active?.file === item.file && active?.name === item.name
          return <div key={`${item.file}:${item.name}`} className={cn('flex items-center rounded text-sm hover:bg-blue-500/10', focused && 'bg-blue-500/20')}>
            <Checkbox aria-label={`Выбрать ${item.name} из ${item.file}`} checked={selected} onCheckedChange={() => toggle(item)} className="ml-2 size-4 shrink-0" />
            <button type="button" onClick={() => { setActive(item); setRecordFilter(''); setPage(0) }} className="flex min-w-0 flex-1 items-center justify-between gap-2 px-2 py-2 text-left" aria-label={`Посмотреть ${item.name} из ${item.file}`}>
              <span className="min-w-0 truncate" title={`${item.file}:${item.name}`}>{geoCategoryLabel(item.name)}<small className="text-muted-foreground ml-1 block truncate">{geoDatabaseLabel(item.file)}</small></span>
              <span className="text-muted-foreground shrink-0">{item.count}</span>
            </button>
          </div>
        })}
        {loading && <p className="text-muted-foreground px-2 py-2 text-xs">Чтение категорий…</p>}
        {!loading && !visible.length && <p className="text-muted-foreground px-2 py-2 text-xs">Категорий не найдено.</p>}
        {visible.length > 250 && <p className="text-muted-foreground px-2 py-2 text-xs">Показано 250 из {visible.length}. Уточните поиск.</p>}
      </div>
      <div className="flex min-h-0 min-w-0 flex-col">
        <div className="border-border border-b px-3 py-2 text-sm font-medium">{active ? `${geoCategoryLabel(active.name)} · ${recordTotal} записей` : 'Выберите категорию для просмотра'}</div>
        {active && <Input value={recordFilter} onChange={event => { setRecordFilter(event.target.value); setPage(0) }} placeholder="Поиск внутри категории…" aria-label="Поиск записей категории" className="mx-2 mt-2 w-[calc(100%-1rem)]" />}
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {recordError && <p role="alert" className="text-sm text-red-400">{recordError}</p>}
          {recordLoading && <p className="text-muted-foreground text-xs">Чтение записей…</p>}
          {!recordLoading && records.map((record, index) => <div key={`${index}:${record.value}`} className="border-border flex gap-2 border-b px-1 py-1.5 text-xs"><span className="text-muted-foreground w-16 shrink-0">{record.kind}</span><span className="break-all font-mono">{record.value}</span></div>)}
          {active && !recordLoading && !records.length && !recordError && <p className="text-muted-foreground text-xs">Записей не найдено.</p>}
        </div>
        {active && recordTotal > 100 && <div className="border-border flex items-center justify-end gap-2 border-t px-2 py-1 text-xs">
          <span className="text-muted-foreground">{page * 100 + 1}–{Math.min((page + 1) * 100, recordTotal)} из {recordTotal}</span>
          <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage(value => value - 1)}>‹</Button>
          <Button size="sm" variant="ghost" disabled={(page + 1) * 100 >= recordTotal} onClick={() => setPage(value => value + 1)}>›</Button>
        </div>}
      </div>
    </div>
  </div>
}

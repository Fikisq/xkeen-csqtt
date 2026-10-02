import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { apiCall } from '@/lib/api'
import { cn } from '@/lib/utils'

export function GeoDatabasePicker({ kind, resources, onChange, onPick }: {
  kind: 'domain' | 'ip'
  resources: string[]
  onChange: (resources: string[]) => void
  onPick?: (name: string) => void
}) {
  const [files, setFiles] = useState<string[]>([])
  const [file, setFile] = useState('')
  const [search, setSearch] = useState('')
  const [categories, setCategories] = useState<Array<{ name: string; count: number }>>([])
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)
  const [loading, setLoading] = useState(false)
  const uploadInput = useRef<HTMLInputElement>(null)
  const aiDomains = ['geosite:openai', 'geosite:anthropic', 'geosite:perplexity', 'domain:gemini.google.com', 'domain:aistudio.google.com']
  useEffect(() => {
    let alive = true
    void apiCall<{success: boolean; site_files?: string[]; ip_files?: string[]; error?: string}>('GET', 'geo').then(result => {
      if (!alive) return
      if (!result.success) throw new Error(result.error || 'Не удалось загрузить базы')
      const available = (kind === 'ip' ? result.ip_files : result.site_files) ?? []
      const standard = kind === 'ip' ? 'geoip.dat' : 'geosite.dat'
      setFiles(available)
      setFile(available.includes(standard) ? standard : available[0] ?? '')
    }).catch(e => { if (alive) setError(String(e)) })
    return () => { alive = false }
  }, [kind])
  useEffect(() => {
    let alive = true
    setCategories([])
    if (!file) { setLoading(false); return }
    setLoading(true); setError('')
    void apiCall<{success: boolean; categories?: Array<{name: string; count: number}>; error?: string}>('GET', `geo/categories?file=${encodeURIComponent(file)}&kind=${kind}`).then(result => {
      if (alive) { setCategories(result.categories ?? []); setError(result.success ? '' : result.error || 'Не удалось прочитать базу') }
    }).catch(e => { if (alive) setError(String(e)) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [file, kind])
  async function upload(database: File) {
    if (!database.name.endsWith('.dat') || !database.size || database.size > 32 * 1024 * 1024) { setError('Нужна база Xray .dat размером до 32 МБ'); return }
    setUploading(true); setError('')
    try {
      const response = await fetch(`/api/geo/upload?file=${encodeURIComponent(database.name)}&kind=${kind}`, {method: 'POST', headers: {'Content-Type': 'application/octet-stream'}, body: database})
      if (response.status === 413) throw new Error('База превышает ограничение 32 МБ')
      const result = await response.json()
      if (!response.ok || !result.success) throw new Error(result.error || 'Не удалось загрузить базу')
      setFiles(current => [...new Set([...current, result.file])]); setFile(result.file)
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось загрузить базу') }
    finally { setUploading(false); if (uploadInput.current) uploadInput.current.value = '' }
  }
  function toggle(value: string, name: string) {
    if (resources.includes(value)) onChange(resources.filter(item => item !== value))
    else { onChange([...resources, value]); onPick?.(name) }
  }
  const visible = categories.filter(item => item.name.toLowerCase().includes(search.trim().toLowerCase())).slice(0, 100)
  return <div className="space-y-3">
    <div className="flex flex-wrap gap-2">
      <select aria-label="База ресурсов" className="border-border bg-background min-w-0 flex-1 rounded-md border px-2 py-2 text-sm" value={file} onChange={event => setFile(event.target.value)} disabled={uploading}>
        {!files.length && <option value="">Нет установленных баз</option>}
        {files.map(name => <option key={name} value={name}>{name}</option>)}
      </select>
      <input ref={uploadInput} type="file" accept=".dat" className="hidden" onChange={event => { const selected = event.target.files?.[0]; if (selected) void upload(selected) }} />
      <Button size="sm" variant="outline" disabled={uploading} onClick={() => uploadInput.current?.click()}>{uploading ? 'Загрузка…' : 'Добавить базу .dat'}</Button>
    </div>
    <Input value={search} onChange={event => setSearch(event.target.value)} placeholder="Поиск категории в выбранной базе…" aria-label="Поиск категории базы" />
    {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto" aria-label="Выбранные ресурсы">
      {resources.map(value => <button key={value} type="button" onClick={() => onChange(resources.filter(item => item !== value))} aria-label={`Убрать ${value}`} className="rounded-md border border-blue-400 bg-blue-500/20 px-2 py-1 text-xs text-blue-100">{value} ×</button>)}
    </div>
    <div className="border-border max-h-52 overflow-y-auto rounded-md border p-1">
      {kind === 'domain' && file === 'geosite.dat' && (!search.trim() || 'нейронки ai artificial intelligence'.includes(search.trim().toLowerCase())) && <button type="button" className="flex w-full justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-blue-500/10" aria-pressed={aiDomains.every(value => resources.includes(value))} onClick={() => {
        const selected = aiDomains.every(value => resources.includes(value))
        onChange(selected ? resources.filter(value => !aiDomains.includes(value)) : [...new Set([...resources, ...aiDomains])])
        if (!selected) onPick?.('Нейронки')
      }}><span>{aiDomains.every(value => resources.includes(value)) ? '✓ ' : ''}Нейронки</span><span className="text-muted-foreground">набор</span></button>}
      {visible.map(item => {
        const name = item.name.toLowerCase()
        const value = file === 'geosite.dat' && kind === 'domain' ? `geosite:${name}` : file === 'geoip.dat' && kind === 'ip' ? `geoip:${name}` : `ext:${file}:${name}`
        const selected = resources.includes(value)
        return <button key={item.name} type="button" aria-pressed={selected} onClick={() => toggle(value, item.name)} className={cn('flex w-full justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-blue-500/10', selected && 'bg-blue-500/20')}><span>{selected ? '✓ ' : ''}{item.name}</span><span className="text-muted-foreground">{item.count}</span></button>
      })}
      {loading && <p className="text-muted-foreground px-2 py-2 text-xs">Чтение категорий…</p>}
      {!loading && !visible.length && <p className="text-muted-foreground px-2 py-2 text-xs">Категорий нет. Выберите или загрузите базу.</p>}
    </div>
    <p className="text-muted-foreground text-xs">Выбрано ресурсов: {resources.length}. Можно выбирать категории из нескольких баз.</p>
    <p className="text-muted-foreground text-xs">Загрузка добавляет базу на роутер. Маршрут применяется после сохранения. Если имя уже занято, переименуйте файл перед загрузкой.</p>
  </div>
}

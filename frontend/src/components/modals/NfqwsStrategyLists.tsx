import { SettingInfo } from '@/components/ui/setting-info'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { apiCall } from '@/lib/api'
import { IconPlus, IconTrash, IconUpload, IconDownload } from '@tabler/icons-react'

interface Strategy { id: string; name: string; args: string }
interface StrategyList { id: string; name: string; enabled: boolean; entries: Strategy[] }
interface Catalog { success: boolean; error?: string; revision: string; lists: StrategyList[] }
const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

export function NfqwsStrategyLists({ readOnly, active }: { readOnly: boolean; active: boolean }) {
  const [reloadKey, setReloadKey] = useState(0)
  const [lists, setLists] = useState<StrategyList[]>([])
  const [revision, setRevision] = useState('')
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const file = useRef<HTMLInputElement>(null)
  const listElements = useRef(new Map<string, HTMLElement>())
  const entryElements = useRef(new Map<string, HTMLDetailsElement>())
  const [reveal, setReveal] = useState<{ id: string; kind: 'list' | 'entry' } | null>(null)

  useEffect(() => {
    if (!reveal) return
    const element = reveal.kind === 'list' ? listElements.current.get(reveal.id) : entryElements.current.get(reveal.id)
    if (element) {
      if (reveal.kind === 'entry') (element as HTMLDetailsElement).open = true
      element.scrollIntoView({ block: 'start', behavior: 'smooth' })
      element.querySelector<HTMLInputElement>('input[type="text"], input:not([type]), textarea')?.focus({ preventScroll: true })
    }
    setReveal(null)
  }, [reveal, lists])

  function addList() {
    const id = newId()
    change([...lists, { id, name: 'Новый список', enabled: true, entries: [] }])
    setNotice('Новый список добавлен в черновик. Заполните его и сохраните списки.')
    setReveal({ id, kind: 'list' })
  }

  function addEntry(listIndex: number) {
    const id = newId()
    editList(listIndex, { entries: [...lists[listIndex].entries, { id, name: 'Новая стратегия', args: '' }] })
    setReveal({ id, kind: 'entry' })
  }

  useEffect(() => {
    if (!active || loaded) return
    let mounted = true
    setBusy(true); setLoaded(false); setError(''); setNotice('')
    apiCall<Catalog>('GET', 'nfqws2/strategies').then(value => {
      if (!mounted) return
      if (!value.success) throw new Error(value.error || 'Не удалось загрузить списки')
      setLists(value.lists); setRevision(value.revision); setDirty(false); setLoaded(true)
    }).catch(cause => { if (mounted) setError(cause instanceof Error ? cause.message : 'Ошибка загрузки') })
      .finally(() => { if (mounted) setBusy(false) })
    return () => { mounted = false }
  }, [active, reloadKey])

  function change(next: StrategyList[]) { setLists(next); setDirty(true); setNotice(''); setError('') }
  function editList(index: number, update: Partial<StrategyList>) { change(lists.map((list, i) => i === index ? { ...list, ...update } : list)) }
  function editEntry(listIndex: number, entryIndex: number, update: Partial<Strategy>) {
    editList(listIndex, { entries: lists[listIndex].entries.map((entry, i) => i === entryIndex ? { ...entry, ...update } : entry) })
  }
  async function save() {
    setBusy(true); setError(''); setNotice('')
    try {
      const value = await apiCall<Catalog>('POST', 'nfqws2/strategies', { revision, lists })
      if (!value.success) throw new Error(value.error || 'Не удалось сохранить списки')
      setLists(value.lists); setRevision(value.revision); setDirty(false)
      setNotice('Списки сохранены. Следующий подбор использует включённые списки.')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Ошибка сохранения') }
    finally { setBusy(false) }
  }
  async function importLists(selected?: File) {
    if (!selected) return
    setError(''); setNotice('')
    try {
      if (selected.size > 1024 * 1024) throw new Error('Файл должен быть не больше 1 МБ')
      const value = JSON.parse(await selected.text())
      const incoming = Array.isArray(value) ? value : value.lists || (Array.isArray(value.entries) ? [{ name: selected.name.replace(/\.json$/i, ''), entries: value.entries }] : null)
      if (!Array.isArray(incoming)) throw new Error('Нужен JSON со списками или объект с entries: [{name, args}]')
      const added: StrategyList[] = incoming.map(item => {
        if (!item || typeof item.name !== 'string' || !Array.isArray(item.entries)) throw new Error('У каждого списка нужны name и entries')
        return { id: newId(), name: item.name, enabled: item.enabled !== false, entries: item.entries.map((entry: Strategy) => {
          if (!entry || typeof entry.name !== 'string' || typeof entry.args !== 'string') throw new Error('У каждой стратегии нужны name и args')
          return { id: newId(), name: entry.name, args: entry.args }
        }) }
      })
      if (lists.length + added.length > 16 || [...lists, ...added].reduce((sum, list) => sum + list.entries.length, 0) > 256) throw new Error('Лимит: 16 списков и 256 стратегий')
      change([...lists, ...added]); if (added[0]) setReveal({ id: added[0].id, kind: 'list' }); setNotice('Списки добавлены в черновик. Нажмите «Сохранить списки».')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Ошибка импорта JSON') }
    if (file.current) file.current.value = ''
  }
  function exportLists() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ lists }, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = 'nfqws2-strategy-lists.json'; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return <div className="flex min-h-0 flex-col gap-3">

        {readOnly && <p role="status" className="rounded-lg border border-sky-500/25 bg-sky-500/10 px-3 py-2 text-sm text-sky-300">Идёт проверка: списки доступны для просмотра и экспорта. Изменение и сохранение станут доступны после её завершения.</p>}
        <div className="flex flex-wrap items-center gap-2"><SettingInfo label="Списки стратегий">Подбор использует включённые списки. Сохранение списка не меняет активную стратегию. Параметры — по одному в строке; блоки разделяются --new. Нужен TCP/443, QUIC/443 необязателен.</SettingInfo>
          <Button size="sm" variant="outline" disabled={busy || readOnly || !loaded || lists.length >= 16} onClick={addList}><IconPlus className="size-4" />Добавить список</Button>
          <Button size="sm" variant="outline" disabled={busy || readOnly || !loaded} onClick={() => file.current?.click()}><IconUpload className="size-4" />Импорт JSON</Button>
          <Button size="sm" variant="ghost" disabled={busy || !loaded} onClick={exportLists}><IconDownload className="size-4" />Экспорт</Button>
          <input type="file" accept=".json,application/json" ref={file} className="hidden" onChange={event => void importLists(event.target.files?.[0])} />
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-2">
          {busy && !loaded && <p className="text-muted-foreground text-sm">Загрузка списков…</p>}
          {loaded && lists.length === 0 && <p className="text-muted-foreground rounded-xl border border-dashed p-6 text-center text-sm">Добавьте список или импортируйте JSON.</p>}
          {lists.map((list, listIndex) => <section key={list.id} ref={element => { if (element) listElements.current.set(list.id, element); else listElements.current.delete(list.id) }} className="scroll-mt-2 space-y-3 rounded-xl border border-border bg-background/40 p-3">
            <div className="flex items-center gap-3">
              <Checkbox aria-label={`Использовать список ${list.name}`} disabled={busy || readOnly} checked={list.enabled} onCheckedChange={value => editList(listIndex, { enabled: value === true })} />
              <Input aria-label="Название списка" className="font-semibold" maxLength={120} disabled={busy} readOnly={readOnly} value={list.name} onChange={event => editList(listIndex, { name: event.target.value })} />
              <span className="text-muted-foreground shrink-0 text-xs">{list.entries.length} стратегий</span>
              <Button size="icon" variant="ghost" disabled={busy || readOnly} aria-label={`Удалить список ${list.name}`} onClick={() => change(lists.filter((_, i) => i !== listIndex))}><IconTrash className="size-4" /></Button>
            </div>
            <Button variant="outline" size="sm" disabled={busy || readOnly || lists.reduce((sum, item) => sum + item.entries.length, 0) >= 256} onClick={() => addEntry(listIndex)}><IconPlus className="size-4" />Добавить стратегию</Button>
            <div className="space-y-3">
              {list.entries.map((entry, entryIndex) => <details key={entry.id} ref={element => { if (element) entryElements.current.set(entry.id, element); else entryElements.current.delete(entry.id) }} className="scroll-mt-2 rounded-lg border border-border/70 bg-background/30 p-2.5">
                <summary className="cursor-pointer text-sm font-medium">{entry.name || 'Без названия'}</summary>
                <div className="mt-3 space-y-3">
                  <div className="flex gap-2"><Input aria-label="Название стратегии" maxLength={180} disabled={busy} readOnly={readOnly} value={entry.name} onChange={event => editEntry(listIndex, entryIndex, { name: event.target.value })} /><Button size="icon" variant="ghost" disabled={busy || readOnly} aria-label={`Удалить стратегию ${entry.name}`} onClick={() => editList(listIndex, { entries: list.entries.filter((_, i) => i !== entryIndex) })}><IconTrash className="size-4" /></Button></div>
                  <Textarea aria-label={`Параметры ${entry.name}`} className="min-h-44 font-mono text-xs" spellCheck={false} disabled={busy} readOnly={readOnly} value={entry.args} onChange={event => editEntry(listIndex, entryIndex, { args: event.target.value })} placeholder={'--filter-tcp=443\n--payload=tls_client_hello\n--lua-desync=…'} />
                </div>
              </details>)}
            </div>
          </section>)}
        </div>

        {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
        {notice && <p role="status" className="text-emerald-400 text-sm">{notice}</p>}
        <div className="bg-card sticky bottom-0 flex flex-wrap justify-end gap-2 border-t py-2"><Button variant="outline" disabled={busy || !dirty} onClick={() => { setLoaded(false); setReloadKey(value => value + 1) }}>Отменить изменения</Button><Button disabled={busy || !loaded || !dirty || readOnly} onClick={() => void save()}>{busy && loaded ? 'Сохранение…' : 'Сохранить списки'}</Button></div>
  </div>
}

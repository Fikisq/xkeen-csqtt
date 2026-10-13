import { useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

interface Connection {tag: string; label: string; details: string}
export function ConnectionPicker({open, onOpenChange, connections, shown, limit, activeTag, onToggle, latencies, pingPending, ping}: {
  open: boolean; onOpenChange: (open: boolean) => void; connections: Connection[]; shown: string[]; limit: number; activeTag?: string
  onToggle: (tag: string) => void; latencies: Record<string, {ms?: number; error?: string}>; pingPending: string | null; ping: (tag: string) => Promise<void>
}) {
  const [search, setSearch] = useState(''), [page, setPage] = useState(0), [automatic, setAutomatic] = useState(true), [refresh, setRefresh] = useState(0), [busy, setBusy] = useState(false)
  const latest = useRef({ping, latencies}); latest.current = {ping, latencies}
  const handledRefresh = useRef(0)
  const filtered = connections.filter(item => `${item.label} ${item.details}`.toLowerCase().includes(search.toLowerCase()))
  const pages = Math.max(1, Math.ceil(filtered.length / 20))
  const rows = filtered.slice(Math.min(page, pages - 1) * 20, (Math.min(page, pages - 1) + 1) * 20)
  const rowKey = rows.map(row => row.tag).join('|')
  useEffect(() => {
    const force = refresh !== handledRefresh.current
    handledRefresh.current = refresh
    if (!open || !automatic && !force) return
    let cancelled = false; setBusy(true)
    void (async () => {
      for (const row of rows) { if (cancelled) break; if (force || !latest.current.latencies[row.tag]) await latest.current.ping(row.tag) }
      if (!cancelled) setBusy(false)
    })()
    return () => { cancelled = true; setBusy(false) }
  }, [open, automatic, rowKey, refresh])
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="flex! max-h-[92dvh] max-w-[min(96vw,1000px)]! flex-col overflow-hidden">
    <DialogHeader className="shrink-0"><DialogTitle>Все подключения</DialogTitle></DialogHeader>
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center gap-3"><Input className="min-w-40 flex-1" value={search} onChange={event => { setSearch(event.target.value); setPage(0) }} placeholder="Название, протокол, транспорт…" /><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={automatic} onChange={event => setAutomatic(event.target.checked)} />Автопинг</label><Button variant="outline" disabled={busy || pingPending !== null} onClick={() => setRefresh(value => value + 1)}>Пинг списка</Button></div>
      <p className="text-muted-foreground shrink-0 text-sm">Выберите до {limit} карточек для трёх рядов. Активное подключение всегда видно. Автопинг проверяет текущую страницу последовательно.</p>
      <div className="min-h-0 overflow-auto rounded-md border"><table className="w-full text-left text-sm"><thead className="bg-card sticky top-0"><tr>{['Карточка', 'Подключение', 'Протокол / транспорт', 'Пинг'].map(title => <th className="p-2" key={title}>{title}</th>)}</tr></thead><tbody>{rows.map(row => <tr className="border-t" key={row.tag}><td className="p-2"><input type="checkbox" aria-label={`Показывать ${row.label}`} checked={shown.includes(row.tag)} disabled={row.tag === activeTag || !shown.includes(row.tag) && shown.length >= limit} onChange={() => onToggle(row.tag)} /></td><td className="p-2 break-words">{row.label}{row.tag === activeTag && <span className="text-muted-foreground ml-2 text-xs">Выбрано</span>}</td><td className="p-2 break-words text-muted-foreground">{row.details}</td><td className="p-2"><Button size="sm" variant="outline" disabled={pingPending !== null} onClick={() => void ping(row.tag)} title={latencies[row.tag]?.error}>{pingPending === row.tag ? '…' : latencies[row.tag]?.ms !== undefined ? `${latencies[row.tag].ms} мс` : latencies[row.tag]?.error ? '✕' : 'Пинг'}</Button></td></tr>)}</tbody></table>{!rows.length && <p className="text-muted-foreground p-3">Подключения не найдены.</p>}</div>
      <div className="flex shrink-0 items-center justify-between gap-2 text-sm"><span>{filtered.length} подключений · {busy ? 'Проверка…' : `Карточек: ${shown.length}/${limit}`}</span><div className="flex items-center gap-2"><Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(value => value - 1)}>Назад</Button><span>{Math.min(page, pages - 1) + 1}/{pages}</span><Button size="sm" variant="outline" disabled={page >= pages - 1} onClick={() => setPage(value => value + 1)}>Далее</Button></div></div>
    </div>
  </DialogContent></Dialog>
}

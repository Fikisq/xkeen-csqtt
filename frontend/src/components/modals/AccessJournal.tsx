import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'

type AccessEvent = {
  time: string
  source: string
  result: string
  ip: string
  external: boolean
}

export function AccessJournal() {
  const [events, setEvents] = useState<AccessEvent[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function refresh() {
    setLoading(true)
    try {
      const response = await fetch('/api/access-journal')
      const data = await response.json() as { events?: AccessEvent[]; error?: string }
      if (!response.ok) throw new Error(data.error || 'Не удалось загрузить журнал')
      setEvents(data.events ?? [])
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось загрузить журнал')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void refresh() }, [])

  return <div className="space-y-3 py-3">
    <div className="flex items-start justify-between gap-3">
      <div>
        <p className="font-medium">Входы в веб-панель и SSH</p>
        <p className="text-muted-foreground text-xs">Внешний IP означает адрес источника вне локальной сети. SSH берётся из текущего системного журнала Keenetic; старые записи могут исчезнуть.</p>
      </div>
      <Button variant="outline" size="sm" disabled={loading} onClick={() => void refresh()}>Обновить</Button>
    </div>
    {error && <p className="text-destructive text-sm">{error}</p>}
    {!error && events.length === 0 && <p className="text-muted-foreground text-sm">Записей пока нет.</p>}
    <div className="space-y-2">
      {events.map((event, index) => <div key={`${event.source}-${event.time}-${event.ip}-${index}`} className="bg-card flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm">
        <div>
          <span className="font-medium">{event.source}</span> · {event.result}
          <div className="text-muted-foreground text-xs">{event.time} · {event.ip}</div>
        </div>
        {event.external && <span className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-600 dark:text-amber-400">Внешний IP</span>}
      </div>)}
    </div>
  </div>
}

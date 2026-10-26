import { IconDevices, IconLayersIntersect, IconPlus, IconTrash, IconActivity } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

export function DeviceSidebar({ devices, selected, onSelect, onRemove, onAdd, onDiagnostics, disabled, children }: {
  devices: string[]; selected: string; onSelect: (ip: string) => void; onRemove: (ip: string) => void
  onAdd?: () => void; onDiagnostics?: () => void; disabled?: boolean; children?: ReactNode
}) {
  return <aside className="routing-devices border-border bg-input-background flex min-w-0 flex-wrap items-center gap-1 rounded-xl border p-2 lg:flex-col lg:items-stretch lg:self-start">
    <h3 className="mb-1 w-full text-ui-section font-medium">Устройства</h3>
    <Button size="sm" variant={!selected ? 'default' : 'outline'} className="h-auto min-h-9 justify-start whitespace-normal text-left" disabled={disabled} onClick={() => onSelect('')}><IconLayersIntersect size={16} />Общая маршрутизация</Button>
    {devices.map(ip => <div key={ip} className={cn('group flex min-w-0 items-center gap-1 rounded-lg pr-2', selected === ip && 'bg-primary/15')}>
      <button type="button" disabled={disabled} aria-pressed={selected === ip} className="flex min-h-9 min-w-0 flex-1 items-center gap-1 px-1 text-left text-ui font-normal tabular-nums disabled:opacity-50" onClick={() => onSelect(ip)}><IconDevices size={14} className="text-muted-foreground shrink-0" /><span>{ip}</span></button>
      <Button size="icon-xs" variant="ghost" disabled={disabled} aria-label={`Удалить отдельные правила ${ip}`} onClick={() => onRemove(ip)}><IconTrash size={13} /></Button>
    </div>)}
    {onAdd && <Button size="sm" variant="outline" className="mt-2 justify-start" disabled={disabled} onClick={onAdd}><IconPlus size={15} />Добавить IP</Button>}
    {onDiagnostics && <Button size="sm" variant="outline" className="justify-start" onClick={onDiagnostics}><IconActivity size={15} />Диагностика</Button>}
    {children}
  </aside>
}

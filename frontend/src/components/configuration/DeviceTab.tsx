import { IconX } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function DeviceTab({ ip, selected, disabled, onSelect, onRemove }: {
  ip: string; selected: boolean; disabled: boolean; onSelect: () => void; onRemove: () => void
}) {
  return <div className="group relative">
    <Button size="sm" variant={selected ? 'default' : 'outline'} className="pr-7" onClick={onSelect}>{ip}</Button>
    <button type="button" disabled={disabled} aria-label={`Удалить профиль ${ip}`} title={`Удалить профиль ${ip}`}
      className={cn('absolute top-0.5 right-0.5 flex size-5 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-red-500/20 hover:text-red-400 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-40', selected && 'text-white opacity-100')}
      onClick={onRemove}><IconX size={13} /></button>
  </div>
}

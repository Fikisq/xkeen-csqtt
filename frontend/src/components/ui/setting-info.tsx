import type { ReactNode } from 'react'
import { IconInfoCircle } from '@tabler/icons-react'
import { Popover, PopoverContent, PopoverTrigger } from './popover'

export function SettingInfo({ label, children }: { label: string; children: ReactNode }) {
  return <Popover>
    <PopoverTrigger type="button" aria-label={`О настройке «${label}»`} className="text-muted-foreground hover:text-chart-2 focus-visible:ring-ring ml-1 inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full align-middle outline-none focus-visible:ring-2">
      <IconInfoCircle className="size-3.5" />
    </PopoverTrigger>
    <PopoverContent align="start" sideOffset={6} className="max-w-[calc(100vw-2rem)] gap-1.5 text-xs leading-relaxed">
      <p className="font-semibold">{label}</p>
      <div className="text-muted-foreground font-normal">{children}</div>
    </PopoverContent>
  </Popover>
}

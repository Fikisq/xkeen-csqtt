import type { ReactNode } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export function UtilityPanel({ embedded, open, onOpenChange, title, description, children }: {
  embedded?: boolean; open: boolean; onOpenChange: (open: boolean) => void
  title: ReactNode; description: ReactNode; children: ReactNode
}) {
  if (embedded) return <section className="flex min-h-128 flex-col gap-4 p-4 sm:p-5">
    <header className="space-y-2"><h2 className="flex items-center gap-2 text-lg font-semibold">{title}</h2><p className="text-muted-foreground text-sm">{description}</p></header>
    {children}
  </section>
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="flex max-h-[90dvh] flex-col gap-4 overflow-y-auto sm:max-w-2xl">
    <DialogHeader><DialogTitle className="flex items-center gap-2">{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
    {children}
  </DialogContent></Dialog>
}

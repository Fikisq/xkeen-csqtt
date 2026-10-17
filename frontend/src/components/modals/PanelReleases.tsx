import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { apiCall } from '@/lib/api'
import { isNewStableRelease, type PanelReleasesResponse } from '@/lib/panelReleases'

export function PanelReleases({ open, onClose, version }: { open: boolean; onClose: () => void; version: string }) {
  const [data, setData] = useState<PanelReleasesResponse | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  async function load(refresh = false) {
    setLoading(true); setError('')
    try {
      const result = await apiCall<PanelReleasesResponse>('GET', `panel/releases${refresh ? '?refresh=true' : ''}`)
      if (!result.success) throw new Error(result.error || 'Не удалось загрузить релизы')
      setData(result)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось загрузить релизы') }
    finally { setLoading(false) }
  }
  useEffect(() => { if (open) void load() }, [open])
  const current = data?.currentVersion || version
  return <Dialog open={open} onOpenChange={value => { if (!value) onClose() }}>
    <DialogContent className="flex max-h-[90dvh] max-w-[min(94vw,720px)]! flex-col gap-3 overflow-hidden">
      <DialogHeader><DialogTitle>Версии панели</DialogTitle></DialogHeader>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 text-sm">
        <span className="text-muted-foreground">Установлена: v{current.replace(/^v/, '')}</span>
        <Button variant="outline" size="sm" disabled={loading} onClick={() => void load(true)}>{loading ? 'Загрузка…' : 'Проверить'}</Button>
      </div>
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      {data?.stale && <p className="text-sm text-amber-500">GitHub недоступен. Показан сохранённый список.</p>}
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {!data && loading && <p className="text-muted-foreground py-6 text-sm">Загрузка релизов…</p>}
        {data && data.releases.length === 0 && <p className="text-muted-foreground py-6 text-sm">Опубликованных релизов пока нет.</p>}
        <Accordion type="single" collapsible className="space-y-2">
          {data?.releases.map(release => <AccordionItem key={release.tag} value={release.tag} className="border-border rounded-lg border px-3">
            <AccordionTrigger className="py-3 text-left">
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <span>{release.tag}</span>
                <span className={release.prerelease ? 'text-xs text-amber-500' : 'text-xs text-emerald-500'}>{release.prerelease ? 'Предварительный' : 'Стабильный'}</span>
                {release.tag.replace(/^v/, '') === current.replace(/^v/, '') && <span className="text-muted-foreground text-xs">Установлен</span>}
                {isNewStableRelease(release, current) && <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-500">NEW</span>}
                {release.publishedAt && <span className="text-muted-foreground text-xs">{new Date(release.publishedAt).toLocaleDateString('ru-RU')}</span>}
              </span>
            </AccordionTrigger>
            <AccordionContent>
              <div className="text-muted-foreground space-y-2 break-words text-sm [&_a]:text-blue-400 [&_a]:underline [&_h1]:font-semibold [&_h2]:font-semibold [&_li]:ml-4 [&_pre]:overflow-x-auto [&_ul]:list-disc">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> }}>{release.body || 'Описание изменений не добавлено.'}</ReactMarkdown>
              </div>
              <a className="mt-3 inline-block text-sm text-blue-400 underline" href={release.url} target="_blank" rel="noopener noreferrer">Открыть релиз на GitHub</a>
            </AccordionContent>
          </AccordionItem>)}
        </Accordion>
      </div>
      <div className="flex shrink-0 justify-end border-t pt-3"><Button variant="outline" onClick={onClose}>Закрыть</Button></div>
    </DialogContent>
  </Dialog>
}

import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { IconDownload, IconRefresh } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { apiCall } from '@/lib/api'
import { useAppContext } from '@/lib/store'
import { cn } from '@/lib/utils'
import { releaseMarkdownClass } from '@/lib/releaseMarkdown'
import { isNewStableRelease, type PanelReleasesResponse } from '@/lib/panelReleases'

type UpdateState = { id: string; targetVersion: string; phase: string; message: string }
const normalized = (value: string) => value.replace(/^v/, '')
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export function PanelReleases({ open, onClose, version }: { open: boolean; onClose: () => void; version: string }) {
  const { showToast } = useAppContext()
  const [data, setData] = useState<PanelReleasesResponse | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [message, setMessage] = useState('')
  const [selected, setSelected] = useState('')
  const [expanded, setExpanded] = useState('')
  const mounted = useRef(true)
  const polling = useRef(false)
  const current = data?.currentVersion || version
  const release = data?.releases.find(item => item.tag === selected)

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  async function poll(jobId: string, target: string) {
    if (polling.current) return
    polling.current = true
    const deadline = Date.now() + 180_000
    let attempts = 0
    try {
      while (mounted.current && Date.now() < deadline) {
        await wait(1500)
        attempts++
        try {
          const response = await fetch('/api/panel/update/status', { cache: 'no-store', signal: AbortSignal.timeout(5000) })
          if (response.ok) {
            const result = await response.json() as { update: UpdateState | null }
            const update = result.update
            if (update?.id !== jobId) continue
            setMessage(update.message)
            if (update.phase === 'installed') {
              showToast(`Установлена панель v${normalized(target)}`)
              window.location.reload()
              return
            }
            if (update.phase === 'rolled_back' || update.phase === 'error') throw new Error(update.message)
          } else if (response.status === 404 && attempts >= 10) {
            // Older releases do not have the status endpoint. Their version API
            // still allows the page to reconnect after a deliberate downgrade.
            const response = await fetch('/api/version', { cache: 'no-store', signal: AbortSignal.timeout(5000) })
            if (response.ok) {
              const info = await response.json()
              if (normalized(info['xkeen-ui']?.version || '') === normalized(target)) {
                window.location.reload()
                return
              }
              throw new Error('Панель отвечает с прежней версией. Возможно, выполнен автоматический откат.')
            }
          } else if (response.status === 401) {
            window.location.reload()
            return
          }
        } catch (cause) {
          // Network errors are expected while the panel restarts. Explicit
          // installation/rollback failures must be shown instead of retried.
          if (cause instanceof Error && cause.name !== 'TypeError' && cause.name !== 'TimeoutError' && cause.name !== 'AbortError') throw cause
        }
      }
      if (mounted.current) throw new Error('Не удалось подтвердить запуск панели. Обновите страницу и проверьте версию.')
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Не удалось завершить установку')
    } finally {
      polling.current = false
      if (mounted.current) setInstalling(false)
    }
  }

  async function load(refresh = false) {
    setLoading(true); setError('')
    try {
      const result = await apiCall<PanelReleasesResponse>('GET', `panel/releases${refresh ? '?refresh=true' : ''}`)
      if (!result.success) throw new Error(result.error || 'Не удалось загрузить релизы')
      if (!mounted.current) return
      setData(result)
      const initial = result.releases.find(item => item.installable) || result.releases[0]
      setSelected(initial?.tag || '')
      setExpanded(initial?.tag || '')
      const status = await apiCall<{ update: UpdateState | null }>('GET', 'panel/update/status').catch(() => null)
      if (status?.update && ['downloading', 'restarting'].includes(status.update.phase)) {
        setInstalling(true); setMessage(status.update.message)
        void poll(status.update.id, status.update.targetVersion)
      }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить релизы') }
    finally { if (mounted.current) setLoading(false) }
  }
  useEffect(() => { if (open) void load() }, [open])

  async function install() {
    if (!release?.installable || installing) return
    setInstalling(true); setError(''); setMessage('Загрузка и проверка выбранной версии…')
    try {
      const response = await fetch('/api/panel/update', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: release.tag }), signal: AbortSignal.timeout(300_000) })
      const result = await response.json() as { success: boolean; jobId?: string; targetVersion?: string; error?: string }
      if (!result.success || !result.jobId) throw new Error(result.error || 'Не удалось начать установку')
      setMessage('Установка и перезапуск панели…')
      await poll(result.jobId, result.targetVersion || release.tag)
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : 'Связь с панелью прервалась. Обновите страницу и проверьте версию.')
        setInstalling(false)
      }
    }
  }

  return <Dialog open={open} onOpenChange={value => { if (!value && !installing) onClose() }}>
    <DialogContent className="w-full max-w-[95vw]! p-0! md:w-187.5" showCloseButton={!installing}>
      <div className="flex max-h-[90dvh] flex-col gap-4 overflow-hidden p-6">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2 pr-8 pb-3"><IconDownload size={24} className="text-chart-2" />Обновление панели</DialogTitle>
          <DialogDescription className="flex w-full items-center justify-between" render={<div>
            Выберите версию для установки
            <span className="flex items-center gap-1.5">
              {data && <Badge variant="outline" className="h-5 rounded-full border-none bg-green-500/10 px-2 text-xs font-medium text-green-400">GitHub</Badge>}
              {!!data?.releases.length && <Badge variant="outline" className="h-6 w-6 rounded-full border-blue-500/20 bg-blue-500/10 text-blue-400">{data.releases.length}</Badge>}
            </span>
          </div>} />
        </DialogHeader>
        <div className="text-muted-foreground flex shrink-0 items-center justify-between text-xs">
          <span>Установлена: v{normalized(current)}</span>
          <Button variant="ghost" size="sm" disabled={loading || installing} onClick={() => void load(true)}><IconRefresh size={14} />Проверить</Button>
        </div>
        {error && <p role="alert" className="shrink-0 text-sm text-red-400">{error}</p>}
        {data?.stale && <p className="shrink-0 text-xs text-amber-500">GitHub недоступен. Показан сохранённый список.</p>}
        <ScrollArea className="min-h-0 shrink-0" hideScrollbar style={{ maxHeight: 'min(calc(70px * 7 + 8px), calc(90dvh - 240px))' }}>
          {loading && !data ? <div className="text-muted-foreground flex min-h-64 flex-col items-center justify-center gap-3 py-12"><Spinner className="text-chart-2 size-10" />Загрузка релизов…</div>
            : !data?.releases.length ? <p className="text-muted-foreground py-12 text-center">Нет доступных релизов</p>
            : <Accordion type="single" collapsible value={expanded} onValueChange={setExpanded} className="flex flex-col gap-1.5 px-0.5 py-1">
              {data.releases.map(item => {
                const checked = selected === item.tag
                return <AccordionItem key={item.tag} value={item.tag} className={cn('rounded-lg border transition-all', checked
                  ? 'border-[#60a5fa] bg-linear-to-b from-blue-500/25 to-blue-500/15'
                  : 'border-ring/40 bg-[linear-gradient(135deg,rgba(59,130,246,0.05)_0%,transparent_50%)] hover:border-[#60a5fa] hover:bg-linear-to-b hover:from-blue-500/15 hover:to-blue-500/5')}>
                  <AccordionTrigger disabled={installing} className="min-w-0 overflow-hidden px-3 py-0 hover:no-underline *:data-[slot=accordion-trigger-icon]:hidden" onClick={() => setSelected(item.tag)}>
                    <div className="flex w-full min-w-0 items-center justify-between gap-3 py-2.5">
                      <div className="flex min-w-0 flex-1 flex-col gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-medium">{item.name || item.tag}</span>
                          {item.prerelease && <Badge variant="outline" className="rounded-sm border-none bg-amber-500/10 px-2 text-xs text-amber-400">Pre-Release</Badge>}
                          {normalized(item.tag) === normalized(current) && <span className="text-muted-foreground text-xs">Установлена</span>}
                          {isNewStableRelease(item, current) && <Badge variant="outline" className="rounded-sm border-none bg-amber-500/10 px-2 text-xs text-amber-400">NEW</Badge>}
                        </div>
                        <span className="text-muted-foreground text-xs">{item.publishedAt?.split('T')[0] || 'Дата не указана'}</span>
                      </div>
                      <span className={cn('flex size-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors', checked ? 'border-primary bg-primary' : 'border-muted-foreground/50')}>
                        {checked && <span className="bg-primary-foreground size-2 rounded-full" />}
                      </span>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="px-3 pt-0 pb-3"><div className="border-ring/20 border-t pt-2.5">
                    <div className="max-h-48 w-full overflow-x-hidden overflow-y-auto scrollbar-thin"><div className={cn(releaseMarkdownClass, 'min-w-0')}>
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: () => null, a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> }}>{item.body || 'Описание изменений не добавлено.'}</ReactMarkdown>
                    </div></div>
                    <a className="mt-2 inline-block text-xs text-blue-400 underline" href={item.url} target="_blank" rel="noopener noreferrer">Открыть релиз на GitHub</a>
                    {!item.installable && <p className="mt-2 text-xs text-amber-500">В релизе нет файла панели или контрольных сумм для этой архитектуры.</p>}
                  </div></AccordionContent>
                </AccordionItem>
              })}
            </Accordion>}
        </ScrollArea>
        <DialogFooter className="shrink-0 flex-col! gap-2">
          {installing && <p role="status" className="text-muted-foreground flex items-center justify-center gap-2 text-xs"><Spinner />{message}</p>}
          <Button onClick={() => void install()} disabled={!release?.installable || installing || loading} className="w-full">{installing ? 'Установка…' : 'Установить'}</Button>
        </DialogFooter>
      </div>
    </DialogContent>
  </Dialog>
}

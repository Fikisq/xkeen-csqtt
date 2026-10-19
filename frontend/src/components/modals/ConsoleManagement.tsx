import { useState } from 'react'
import { IconPlayerPlay, IconPlayerStop, IconRefresh, IconFileText, IconDownload } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'

export function ConsoleManagement({ connected, onAction }: { connected: boolean; onAction: (action: string, component: string) => void }) {
  const [component, setComponent] = useState('panel')
  const run = (action: string) => onAction(action, component)
  return <aside className="flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto rounded-lg border bg-background/30 p-3">
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-sm font-medium">Управление</h3>
    </div>
    <label className="text-muted-foreground text-xs">Компонент
      <select aria-label="Компонент для управления" className="mt-1 h-8 w-full rounded-md border border-border bg-input-background px-2 text-sm text-foreground" value={component} disabled={!connected} onChange={event => setComponent(event.target.value)}>
        <option value="panel">Панель</option><option value="xray">Xray</option><option value="csqtt">CSQTT</option><option value="wdtt-plus">WDTT Plus</option><option value="nfqws2">nfqws2</option>
      </select>
    </label>
    <div className="grid grid-cols-2 gap-2">
      <Button size="sm" className="min-w-0 px-2 text-xs" variant="outline" disabled={!connected} onClick={() => run('start')}><IconPlayerPlay className="size-3.5" />Запустить</Button>
      <Button size="sm" className="min-w-0 px-2 text-xs" variant="outline" disabled={!connected} onClick={() => run('stop')}><IconPlayerStop className="size-3.5" />Остановить</Button>
      <Button size="sm" className="min-w-0 px-2 text-xs" variant="outline" disabled={!connected} onClick={() => run('restart')}><IconRefresh className="size-3.5" />Перезапуск</Button>
      <Button size="sm" className="min-w-0 px-2 text-xs" variant="outline" disabled={!connected} onClick={() => run('log')}><IconFileText className="size-3.5" />Журнал</Button>
    </div>
    <Button size="sm" className="text-xs" variant="outline" disabled={!connected} onClick={() => run('status')}>Статус выбранного компонента</Button>
    <Button size="sm" className="text-xs" variant="outline" disabled={!connected} onClick={() => run('status-all')}>Статус всех компонентов</Button>
    <Button size="sm" className="text-xs" variant="outline" disabled={!connected} onClick={() => run('update')}><IconDownload className="size-3.5" />Обновить панель</Button>
    <p className="text-muted-foreground text-[11px]">Вывод — в консоли. Для выхода из журнала нажмите «Прервать операцию» или Ctrl+C.</p>
  </aside>
}

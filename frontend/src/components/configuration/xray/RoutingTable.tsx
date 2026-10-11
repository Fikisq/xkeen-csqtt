import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { IconPencil, IconTrash, IconPlus, IconGripVertical, IconFolder } from '@tabler/icons-react'
import { useRef, useState, type ReactNode } from 'react'
import { GeoDatabasePicker } from '@/components/configuration/GeoDatabasePicker'
import { resourceLabel } from '@/lib/geoLabels'

function ResourceField({ label, resources, onChange, onPicker, placeholder }: {
  label: string; resources: string[]; onChange: (resources: string[]) => void; onPicker: () => void; placeholder: string
}) {
  return <div className="space-y-2">
    <div className="flex items-center justify-between gap-2"><span className="text-muted-foreground text-base">{label}</span><Button size="sm" variant="outline" onClick={onPicker}><IconFolder size={17} /> Выбрать из базы</Button></div>
    <div className="flex flex-wrap gap-1.5">{resources.map(value => <span key={value} title={value} className="flex items-center rounded-md border border-blue-400/50 bg-blue-500/15 text-sm"><span className="px-2 py-1">{resourceLabel(value)}</span><button type="button" className="rounded-r-md px-2 py-1 hover:bg-red-500/20" aria-label={`Убрать ${resourceLabel(value)}`} onClick={() => onChange(resources.filter(item => item !== value))}>×</button></span>)}</div>
    <details className="text-sm"><summary className="text-muted-foreground cursor-pointer">Ввести вручную</summary><Input className="mt-2 text-base" value={resources.join(', ')} placeholder={placeholder} onChange={event => onChange(event.target.value.split(',').map(value => value.trim()).filter(Boolean))} /></details>
  </div>
}

// Типы для правила маршрутизации в стиле 3x-ui
export interface RoutingRule {
  id: string
  enabled: boolean
  description: string
  network: 'tcp' | 'udp' | 'tcp,udp' | ''
  inboundTag: string[]
  outboundTag: string
  domain: string[]
  ip: string[]
  port: string
  sourcePort: string
  sourceIP: string[]
}

interface RoutingTableProps {
  rules: RoutingRule[]
  outbounds: Array<{ tag: string; protocol: string; label?: string }>
  inbounds: Array<{ tag: string }>
  onAddRule: (rule: RoutingRule) => void
  onEditRule: (id: string, rule: RoutingRule) => void
  onDeleteRule: (id: string) => void
  onReorder: (fromIndex: number, toIndex: number) => void
  onToggleEnabled: (id: string) => void
  deviceMode?: boolean
  canDelete?: (rule: RoutingRule) => boolean
  canReorder?: (rule: RoutingRule) => boolean
  canToggle?: (rule: RoutingRule) => boolean
  toolbarAction?: ReactNode
  disabled?: boolean
  latencies?: Record<string, { ms?: number; error?: string }>
  onPing?: (tag: string) => void
  pingPending?: string | null
  showTitle?: boolean
  onImportFile?: (file: File) => Promise<void>
  onExportRules?: () => void
}

export function RoutingTable({
  rules,
  outbounds,
  onAddRule,
  onEditRule,
  onDeleteRule,
  onReorder,
  onToggleEnabled,
  deviceMode = false,
  canDelete = () => true,
  canReorder = () => true,
  canToggle = () => true,
  toolbarAction,
  disabled = false,
  latencies = {},
  onPing,
  pingPending = null,
  showTitle = true,
  onImportFile,
  onExportRules,
}: RoutingTableProps) {
  const [editingRule, setEditingRule] = useState<RoutingRule | null>(null)
  const [isAddingNew, setIsAddingNew] = useState(false)
  const [showDomainPicker, setShowDomainPicker] = useState(false)
  const [showIpPicker, setShowIpPicker] = useState(false)
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)
  const importInput = useRef<HTMLInputElement>(null)

  const emptyRule: RoutingRule = {
    id: '',
    enabled: true,
    description: '',
    network: '',
    inboundTag: [],
    outboundTag: '',
    domain: [],
    ip: [],
    port: '',
    sourcePort: '',
    sourceIP: []
  }

  const openAddDialog = () => {
    setEditingRule({ ...emptyRule, id: `new-${Date.now()}` })
    setIsAddingNew(true)
  }

  const openEditDialog = (rule: RoutingRule) => {
    setEditingRule({ ...rule })
    setIsAddingNew(false)
  }

  const closeDialog = () => {
    setEditingRule(null)
    setIsAddingNew(false)
  }

  const saveRule = () => {
    if (!editingRule || disabled) return
    if (isAddingNew && (!editingRule.description.trim() || (!editingRule.domain.length && !editingRule.ip.length) || !editingRule.outboundTag)) return

    if (isAddingNew) {
      onAddRule(editingRule)
    } else {
      onEditRule(editingRule.id, editingRule)
    }
    closeDialog()
  }

  const updateEditingRule = (updates: Partial<RoutingRule>) => {
    if (!editingRule) return
    setEditingRule({ ...editingRule, ...updates })
  }

  const addRuleButton = <Button onClick={openAddDialog} size="sm">
    <IconPlus data-icon="inline-start" />
    Добавить правило
  </Button>

  return (
    <div className="space-y-4 text-foreground">
      {/* Заголовок и кнопка добавления */}
      <div className="flex flex-wrap items-center gap-2">
        {!deviceMode && showTitle && <h3 className="text-lg font-semibold">Маршрутизация</h3>}
        {!disabled && addRuleButton}
        {onImportFile && <>
          <input ref={importInput} type="file" accept=".json,application/json" className="hidden" aria-label="Файл правил для импорта" onChange={event => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) void onImportFile(file)
          }} />
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => importInput.current?.click()}>Импорт</Button>
        </>}
        {onExportRules && <Button size="sm" variant="outline" onClick={onExportRules}>Экспорт</Button>}
        <div className="ml-auto flex flex-wrap items-center gap-2">{toolbarAction}</div>
      </div>

      {/* Таблица правил */}
      <div className={cn('border-border bg-card overflow-x-auto rounded-xl border', disabled && 'opacity-45')} aria-disabled={disabled}>
        <table className="w-full min-w-[980px] table-fixed text-base">
          <thead className="bg-input-background border-border border-b">
            <tr>
              <th className="w-14 px-3 py-3 text-left font-medium">#</th>
              <th className="w-22 px-3 py-3 text-left font-medium">Действия</th>
              <th className="w-24 px-3 py-3 text-left font-medium">Включить</th>
              <th className="w-40 px-3 py-3 text-left font-medium">Комментарий</th>
              <th className="w-24 px-3 py-3 text-left font-medium">Сеть</th>
              <th className="px-3 py-3 text-left font-medium">Пункт назначения</th>
              {!deviceMode && <th className="w-28 px-3 py-3 text-left font-medium">Входящие</th>}
              <th className="w-52 px-3 py-3 text-left font-medium">Исходящие</th>
            </tr>
          </thead>
          <tbody>
            {rules.length === 0 ? (
              <tr>
                <td colSpan={deviceMode ? 7 : 8} className="text-muted-foreground px-3 py-8 text-center">
                  Правил нет. Нажмите «Добавить правило».
                </td>
              </tr>
            ) : (
              rules.map((rule, index) => (
                <tr
                  key={rule.id}
                  className={cn(
                    'border-border hover:bg-input-background/70 border-b transition-colors last:border-b-0',
                    !rule.enabled && 'opacity-60',
                    draggedIndex === index && 'opacity-50'
                  )}
                  draggable={!disabled && canReorder(rule)}
                  onDragStart={(event) => { if (!disabled && canReorder(rule)) setDraggedIndex(index); else event.preventDefault() }}
                  onDragEnd={() => setDraggedIndex(null)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (!disabled && draggedIndex !== null && draggedIndex !== index && canReorder(rule) && canReorder(rules[draggedIndex])) {
                      onReorder(draggedIndex, index)
                    }
                    setDraggedIndex(null)
                  }}
                >
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-1.5">
                      <IconGripVertical className={cn('text-muted-foreground size-4', canReorder(rule) ? 'cursor-grab' : 'opacity-30')} />
                      <span className="text-muted-foreground text-sm">{index + 1}</span>
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-1">
                      <Button
                        size="icon-xs"
                        variant="outline"
                        disabled={disabled}
                        onClick={() => openEditDialog(rule)}
                        title="Редактировать"
                      >
                        <IconPencil />
                      </Button>
                      {canDelete(rule) && <Button
                        size="icon-xs"
                        variant="outline"
                        disabled={disabled}
                        onClick={() => onDeleteRule(rule.id)}
                        title="Удалить"
                      >
                        <IconTrash />
                      </Button>}
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <Switch size="sm" checked={rule.enabled} disabled={disabled || !canToggle(rule)} onCheckedChange={() => onToggleEnabled(rule.id)} aria-label={`${rule.enabled ? 'Выключить' : 'Включить'} ${rule.description}`} />
                  </td>
                  <td className="px-3 py-3">
                    <span className="text-foreground">{rule.description || '—'}</span>
                  </td>
                  <td className="px-3 py-3">
                    <span className="text-muted-foreground text-sm uppercase">
                      {rule.network || 'tcp,udp'}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <div className="text-muted-foreground flex flex-col gap-0.5 break-words text-sm">
                      {rule.domain.length > 0 && (
                        <div>
                          <span className="text-foreground font-medium">Домены:</span>{' '}
                          {rule.domain.slice(0, 2).map(value => <span key={value} title={value} className="mr-2">{resourceLabel(value)}</span>)}
                          {rule.domain.length > 2 && ` +${rule.domain.length - 2}`}
                        </div>
                      )}
                      {rule.ip.length > 0 && (
                        <div>
                          <span className="text-foreground font-medium">IP:</span>{' '}
                          {rule.ip.slice(0, 2).map(value => <span key={value} title={value} className="mr-2">{resourceLabel(value)}</span>)}
                          {rule.ip.length > 2 && ` +${rule.ip.length - 2}`}
                        </div>
                      )}
                      {!rule.domain.length && !rule.ip.length && '—'}
                    </div>
                  </td>
                  {!deviceMode && <td className="px-3 py-3">
                    <span className="text-muted-foreground text-sm">
                      {rule.inboundTag.join(', ') || '—'}
                    </span>
                  </td>}
                  <td className="px-3 py-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-primary break-words text-sm font-medium">{outbounds.find(out => out.tag === rule.outboundTag)?.label || rule.outboundTag}</span>
                      {onPing && outbounds.some(out => out.tag === rule.outboundTag) && <button type="button" className={cn('rounded px-1 text-[11px] tabular-nums hover:bg-primary/10', latencies[rule.outboundTag]?.ms !== undefined ? 'text-green-400' : latencies[rule.outboundTag]?.error ? 'text-red-400' : 'text-muted-foreground')} disabled={pingPending !== null} onClick={() => onPing(rule.outboundTag)} title={latencies[rule.outboundTag]?.error || 'Проверить задержку'} aria-label={`Пинг ${rule.outboundTag}`}>{pingPending === rule.outboundTag ? '…' : latencies[rule.outboundTag]?.ms !== undefined ? `${latencies[rule.outboundTag].ms} мс` : latencies[rule.outboundTag]?.error ? '✕' : 'Пинг'}</button>}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Модальное окно редактирования */}
      <Dialog open={editingRule !== null} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[760px]">
          <DialogHeader>
            <DialogTitle>{isAddingNew ? '+ Маршрутизация' : 'Редактировать правило'}</DialogTitle>
          </DialogHeader>

          {editingRule && (
            <div className="space-y-4 text-base">
              {/* Включить */}
              {!deviceMode && <div className="flex items-center gap-2">
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={editingRule.enabled}
                    disabled={!isAddingNew && !canToggle(editingRule)}
                    onChange={(e) => updateEditingRule({ enabled: e.target.checked })}
                    className="accent-primary size-4"
                  />
                  <span className="text-base font-medium">Включить</span>
                </label>
              </div>}

              {/* Комментарий */}
              <div>
                <label className="text-muted-foreground mb-1.5 block text-base">Комментарий</label>
                <Input
                  className="text-base"
                  value={editingRule.description}
                  onChange={(e) => updateEditingRule({ description: e.target.value })}
                  disabled={deviceMode && !isAddingNew}
                  placeholder="Описание правила"
                />
              </div>

              {/* Сеть */}
              <div>
                <label className="text-muted-foreground mb-1.5 block text-base">Сеть</label>
                <select
                  value={editingRule.network}
                  onChange={(e) => updateEditingRule({ network: e.target.value as any })}
                  className="bg-input-background hover:bg-input-background-hover border-input h-10 w-full rounded-md border px-2.5 text-base shadow-xs outline-none"
                >
                  <option value="">tcp,udp</option>
                  <option value="tcp">tcp</option>
                  <option value="udp">udp</option>
                  <option value="tcp,udp">tcp,udp</option>
                </select>
              </div>

              {/* Домены */}
              <ResourceField label="Домены" resources={editingRule.domain} onChange={domain => updateEditingRule({ domain })} onPicker={() => setShowDomainPicker(true)} placeholder="google.com, geosite:youtube" />
              {/* IP */}
              <ResourceField label="IP" resources={editingRule.ip} onChange={ip => updateEditingRule({ ip })} onPicker={() => setShowIpPicker(true)} placeholder="0.0.0.0/8, geoip:cloudflare" />
              <details open={Boolean(editingRule.port || editingRule.inboundTag.length)} className="space-y-3 rounded-md border border-border p-3"><summary className="text-muted-foreground cursor-pointer text-sm">Дополнительные параметры</summary>{/* Порт */}
              <div>
                <label className="text-muted-foreground mb-1.5 block text-base">Порты назначения</label>
                <Input
                  className="text-base"
                  value={editingRule.port}
                  onChange={(e) => updateEditingRule({ port: e.target.value })}
                  placeholder="53,443,1000-2000"
                />
              </div>

              {/* Теги входящих */}
              {!deviceMode && <div>
                <label className="text-muted-foreground mb-1.5 block text-base">
                  Теги входящих
                </label>
                <Input
                  className="text-base"
                  value={editingRule.inboundTag.join(', ')}
                  onChange={(e) =>
                    updateEditingRule({
                      inboundTag: e.target.value
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean)
                    })
                  }
                  placeholder="inbound-tag"
                />
              </div>}

              </details>{/* Тег исходящего */}
              <div>
                <label className="text-muted-foreground mb-1.5 block text-base">
                  Исходящее подключение
                </label>
                <div className="flex items-center gap-2">
                <select
                  value={editingRule.outboundTag}
                  onChange={(e) => updateEditingRule({ outboundTag: e.target.value })}
                  className="bg-input-background hover:bg-input-background-hover border-input h-10 min-w-0 flex-1 rounded-md border px-2.5 text-base shadow-xs outline-none"
                >
                  <option value="" disabled>Выберите исходящее</option>
                  {outbounds.map((out) => (
                    <option key={out.tag} value={out.tag}>
                      {out.label || out.tag}{latencies[out.tag]?.ms !== undefined ? ` · ${latencies[out.tag].ms} мс` : ''}
                    </option>
                  ))}
                </select>
                {onPing && outbounds.some(out => out.tag === editingRule.outboundTag) && <Button size="sm" variant="outline" disabled={pingPending !== null} onClick={() => onPing(editingRule.outboundTag)}>{pingPending === editingRule.outboundTag ? 'Проверка…' : latencies[editingRule.outboundTag]?.ms !== undefined ? `${latencies[editingRule.outboundTag].ms} мс` : 'Пинг'}</Button>}
                </div>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={closeDialog}>
              Закрыть
            </Button>
            <Button onClick={saveRule} disabled={disabled || isAddingNew && (!editingRule?.description.trim() || (!editingRule?.domain.length && !editingRule?.ip.length) || !editingRule?.outboundTag)}>
              {isAddingNew ? 'Создать' : 'Сохранить'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Picker доменов */}
      <Dialog open={showDomainPicker} onOpenChange={setShowDomainPicker}>
        <DialogContent className="max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-[1100px]">
          <DialogHeader>
            <DialogTitle>Домены</DialogTitle>
          </DialogHeader>
          {editingRule && (
            <GeoDatabasePicker
              kind="domain"
              resources={editingRule.domain}
              onChange={(domains) => updateEditingRule({ domain: domains })}
            />
          )}
          <DialogFooter>
            <Button onClick={() => setShowDomainPicker(false)}>Готово</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Picker IP */}
      <Dialog open={showIpPicker} onOpenChange={setShowIpPicker}>
        <DialogContent className="max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-[1100px]">
          <DialogHeader>
            <DialogTitle>IP-адреса</DialogTitle>
          </DialogHeader>
          {editingRule && (
            <GeoDatabasePicker
              kind="ip"
              resources={editingRule.ip}
              onChange={(ips) => updateEditingRule({ ip: ips })}
            />
          )}
          <DialogFooter>
            <Button onClick={() => setShowIpPicker(false)}>Готово</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

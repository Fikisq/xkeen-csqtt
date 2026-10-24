import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { IconPencil, IconTrash, IconPlus, IconGripVertical, IconFolder } from '@tabler/icons-react'
import { useRef, useState, type ReactNode } from 'react'
import { GeoDatabasePicker } from '@/components/configuration/GeoDatabasePicker'
import { resourceLabel } from '@/lib/geoLabels'

// Типы для правила маршрутизации в стиле 3x-ui
export interface RoutingRule {
  id: string
  enabled: boolean
  description: string
  network: 'tcp' | 'udp' | 'tcp,udp' | ''
  networkMixed?: boolean
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
  onAddRule: (rule: RoutingRule) => void | Promise<boolean>
  onEditRule: (id: string, rule: RoutingRule) => void | Promise<boolean>
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
  selectedRuleIds?: string[]
  onSelectionChange?: (ids: string[]) => void
  onApplyOutbound?: (tag: string) => Promise<boolean>
  renderResources?: (rule: RoutingRule, onChange: (updates: Partial<RoutingRule>) => void) => ReactNode
  canEditResources?: (rule: RoutingRule) => boolean
  canEditDescription?: (rule: RoutingRule) => boolean
  resourceLabeler?: (value: string) => string
  editorValid?: boolean
  onEditorOpen?: () => void
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
  selectedRuleIds = [],
  onSelectionChange,
  onApplyOutbound,
  renderResources,
  canEditResources = () => true,
  canEditDescription = () => true,
  resourceLabeler = resourceLabel,
  editorValid = true,
  onEditorOpen,
}: RoutingTableProps) {
  const [editingRule, setEditingRule] = useState<RoutingRule | null>(null)
  const [isAddingNew, setIsAddingNew] = useState(false)
  const [showDomainPicker, setShowDomainPicker] = useState(false)
  const [showIpPicker, setShowIpPicker] = useState(false)
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)
  const importInput = useRef<HTMLInputElement>(null)
  const [bulkOutbound, setBulkOutbound] = useState('')
  const selectable = !!onSelectionChange && !!onApplyOutbound
  const selected = new Set(selectedRuleIds.filter(id => rules.some(rule => rule.id === id)))
  const allSelected = rules.length > 0 && selected.size === rules.length
  const bulkOutbounds = outbounds.filter(out => out.tag !== '@bypass')

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
    onEditorOpen?.()
    setEditingRule({ ...emptyRule, id: `new-${Date.now()}` })
    setIsAddingNew(true)
  }

  const openEditDialog = (rule: RoutingRule) => {
    onEditorOpen?.()
    setEditingRule({ ...rule })
    setIsAddingNew(false)
  }

  const closeDialog = () => {
    setEditingRule(null)
    setIsAddingNew(false)
  }

  const saveRule = async () => {
    if (!editingRule || disabled || !editorValid || editingRule.networkMixed) return
    if (isAddingNew && (!editingRule.description.trim() || (!editingRule.domain.length && !editingRule.ip.length) || !editingRule.outboundTag)) return

    if (isAddingNew) {
      if (await onAddRule(editingRule) === false) return
    } else {
      if (await onEditRule(editingRule.id, editingRule) === false) return
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

      {selectable && selected.size > 0 && <div className="border-primary/30 bg-primary/5 flex flex-wrap items-center gap-2 rounded-lg border p-3" aria-live="polite">
        <span className="text-sm font-medium">Выбрано: {selected.size}</span>
        <select aria-label="Исходящее для выбранных правил" value={bulkOutbound} disabled={disabled} onChange={event => setBulkOutbound(event.target.value)} className="bg-input-background border-input h-9 min-w-0 max-w-full rounded-md border px-2 text-sm sm:max-w-80">
          <option value="" disabled>Выберите исходящее</option>
          {bulkOutbounds.map(out => <option key={out.tag} value={out.tag}>{out.label || out.tag}</option>)}
        </select>
        <Button size="sm" disabled={disabled || !bulkOutbounds.some(out => out.tag === bulkOutbound)} onClick={() => void onApplyOutbound?.(bulkOutbound)}>Применить к выбранным</Button>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onSelectionChange?.([])}>Снять выбор</Button>
        <span className="text-muted-foreground text-xs">Можно также нажать карточку протокола.</span>
      </div>}

      {/* Таблица правил */}
      <div className={cn('border-border bg-card overflow-x-auto rounded-xl border', disabled && 'opacity-45')} aria-disabled={disabled}>
        <table className="w-full min-w-[980px] table-fixed text-base">
          <thead className="bg-input-background border-border border-b">
            <tr>
              {selectable && <th className="w-10 px-3 py-3"><Checkbox className="border-ring/50 bg-input-background transition-colors hover:border-primary data-indeterminate:border-primary data-disabled:cursor-not-allowed data-disabled:opacity-40" aria-label="Выбрать все правила" disabled={disabled || !rules.length} checked={allSelected} indeterminate={selected.size > 0 && !allSelected} onCheckedChange={checked => onSelectionChange?.(checked ? rules.map(rule => rule.id) : [])} /></th>}
              <th className="w-14 px-3 py-3 text-left font-medium">#</th>
              <th className="w-22 px-3 py-3 text-left font-medium">Действия</th>
              <th className="w-24 px-3 py-3 text-left font-medium">Включить</th>
              <th className="w-40 px-3 py-3 text-left font-medium">Комментарий</th>
              <th className="w-24 px-3 py-3 text-left font-medium">Сеть</th>
              <th className="px-3 py-3 text-left font-medium">Пункт назначения</th>
              <th className="w-52 px-3 py-3 text-left font-medium">Исходящие</th>
            </tr>
          </thead>
          <tbody>
            {rules.length === 0 ? (
              <tr>
                <td colSpan={selectable ? 8 : 7} className="text-muted-foreground px-3 py-8 text-center">
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
                    draggedIndex === index && 'opacity-50',
                    selected.has(rule.id) && 'bg-primary/10'
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
                  {selectable && <td className="px-3 py-3"><Checkbox className="border-ring/50 bg-input-background transition-colors hover:border-primary data-disabled:cursor-not-allowed data-disabled:opacity-40" aria-label={`Выбрать ${rule.description || rule.id}`} disabled={disabled} checked={selected.has(rule.id)} onCheckedChange={checked => onSelectionChange?.(checked ? [...selected, rule.id] : [...selected].filter(id => id !== rule.id))} /></td>}
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
                      {rule.networkMixed ? 'Смешанная' : rule.network || 'tcp,udp'}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <div className="text-muted-foreground flex flex-col gap-0.5 break-words text-sm">
                      {rule.domain.length > 0 && (
                        <div>
                          <span className="text-foreground font-medium">Домены:</span>{' '}
                          {rule.domain.slice(0, 2).map(value => <span key={value} title={value} className="mr-2">{resourceLabeler(value)}</span>)}
                          {rule.domain.length > 2 && ` +${rule.domain.length - 2}`}
                        </div>
                      )}
                      {rule.ip.length > 0 && (
                        <div>
                          <span className="text-foreground font-medium">IP:</span>{' '}
                          {rule.ip.slice(0, 2).map(value => <span key={value} title={value} className="mr-2">{resourceLabeler(value)}</span>)}
                          {rule.ip.length > 2 && ` +${rule.ip.length - 2}`}
                        </div>
                      )}
                      {!rule.domain.length && !rule.ip.length && '—'}
                    </div>
                  </td>
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
                  <Checkbox
                    checked={editingRule.enabled}
                    disabled={!isAddingNew && !canToggle(editingRule)}
                    onCheckedChange={checked => updateEditingRule({ enabled: checked })}
                    className="border-ring/50 bg-input-background"
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
                  disabled={deviceMode && !isAddingNew || !isAddingNew && !canEditDescription(editingRule)}
                  placeholder="Описание правила"
                />
              </div>

              {/* Сеть */}
              <div>
                <label className="text-muted-foreground mb-1.5 block text-base">Сеть</label>
                <select
                  value={editingRule.networkMixed ? 'mixed' : editingRule.network}
                  disabled={!isAddingNew && !canEditResources(editingRule)}
                  onChange={(e) => updateEditingRule({ network: e.target.value as any, networkMixed: false })}
                  className="bg-input-background hover:bg-input-background-hover border-input h-10 w-full rounded-md border px-2.5 text-base shadow-xs outline-none"
                >
                  <option value="">tcp,udp</option>
                  {editingRule.networkMixed && <option value="mixed" disabled>Смешанная — выберите сеть</option>}
                  <option value="tcp">tcp</option>
                  <option value="udp">udp</option>
                  <option value="tcp,udp">tcp,udp</option>
                </select>
              </div>

              {/* Домены и IP: одна форма с адаптером ресурсов ядра. */}
              {renderResources ? renderResources(editingRule, updateEditingRule) : <><div>
                <label className="text-muted-foreground mb-1.5 block text-base">Домен</label>
                <div className="relative">
                  <Input
                    value={editingRule.domain.join(', ')}
                    onChange={(e) =>
                      updateEditingRule({
                        domain: e.target.value
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean)
                      })
                    }
                    placeholder="google.com, geosite:youtube"
                    className="pr-10 text-base"
                  />
                  <button
                    type="button"
                    onClick={() => setShowDomainPicker(true)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-primary transition-colors"
                    title="Выбрать из базы"
                  >
                    <IconFolder className="size-5" />
                  </button>
                </div>
              </div>

              {/* IP */}
              <div>
                <label className="text-muted-foreground mb-1.5 block text-base">IP</label>
                <div className="relative">
                  <Input
                    value={editingRule.ip.join(', ')}
                    onChange={(e) =>
                      updateEditingRule({
                        ip: e.target.value
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean)
                      })
                    }
                    placeholder="0.0.0.0/8, geoip:cloudflare"
                    className="pr-10 text-base"
                  />
                  <button
                    type="button"
                    onClick={() => setShowIpPicker(true)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-primary transition-colors"
                    title="Выбрать из базы"
                  >
                    <IconFolder className="size-5" />
                  </button>
                </div>
              </div>

              </>}
              {/* Тег исходящего */}
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
            <Button onClick={saveRule} disabled={disabled || !editorValid || editingRule?.networkMixed || isAddingNew && (!editingRule?.description.trim() || (!editingRule?.domain.length && !editingRule?.ip.length) || !editingRule?.outboundTag)}>
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

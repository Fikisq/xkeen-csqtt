import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { IconPencil, IconTrash, IconPlus, IconGripVertical, IconFolder } from '@tabler/icons-react'
import { useState } from 'react'
import { GeoDatabasePicker } from '@/components/configuration/GeoDatabasePicker'

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
}: RoutingTableProps) {
  const [editingRule, setEditingRule] = useState<RoutingRule | null>(null)
  const [isAddingNew, setIsAddingNew] = useState(false)
  const [showDomainPicker, setShowDomainPicker] = useState(false)
  const [showIpPicker, setShowIpPicker] = useState(false)
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)

  const emptyRule: RoutingRule = {
    id: '',
    enabled: true,
    description: '',
    network: '',
    inboundTag: [],
    outboundTag: outbounds[0]?.tag || 'direct',
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
    if (!editingRule) return

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

  return (
    <div className="space-y-4 text-foreground">
      {/* Заголовок и кнопка добавления */}
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-lg font-semibold">{deviceMode ? 'Правила устройства' : 'Маршрутизация'}</h3>
        <Button onClick={openAddDialog} size="sm">
          <IconPlus data-icon="inline-start" />
          Добавить правило
        </Button>
      </div>

      <div className="space-y-2">
        {rules.length === 0 ? <div className="border-border bg-card text-muted-foreground rounded-xl border p-6 text-center text-sm">Правил пока нет.</div> : rules.map((rule, index) => {
          const outbound = outbounds.find(item => item.tag === rule.outboundTag)
          return <div
                  key={rule.id}
                  className={cn(
                    'border-border bg-card hover:border-primary/50 flex flex-wrap items-start gap-3 rounded-xl border p-3 transition-colors sm:p-4',
                    !rule.enabled && !deviceMode && 'opacity-50',
                    draggedIndex === index && 'opacity-50'
                  )}
                  draggable={canReorder(rule)}
                  onDragStart={(event) => { if (canReorder(rule)) setDraggedIndex(index); else event.preventDefault() }}
                  onDragEnd={() => setDraggedIndex(null)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (draggedIndex !== null && draggedIndex !== index && canReorder(rule) && canReorder(rules[draggedIndex])) {
                      onReorder(draggedIndex, index)
                    }
                    setDraggedIndex(null)
                  }}
                >
                  <div className="flex shrink-0 items-center gap-1 pt-0.5">
                    <IconGripVertical className={cn('text-muted-foreground size-4', canReorder(rule) ? 'cursor-grab' : 'opacity-30')} />
                    <span className="text-muted-foreground w-5 text-center text-xs tabular-nums">{index + 1}</span>
                  </div>
                  <label className="flex items-center gap-1.5 pt-1" title={canToggle(rule) ? 'Включить или выключить правило' : 'Маршрут по умолчанию всегда включён'}>
                    <input type="checkbox" role="switch" checked={rule.enabled} disabled={!canToggle(rule)} onChange={() => onToggleEnabled(rule.id)} className="accent-primary size-4 cursor-pointer disabled:cursor-not-allowed" aria-label={`${rule.enabled ? 'Выключить' : 'Включить'} ${rule.description}`} />
                    <span className="text-muted-foreground text-xs">{rule.enabled ? 'Вкл.' : 'Выкл.'}</span>
                  </label>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="text-foreground font-semibold">{rule.description || 'Без названия'}</div>
                    <div className="text-muted-foreground break-words text-xs">
                      {rule.domain.length ? `Домены: ${rule.domain.slice(0, 2).join(', ')}${rule.domain.length > 2 ? ` +${rule.domain.length - 2}` : ''}` : ''}
                      {rule.domain.length && rule.ip.length ? ' · ' : ''}
                      {rule.ip.length ? `IP: ${rule.ip.slice(0, 2).join(', ')}${rule.ip.length > 2 ? ` +${rule.ip.length - 2}` : ''}` : ''}
                      {!rule.domain.length && !rule.ip.length ? (rule.port ? `Порт: ${rule.port}` : 'Весь трафик устройства') : ''}
                    </div>
                    <div className="text-muted-foreground text-xs">{rule.network || 'TCP, UDP'} <span className="mx-1">→</span> <span className="text-primary font-medium">{outbound?.label || rule.outboundTag}</span></div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button size="icon-sm" variant="outline" onClick={() => openEditDialog(rule)} title="Редактировать" aria-label={`Редактировать ${rule.description}`}><IconPencil /></Button>
                    {canDelete(rule) && <Button size="icon-sm" variant="outline" onClick={() => onDeleteRule(rule.id)} title="Удалить правило только для этого устройства" aria-label={`Удалить ${rule.description}`}><IconTrash /></Button>}
                  </div>
                </div>
        })}
      </div>

      {/* Модальное окно редактирования */}
      <Dialog open={editingRule !== null} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{isAddingNew ? '+ Маршрутизация' : 'Редактировать правило'}</DialogTitle>
          </DialogHeader>

          {editingRule && (
            <div className="space-y-4">
              {/* Включить */}
              {!deviceMode && <div className="flex items-center gap-2">
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={editingRule.enabled}
                    onChange={(e) => updateEditingRule({ enabled: e.target.checked })}
                    className="accent-primary size-4"
                  />
                  <span className="text-sm font-medium">Включить</span>
                </label>
              </div>}

              {/* Комментарий */}
              <div>
                <label className="text-muted-foreground mb-1.5 block text-sm">Комментарий</label>
                <Input
                  value={editingRule.description}
                  onChange={(e) => updateEditingRule({ description: e.target.value })}
                  disabled={deviceMode && !isAddingNew}
                  placeholder="Описание правила"
                />
              </div>

              {/* Сеть */}
              <div>
                <label className="text-muted-foreground mb-1.5 block text-sm">Сеть</label>
                <select
                  value={editingRule.network}
                  onChange={(e) => updateEditingRule({ network: e.target.value as any })}
                  className="bg-input-background hover:bg-input-background-hover border-input h-9 w-full rounded-md border px-2.5 text-[13px] shadow-xs outline-none"
                >
                  <option value="">tcp,udp</option>
                  <option value="tcp">tcp</option>
                  <option value="udp">udp</option>
                  <option value="tcp,udp">tcp,udp</option>
                </select>
              </div>

              {/* Домены */}
              <div>
                <label className="text-muted-foreground mb-1.5 block text-sm">Домен</label>
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
                    className="pr-10"
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
                <label className="text-muted-foreground mb-1.5 block text-sm">IP</label>
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
                    className="pr-10"
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

              {/* Порт */}
              <div>
                <label className="text-muted-foreground mb-1.5 block text-sm">Порт</label>
                <Input
                  value={editingRule.port}
                  onChange={(e) => updateEditingRule({ port: e.target.value })}
                  placeholder="53,443,1000-2000"
                />
              </div>

              {/* Теги входящих */}
              {!deviceMode && <div>
                <label className="text-muted-foreground mb-1.5 block text-sm">
                  Теги входящих
                </label>
                <Input
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

              {/* Тег исходящего */}
              <div>
                <label className="text-muted-foreground mb-1.5 block text-sm">
                  Тег исходящего
                </label>
                <select
                  value={editingRule.outboundTag}
                  onChange={(e) => updateEditingRule({ outboundTag: e.target.value })}
                  className="bg-input-background hover:bg-input-background-hover border-input h-9 w-full rounded-md border px-2.5 text-[13px] shadow-xs outline-none"
                >
                  {outbounds.map((out) => (
                    <option key={out.tag} value={out.tag}>
                      {out.label || out.tag}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={closeDialog}>
              Закрыть
            </Button>
            <Button onClick={saveRule}>
              {isAddingNew ? 'Создать' : 'Сохранить'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Picker доменов */}
      <Dialog open={showDomainPicker} onOpenChange={setShowDomainPicker}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Категории geo-баз</DialogTitle>
          </DialogHeader>
          {editingRule && (
            <GeoDatabasePicker
              kind="domain"
              resources={editingRule.domain}
              onChange={(domains) => updateEditingRule({ domain: domains })}
              onPick={() => setShowDomainPicker(false)}
            />
          )}
          <DialogFooter>
            <Button onClick={() => setShowDomainPicker(false)}>Применить</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Picker IP */}
      <Dialog open={showIpPicker} onOpenChange={setShowIpPicker}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Категории geo-баз</DialogTitle>
          </DialogHeader>
          {editingRule && (
            <GeoDatabasePicker
              kind="ip"
              resources={editingRule.ip}
              onChange={(ips) => updateEditingRule({ ip: ips })}
              onPick={() => setShowIpPicker(false)}
            />
          )}
          <DialogFooter>
            <Button onClick={() => setShowIpPicker(false)}>Применить</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

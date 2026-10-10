import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
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

      {/* Таблица правил */}
      <div className="border-border bg-card overflow-x-auto rounded-xl border">
        <table className="w-full min-w-[980px] table-fixed text-sm">
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
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-1.5">
                      <IconGripVertical className={cn('text-muted-foreground size-4', canReorder(rule) ? 'cursor-grab' : 'opacity-30')} />
                      <span className="text-muted-foreground text-xs">{index + 1}</span>
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-1">
                      <Button
                        size="icon-xs"
                        variant="outline"
                        onClick={() => openEditDialog(rule)}
                        title="Редактировать"
                      >
                        <IconPencil />
                      </Button>
                      {canDelete(rule) && <Button
                        size="icon-xs"
                        variant="outline"
                        onClick={() => onDeleteRule(rule.id)}
                        title="Удалить"
                      >
                        <IconTrash />
                      </Button>}
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <Switch size="sm" checked={rule.enabled} disabled={!canToggle(rule)} onCheckedChange={() => onToggleEnabled(rule.id)} aria-label={`${rule.enabled ? 'Выключить' : 'Включить'} ${rule.description}`} />
                  </td>
                  <td className="px-3 py-3">
                    <span className="text-foreground">{rule.description || '—'}</span>
                  </td>
                  <td className="px-3 py-3">
                    <span className="text-muted-foreground text-xs uppercase">
                      {rule.network || 'tcp,udp'}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <div className="text-muted-foreground flex flex-col gap-0.5 break-words text-xs">
                      {rule.domain.length > 0 && (
                        <div>
                          <span className="text-foreground font-medium">DOMAIN:</span>{' '}
                          {rule.domain.slice(0, 2).join(', ')}
                          {rule.domain.length > 2 && ` +${rule.domain.length - 2}`}
                        </div>
                      )}
                      {rule.ip.length > 0 && (
                        <div>
                          <span className="text-foreground font-medium">IP:</span>{' '}
                          {rule.ip.slice(0, 2).join(', ')}
                          {rule.ip.length > 2 && ` +${rule.ip.length - 2}`}
                        </div>
                      )}
                      {!rule.domain.length && !rule.ip.length && '—'}
                    </div>
                  </td>
                  {!deviceMode && <td className="px-3 py-3">
                    <span className="text-muted-foreground text-xs">
                      {rule.inboundTag.join(', ') || '—'}
                    </span>
                  </td>}
                  <td className="px-3 py-3">
                    <span className="text-primary break-words text-xs font-medium">{outbounds.find(out => out.tag === rule.outboundTag)?.label || rule.outboundTag}</span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
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

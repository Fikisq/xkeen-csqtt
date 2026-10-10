import { useMemo } from 'react'
import { parse as parseJsonc } from 'jsonc-parser'
import { Button } from '@/components/ui/button'
import { RoutingTable, type RoutingRule as TableRule } from './RoutingTable'
import { baseRuleTag, customRouteName, type RoutingRule as XrayRule } from '@/lib/xrayDeviceRouting'

const DEVICE_IP = '192.168.0.130'
const PREFIX = `device:${DEVICE_IP}:`
const FALLBACK = `${PREFIX}VPN`

function isOwn(rule: XrayRule): boolean {
  return baseRuleTag(rule).startsWith(PREFIX) && Array.isArray(rule.sourceIP) && rule.sourceIP.length === 1 && rule.sourceIP[0] === DEVICE_IP
}

function label(rule: XrayRule): string {
  const name = baseRuleTag(rule).slice(PREFIX.length)
  return name === 'VPN' ? 'Маршрут по умолчанию' : customRouteName(name)
}

function destination(rule: XrayRule): string {
  return rule.balancerTag ? `@balancer:${rule.balancerTag}` : rule.outboundTag ?? ''
}

function toTable(rule: XrayRule, index: number): TableRule {
  return {
    id: String(index), enabled: true, description: label(rule),
    network: (rule.network ?? '') as TableRule['network'], inboundTag: [],
    outboundTag: destination(rule), domain: rule.domain ?? [], ip: rule.ip ?? [],
    port: typeof rule.port === 'string' ? rule.port : '',
    sourcePort: '', sourceIP: [DEVICE_IP],
  }
}

function target(tag: string): Pick<XrayRule, 'outboundTag' | 'balancerTag'> {
  if (tag.startsWith('@balancer:')) return { balancerTag: tag.slice(10) }
  return { outboundTag: tag }
}

function validate(row: TableRule, outbounds: Set<string>, balancers: Set<string>, isNew: boolean): void {
  if (isNew && (!row.description.trim() || row.description.length > 40 || /[<>\r\n]/.test(row.description))) throw new Error('Укажите название правила: от 1 до 40 символов')
  if (isNew && !row.domain.length && !row.ip.length && !row.port.trim()) throw new Error('Укажите домен, IP или порт. Общее правило уже есть внизу таблицы')
  if (!row.outboundTag || !(row.outboundTag.startsWith('@balancer:') ? balancers.has(row.outboundTag.slice(10)) : outbounds.has(row.outboundTag))) throw new Error('Выберите существующее исходящее подключение')
  if (row.port && !/^\d{1,5}(?:-\d{1,5})?(?:,\d{1,5}(?:-\d{1,5})?)*$/.test(row.port)) throw new Error('Неверный формат порта')
}

function updateOwn(rule: XrayRule, row: TableRule): XrayRule {
  const name = baseRuleTag(rule)
  const suffix = name === FALLBACK && row.outboundTag === 'direct' ? (rule.ruleTag?.endsWith('|bypass') ? '|bypass' : '|split') : ''
  return {
    ...rule, ruleTag: name + suffix, sourceIP: [DEVICE_IP],
    outboundTag: undefined, balancerTag: undefined,
    network: row.network || 'tcp,udp',
    domain: row.domain.length ? row.domain : undefined,
    ip: row.ip.length ? row.ip : undefined,
    port: row.port || undefined,
    ...target(row.outboundTag),
  }
}

type Props = {
  content: string
  onChange: (change: (rules: XrayRule[]) => XrayRule[]) => Promise<boolean>
  onError: (message: string) => void
}

export function XrayDeviceRoutingTable({ content, onChange, onError }: Props) {
  const parsed = useMemo(() => parseJsonc(content), [content])
  const rules: XrayRule[] = Array.isArray(parsed?.routing?.rules) ? parsed.routing.rules : []
  const own = rules.map((rule, index) => ({ rule, index })).filter(({ rule }) => isOwn(rule))
  const outbounds: Array<{ tag: string; protocol: string }> = Array.isArray(parsed?.outbounds)
    ? parsed.outbounds.filter((out: any) => typeof out?.tag === 'string').map((out: any) => ({ tag: out.tag, protocol: out.protocol ?? '' })) : []
  const balancers: string[] = Array.isArray(parsed?.routing?.balancers)
    ? parsed.routing.balancers.map((item: any) => item?.tag).filter((tag: unknown): tag is string => typeof tag === 'string') : []
  const destinations = [...outbounds, ...balancers.map(tag => ({ tag: `@balancer:${tag}`, protocol: 'balancer' }))]
  const availableOutbounds = new Set(outbounds.map(out => out.tag))
  const availableBalancers = new Set(balancers)

  const run = (change: (rules: XrayRule[]) => XrayRule[]) => {
    void onChange(change).catch(error => onError(error instanceof Error ? error.message : 'Не удалось изменить правило'))
  }
  const edit = (index: number, row: TableRule, isNew: boolean) => {
    try { validate(row, availableOutbounds, availableBalancers, isNew) } catch (error) { onError((error as Error).message); return }
    run(current => {
      if (isNew) {
        const name = `custom:${encodeURIComponent(row.description.trim())}`
        if (current.some(rule => baseRuleTag(rule) === PREFIX + name)) throw new Error('Правило с таким названием уже есть')
        const created: XrayRule = updateOwn({ type: 'field', ruleTag: PREFIX + name, sourceIP: [DEVICE_IP] }, row)
        const insert = current.findIndex(rule => baseRuleTag(rule) === FALLBACK)
        if (insert < 0) throw new Error('Сначала создайте отдельный маршрут для 0.130')
        return [...current.slice(0, insert), created, ...current.slice(insert)]
      }
      if (!current[index] || !isOwn(current[index])) throw new Error('Правило изменилось. Обновите страницу')
      return current.map((rule, position) => position === index ? updateOwn(rule, row) : rule)
    })
  }
  const create = () => run(current => {
    if (current.some(rule => baseRuleTag(rule) === FALLBACK)) return current
    const globals = current.filter(rule => !baseRuleTag(rule).startsWith('device:') && !!baseRuleTag(rule) && (baseRuleTag(rule) === 'VPN' || baseRuleTag(rule) === 'RU' || baseRuleTag(rule) === 'RU_IP' || baseRuleTag(rule).startsWith('custom:') || ['Youtube', 'Discord', 'Games', 'AI', 'Github'].includes(baseRuleTag(rule))))
    const vpn = globals.find(rule => baseRuleTag(rule) === 'VPN')
    if (!vpn) throw new Error('Общий маршрут VPN не найден')
    const copies = globals.map(rule => ({
      ...rule,
      ruleTag: PREFIX + baseRuleTag(rule) + (baseRuleTag(rule) === 'VPN' && rule.ruleTag?.endsWith('|bypass') ? '|bypass' : ''),
      sourceIP: [DEVICE_IP], domain: rule.domain ? [...rule.domain] : undefined, ip: rule.ip ? [...rule.ip] : undefined,
    }))
    const firstGlobal = current.findIndex(rule => rule === globals[0])
    if (firstGlobal < 0) throw new Error('Общие маршруты не найдены')
    return [...current.slice(0, firstGlobal), ...copies, ...current.slice(firstGlobal)]
  })

  if (!rules.length) return <div className="text-muted-foreground p-4 text-sm">Маршруты Xray не найдены.</div>
  if (!own.length) return (
    <div className="border-border bg-card m-3 rounded-xl border p-5">
      <h3 className="text-foreground text-base font-semibold">Маршрутизация 192.168.0.130</h3>
      <p className="text-muted-foreground my-3 text-sm">У устройства пока нет собственных правил. Создайте копию общих маршрутов и настройте её в отдельной таблице.</p>
      <Button onClick={create}>Создать правила для 0.130</Button>
    </div>
  )

  return <div className="p-3">
    <div className="border-border bg-input-background mb-3 rounded-xl border p-3 text-sm">
      <span className="text-foreground font-semibold">192.168.0.130</span>
      <span className="text-muted-foreground ml-2">Правила этой таблицы применяются только к этому IP.</span>
    </div>
    <RoutingTable
      deviceMode rules={own.map(({ rule, index }) => toTable(rule, index))}
      outbounds={destinations} inbounds={[]}
      onAddRule={row => edit(-1, row, true)}
      onEditRule={(id, row) => edit(Number(id), row, false)}
      onDeleteRule={id => run(current => current.filter((rule, index) => index !== Number(id) || !isOwn(rule)))}
      onReorder={(from, to) => run(current => {
        const positions = current.map((rule, index) => isOwn(rule) ? index : -1).filter(index => index >= 0)
        const selected = positions.map(index => current[index])
        if (selected[from] == null || selected[to] == null || baseRuleTag(selected[from]) === FALLBACK || baseRuleTag(selected[to]) === FALLBACK) return current
        const [moving] = selected.splice(from, 1)
        selected.splice(to, 0, moving)
        return current.map((rule, index) => positions.includes(index) ? selected[positions.indexOf(index)] : rule)
      })}
      onToggleEnabled={() => {}}
      canDelete={row => baseRuleTag(rules[Number(row.id)]).startsWith(PREFIX + 'custom:')}
      canReorder={row => baseRuleTag(rules[Number(row.id)]) !== FALLBACK}
    />
  </div>
}

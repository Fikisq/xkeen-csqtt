import { useMemo, type ReactNode } from 'react'
import { parse as parseJsonc } from 'jsonc-parser'
import { Button } from '@/components/ui/button'
import { RoutingTable, type RoutingRule as TableRule } from './RoutingTable'
import { outboundTitle } from './Selectors'
import { useOutboundLatency } from './useOutboundLatency'
import { groupRuRows, isRuGroup, reorderRuGroups, ruBranchResources, sameRuGroup } from '@/lib/xrayRuGroup'
import { baseRuleTag, customRouteName, isFullBypass, type RoutingRule as XrayRule } from '@/lib/xrayDeviceRouting'

const DISABLED_SOURCE = '192.0.2.255'

function prefix(ip: string): string { return `device:${ip}:` }
function fallback(ip: string): string { return `${prefix(ip)}VPN` }
function isDisabled(rule: XrayRule): boolean { return baseRuleTag(rule).startsWith('disabled:device:') }
function ownName(rule: XrayRule): string { return baseRuleTag(rule).replace(/^disabled:/, '') }

function isOwn(rule: XrayRule, ip: string): boolean {
  const disabled = isDisabled(rule)
  return ownName(rule).startsWith(prefix(ip)) && Array.isArray(rule.sourceIP) && rule.sourceIP.length === 1 && rule.sourceIP[0] === (disabled ? DISABLED_SOURCE : ip)
}

function label(rule: XrayRule, ip: string): string {
  if (isRuGroup(rule)) return 'RU · RoscomVPN'
  const name = ownName(rule).slice(prefix(ip).length)
  return name === 'VPN' ? 'Маршрут по умолчанию' : customRouteName(name)
}

function destination(rule: XrayRule, ip: string): string {
  if (ownName(rule) === fallback(ip) && isFullBypass(rule)) return '@bypass'
  return rule.balancerTag ? `@balancer:${rule.balancerTag}` : rule.outboundTag ?? ''
}

function toTable(rule: XrayRule, ip: string): TableRule {
  return {
    id: ownName(rule), enabled: !isDisabled(rule), description: label(rule, ip),
    network: (rule.network ?? '') as TableRule['network'], inboundTag: [],
    outboundTag: destination(rule, ip), domain: rule.domain ?? [], ip: rule.ip ?? [],
    port: typeof rule.port === 'string' ? rule.port : '',
    sourcePort: '', sourceIP: [ip],
  }
}

function target(tag: string): Pick<XrayRule, 'outboundTag' | 'balancerTag'> {
  if (tag === '@bypass') return { outboundTag: 'direct' }
  if (tag.startsWith('@balancer:')) return { balancerTag: tag.slice(10) }
  return { outboundTag: tag }
}

function validate(row: TableRule, outbounds: Set<string>, balancers: Set<string>, isNew: boolean): void {
  if (isNew && (!row.description.trim() || row.description.length > 40 || /[<>\r\n]/.test(row.description))) throw new Error('Укажите название правила: от 1 до 40 символов')
  if (isNew && !row.domain.length && !row.ip.length && !row.port.trim()) throw new Error('Укажите домен, IP или порт. Общее правило уже есть внизу таблицы')
  if (!row.outboundTag || !(row.outboundTag === '@bypass' ? row.description === 'Маршрут по умолчанию' : row.outboundTag.startsWith('@balancer:') ? balancers.has(row.outboundTag.slice(10)) : outbounds.has(row.outboundTag))) throw new Error('Выберите существующее исходящее подключение')
  if (row.port && !/^\d{1,5}(?:-\d{1,5})?(?:,\d{1,5}(?:-\d{1,5})?)*$/.test(row.port)) throw new Error('Неверный формат порта')
}

function updateOwn(rule: XrayRule, row: TableRule, ip: string): XrayRule {
  const disabled = isDisabled(rule)
  const name = ownName(rule)
  const suffix = name === fallback(ip) && row.outboundTag === '@bypass' ? '|bypass' : name === fallback(ip) && row.outboundTag === 'direct' ? '|split' : ''
  return {
    ...rule, ruleTag: (disabled ? 'disabled:' : '') + name + suffix, sourceIP: [disabled ? DISABLED_SOURCE : ip],
    outboundTag: undefined, balancerTag: undefined,
    network: row.network || 'tcp,udp',
    ...ruBranchResources(rule, row.domain, row.ip),
    port: row.port || undefined,
    ...target(row.outboundTag),
  }
}

type Props = {
  deviceIp: string
  content: string
  onChange: (change: (rules: XrayRule[]) => XrayRule[], immediate?: boolean) => Promise<boolean>
  onError: (message: string) => void
  utilities?: ReactNode
  onImportFile?: (file: File) => Promise<void>
  onExportRules?: () => void
}

export function XrayDeviceRoutingTable({ deviceIp, content, onChange, onError, utilities, onImportFile, onExportRules }: Props) {
  const DEVICE_IP = deviceIp
  const PREFIX = prefix(deviceIp)
  const FALLBACK = fallback(deviceIp)
  const { latencies, pingPending, ping } = useOutboundLatency()
  const parsed = useMemo(() => parseJsonc(content), [content])
  const rules: XrayRule[] = Array.isArray(parsed?.routing?.rules) ? parsed.routing.rules : []
  const own = groupRuRows(rules.map((rule, index) => ({ rule, index })).filter(({ rule }) => isOwn(rule, DEVICE_IP)))
  const outbounds: Array<{ tag: string; protocol: string; label: string }> = Array.isArray(parsed?.outbounds)
    ? parsed.outbounds.filter((out: any) => typeof out?.tag === 'string').map((out: any) => ({ tag: out.tag, protocol: out.protocol ?? '', label: out.tag === 'direct' ? 'direct' : out.tag === 'block' ? 'blocked' : outboundTitle(out) })) : []
  const balancers: string[] = Array.isArray(parsed?.routing?.balancers)
    ? parsed.routing.balancers.map((item: any) => item?.tag).filter((tag: unknown): tag is string => typeof tag === 'string') : []
  const destinations = [...outbounds, ...balancers.map(tag => ({ tag: `@balancer:${tag}`, protocol: 'balancer', label: `Автовыбор: ${tag}` })), { tag: '@bypass', protocol: 'freedom', label: '🔓 Полный обход без VPN' }]
  const availableOutbounds = new Set(outbounds.map(out => out.tag))
  const availableBalancers = new Set(balancers)
  const fullBypass = own.some(({ rule }) => baseRuleTag(rule) === FALLBACK && isFullBypass(rule))

  const run = (change: (rules: XrayRule[]) => XrayRule[], immediate = true) => {
    void onChange(change, immediate).catch(error => onError(error instanceof Error ? error.message : 'Не удалось изменить правило'))
  }
  const edit = (id: string, row: TableRule, isNew: boolean) => {
    try { validate(row, availableOutbounds, availableBalancers, isNew) } catch (error) { onError((error as Error).message); return }
    run(current => {
      if (isNew) {
        const name = `custom:${encodeURIComponent(row.description.trim())}`
        if (current.some(rule => baseRuleTag(rule) === PREFIX + name)) throw new Error('Правило с таким названием уже есть')
        const created: XrayRule = updateOwn({ type: 'field', ruleTag: PREFIX + name, sourceIP: [DEVICE_IP] }, row, DEVICE_IP)
        const insert = current.findIndex(rule => baseRuleTag(rule) === FALLBACK)
        if (insert < 0) throw new Error(`Сначала создайте отдельный маршрут для ${deviceIp}`)
        return [...current.slice(0, insert), created, ...current.slice(insert)]
      }
      const index = current.findIndex(rule => ownName(rule) === id)
      if (index < 0 || !isOwn(current[index], DEVICE_IP)) throw new Error('Правило уже удалено. Откройте актуальную строку')
      if (isRuGroup(current[index]) && (!row.domain.length || !row.ip.length)) throw new Error('Для RU укажите категории доменов и IP')
      const changed = current.map((rule, position) => position === index || sameRuGroup(rule, current[index]) ? updateOwn(rule, row, DEVICE_IP) : rule)
      if (ownName(current[index]) !== FALLBACK) return changed
      const positions = changed.map((rule, position) => isOwn(rule, DEVICE_IP) ? position : -1).filter(position => position >= 0)
      const block = positions.map(position => changed[position])
      const fallback = changed[index]
      const services = block.filter(rule => rule !== fallback)
      const ordered = row.outboundTag === '@bypass' ? [fallback, ...services] : [...services, fallback]
      return changed.map((rule, position) => positions.includes(position) ? ordered[positions.indexOf(position)] : rule)
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
  const toggleFullBypass = () => run(current => {
    const positions = current.map((rule, index) => isOwn(rule, DEVICE_IP) ? index : -1).filter(index => index >= 0)
    const block = positions.map(index => current[index])
    const vpn = block.find(rule => ownName(rule) === FALLBACK)
    if (!vpn) throw new Error('Маршрут по умолчанию не найден')
    const services = block.filter(rule => rule !== vpn)
    const nextVpn = { ...vpn, ruleTag: FALLBACK + (fullBypass ? '|split' : '|bypass'), outboundTag: 'direct', balancerTag: undefined }
    const ordered = fullBypass ? [...services, nextVpn] : [nextVpn, ...services]
    return current.map((rule, index) => positions.includes(index) ? ordered[positions.indexOf(index)] : rule)
  })

  if (!rules.length) return <div className="text-muted-foreground p-4 text-sm">Маршруты Xray не найдены.</div>
  if (!own.length) return (
    <div className="border-border bg-card m-3 rounded-xl border p-5">
      <h3 className="text-foreground text-base font-semibold">Маршрутизация {deviceIp}</h3>
      <p className="text-muted-foreground my-3 text-sm">У устройства пока нет собственных правил. Создайте копию общих маршрутов и настройте её в отдельной таблице.</p>
      <Button onClick={create}>Создать правила для {deviceIp}</Button>
    </div>
  )

  return <div className="p-3">
    <RoutingTable
      deviceMode rules={own.map(({ rule }) => toTable(rule, DEVICE_IP))}
      disabled={fullBypass}
      latencies={latencies} pingPending={pingPending} onPing={tag => void ping(tag)}
      toolbarAction={<><Button size="sm" variant={fullBypass ? 'default' : 'outline'} aria-pressed={fullBypass} onClick={toggleFullBypass}>🔓 Полный обход без VPN: {fullBypass ? 'включён' : 'выключен'}</Button>{utilities}</>}
      onImportFile={onImportFile} onExportRules={onExportRules}
      outbounds={destinations} inbounds={[]}
      onAddRule={row => edit('', row, true)}
      onEditRule={(id, row) => edit(id, row, false)}
      onDeleteRule={id => run(current => {
        const selected = current.find(rule => ownName(rule) === id)
        if (!selected) throw new Error('Правило уже удалено')
        return current.filter(rule => (ownName(rule) !== id && !sameRuGroup(rule, selected)) || !isOwn(rule, DEVICE_IP))
      })}
      onReorder={(from, to) => run(current => reorderRuGroups(current, rule => isOwn(rule, DEVICE_IP), from, to))}
      onToggleEnabled={id => run(current => {
        const selected = current.find(rule => ownName(rule) === id)
        if (!selected) throw new Error('Правило уже удалено')
        return current.map(rule => {
        if ((ownName(rule) !== id && !sameRuGroup(rule, selected)) || !isOwn(rule, DEVICE_IP) || ownName(rule) === FALLBACK) return rule
        return isDisabled(rule)
          ? { ...rule, ruleTag: rule.ruleTag?.replace(/^disabled:/, ''), sourceIP: [DEVICE_IP] }
          : { ...rule, ruleTag: `disabled:${rule.ruleTag}`, sourceIP: [DISABLED_SOURCE] }
      })})}
      canDelete={row => row.id !== FALLBACK}
      canReorder={row => row.id !== FALLBACK}
      canToggle={row => row.id !== FALLBACK}
    />
  </div>
}

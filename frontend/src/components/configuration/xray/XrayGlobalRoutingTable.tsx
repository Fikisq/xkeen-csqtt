import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { IconBolt } from '@tabler/icons-react'
import { parse as parseJsonc } from 'jsonc-parser'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { DeviceTab } from '@/components/configuration/DeviceTab'
import { cn } from '@/lib/utils'
import { groupRuRows, isRuGroup, reorderRuGroups, ruBranchResources, sameRuGroup } from '@/lib/xrayRuGroup'
import { routeLabel } from '@/components/configuration/RouteIcon'
import { RoutingTable, type RoutingRule as TableRule } from './RoutingTable'
import { outboundTitle, outboundTransport } from './Selectors'
import { useOutboundLatency } from './useOutboundLatency'
import { XrayDeviceRoutingTable } from './XrayDeviceRoutingTable'
import { addCustomIpRoute, addCustomRoute, baseRuleTag, isFullBypass, readDeviceIps, removeCustomRoute, renameCustomRoute, routeTags, updateDeviceRules, updateGlobalRules, validDeviceIp, type RoutingRule as XrayRule } from '@/lib/xrayDeviceRouting'

const DISABLED_SOURCE = '192.0.2.255'
function ProtocolDetails({ outbound }: { outbound: { tag: string; protocol: string; streamSettings?: { network?: string; security?: string } } }) {
  if (outbound.tag === 'wdtt-plus') return <span className="text-muted-foreground text-sm">socks5 · tcp/udp</span>
  if (!['vless', 'vmess', 'trojan', 'hysteria', 'hysteria2', 'tuic', 'shadowsocks'].includes(outbound.protocol)) {
    return <span className="text-muted-foreground text-xs">{outbound.tag === 'direct' ? 'Напрямую; правила ресурсов действуют' : outboundTransport(outbound)}</span>
  }
  const quic = ['hysteria', 'hysteria2', 'tuic'].includes(outbound.protocol)
  const protocol = outbound.protocol === 'hysteria' ? 'hysteria2' : outbound.protocol
  const network = quic ? 'quic' : outbound.streamSettings?.network === 'raw' ? 'tcp' : outbound.streamSettings?.network ?? 'tcp'
  const security = quic ? 'tls' : outbound.streamSettings?.security ?? 'none'
  return <span className="text-muted-foreground text-sm">{[protocol, network, security].map(value => value.toLowerCase()).join(' · ')}</span>
}
const PROTOCOL_ORDER_KEY = 'xkeen-xray-protocol-card-order'
const managed = (rule: XrayRule, tags: string[]) => tags.includes(baseRuleTag(rule))
const disabled = (rule: XrayRule) => Array.isArray(rule.sourceIP) && rule.sourceIP.length === 1 && rule.sourceIP[0] === DISABLED_SOURCE

function placeBypassFirst(changed: XrayRule[]): XrayRule[] {
  const index = changed.findIndex(rule => baseRuleTag(rule) === 'VPN')
  const services = routeTags(changed).filter(name => name !== 'VPN')
  const first = changed.findIndex(rule => services.includes(baseRuleTag(rule)))
  if (index < 0 || first < 0 || index < first) return changed
  const moved = [...changed]
  const [vpnRule] = moved.splice(index, 1)
  moved.splice(first, 0, vpnRule)
  return moved
}

function destination(rule: XrayRule): string {
  if (baseRuleTag(rule) === 'VPN' && isFullBypass(rule)) return '@bypass'
  return rule.balancerTag ? `@balancer:${rule.balancerTag}` : rule.outboundTag ?? ''
}

function toTable(rule: XrayRule, index: number): TableRule {
  return {
    id: String(index), enabled: !disabled(rule), description: isRuGroup(rule) ? 'RU · RoscomVPN' : routeLabel(baseRuleTag(rule)),
    network: (rule.network ?? '') as TableRule['network'],
    inboundTag: Array.isArray(rule.inboundTag) ? rule.inboundTag as string[] : [],
    outboundTag: destination(rule), domain: rule.domain ?? [], ip: rule.ip ?? [],
    port: typeof rule.port === 'string' ? rule.port : '', sourcePort: '',
    sourceIP: rule.sourceIP ?? [],
  }
}

type Props = {
  content: string
  onChange: (change: (rules: XrayRule[]) => XrayRule[]) => Promise<boolean>
  onDeviceChange: (ip: string, change: (rules: XrayRule[]) => XrayRule[]) => Promise<boolean>
  onError: (message: string) => void
  utilities?: ReactNode
}

export function XrayGlobalRoutingTable({ content, onChange, onDeviceChange, onError, utilities }: Props) {
  const [deviceIp, setDeviceIp] = useState('')
  const [newIp, setNewIp] = useState('')
  const [addIpOpen, setAddIpOpen] = useState(false)
  const [testingAll, setTestingAll] = useState(false)
  const automaticPingStarted = useRef(false)
  const [draggedProtocol, setDraggedProtocol] = useState<string | null>(null)
  const [protocolOrder, setProtocolOrder] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(PROTOCOL_ORDER_KEY) ?? '[]')
      return Array.isArray(saved) ? saved.filter((tag): tag is string => typeof tag === 'string') : []
    } catch { return [] }
  })
  const { latencies, pingPending, ping } = useOutboundLatency()
  const parsed = useMemo(() => parseJsonc(content), [content])
  const rules: XrayRule[] = Array.isArray(parsed?.routing?.rules) ? parsed.routing.rules : []
  const tags = routeTags(rules)
  const devices = readDeviceIps(rules)
  const own = groupRuRows(rules.map((rule, index) => ({ rule, index })).filter(({ rule }) => managed(rule, tags)))
  const vpn = own.find(({ rule }) => baseRuleTag(rule) === 'VPN')
  const fullBypass = isFullBypass(vpn?.rule)
  const deviceVpn = deviceIp ? rules.find(rule => baseRuleTag(rule) === `device:${deviceIp}:VPN`) : undefined
  const selectedVpn = deviceIp ? deviceVpn : vpn?.rule
  const outbounds: Array<{ tag: string; protocol: string; label: string }> = Array.isArray(parsed?.outbounds)
    ? parsed.outbounds.filter((out: any) => typeof out?.tag === 'string' && (!out.tag.startsWith('proxy-') || rules.some(rule => rule.outboundTag === out.tag))).map((out: any) => ({ tag: out.tag, protocol: out.protocol ?? '', label: out.tag === 'direct' ? 'direct' : out.tag === 'block' ? 'blocked' : outboundTitle(out) })) : []
  const balancers: string[] = Array.isArray(parsed?.routing?.balancers)
    ? parsed.routing.balancers.map((item: any) => item?.tag).filter((tag: unknown): tag is string => typeof tag === 'string') : []
  const destinations = [...outbounds, ...balancers.map(tag => ({ tag: `@balancer:${tag}`, protocol: 'balancer', label: `Автовыбор: ${tag}` })), { tag: '@bypass', protocol: 'freedom', label: '🔓 Полный обход без VPN' }]
  const protocolCards = outbounds.filter(out => ['vless', 'hysteria', 'hysteria2', 'tuic', 'freedom', 'socks'].includes(out.protocol.toLowerCase()) && out.tag !== 'block' && !out.tag.startsWith('proxy-'))
    .sort((a, b) => {
      const rank = (tag: string) => tag === 'direct' ? 0 : tag === 'nfqws-direct' ? 1 : tag === 'csqtt' ? 3 : tag === 'wdtt-plus' ? 4 : 2
      return rank(a.tag) - rank(b.tag)
    })
  const orderedCards = protocolOrder.length
    ? [...protocolOrder.map(tag => protocolCards.find(out => out.tag === tag)).filter((out): out is typeof protocolCards[number] => !!out), ...protocolCards.filter(out => !protocolOrder.includes(out.tag))]
    : protocolCards

  function moveProtocol(source: string, target: string) {
    if (source === target) return
    const tags = orderedCards.map(out => out.tag)
    const from = tags.indexOf(source)
    const to = tags.indexOf(target)
    if (from < 0 || to < 0) return
    tags.splice(from, 1)
    tags.splice(to, 0, source)
    setProtocolOrder(tags)
    try { window.localStorage.setItem(PROTOCOL_ORDER_KEY, JSON.stringify(tags)) } catch { /* Browser storage may be unavailable. */ }
  }

  async function pingAll() {
    setTestingAll(true)
    try { for (const out of protocolCards) await ping(out.tag) }
    finally { setTestingAll(false) }
  }

  const pingTargetKey = protocolCards.map(out => out.tag).join('|')
  useEffect(() => {
    if (automaticPingStarted.current || !pingTargetKey) return
    automaticPingStarted.current = true
    void pingAll()
  }, [pingTargetKey])

  const run = (change: (rules: XrayRule[]) => XrayRule[]) => {
    void onChange(change).catch(error => onError(error instanceof Error ? error.message : 'Не удалось изменить правило'))
  }

  const chooseVpn = (tag: string) => {
    if (deviceIp) {
      void onDeviceChange(deviceIp, current => updateDeviceRules(current, deviceIp, 'VPN', tag)).catch(error => onError(error instanceof Error ? error.message : 'Не удалось изменить сервер устройства'))
      return
    }
    run(current => {
    const changed = updateGlobalRules(current, 'VPN', tag)
    return tag === '@bypass' ? placeBypassFirst(changed) : changed
    })
  }

  const inScope = (rule: XrayRule, ip: string) => ip
    ? baseRuleTag(rule).replace(/^disabled:/, '').startsWith(`device:${ip}:`)
    : managed(rule, routeTags(rules))
  const selectedRules = rules.filter(rule => inScope(rule, deviceIp))
  const exportRules = () => {
    const data = JSON.stringify({ format: 'xkeen-routing-rules-v1', scope: deviceIp ? 'device' : 'global', deviceIp: deviceIp || undefined, rules: selectedRules }, null, 2)
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `xkeen-rules-${deviceIp || 'global'}-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const importRules = async (file: File) => {
    try {
      if (file.size > 1024 * 1024) throw new Error('Файл правил слишком большой')
      const data = JSON.parse(await file.text())
      if (data?.format !== 'xkeen-routing-rules-v1' || data.scope !== (deviceIp ? 'device' : 'global') || (deviceIp && data.deviceIp !== deviceIp) || !Array.isArray(data.rules) || !data.rules.length || data.rules.length > 100) throw new Error('Файл не соответствует выбранной таблице правил')
      const imported: XrayRule[] = data.rules
      const names = new Set<string>()
      const validTargets = new Set(outbounds.map(out => out.tag))
      for (const rule of imported) {
        if (!rule || rule.type !== 'field' || typeof rule.ruleTag !== 'string' || rule.ruleTag.length > 160) throw new Error('Некорректное правило в файле')
        const name = baseRuleTag(rule).replace(/^disabled:/, '')
        if (deviceIp ? !name.startsWith(`device:${deviceIp}:`) : !routeTags(imported).includes(name)) throw new Error('Правило другого устройства или неизвестной категории')
        if (names.has(name)) throw new Error('В файле повторяются категории правил')
        names.add(name)
        if (!(rule.outboundTag && validTargets.has(rule.outboundTag)) && !(rule.balancerTag && balancers.includes(rule.balancerTag))) throw new Error(`Исходящее для «${name}» отсутствует в конфигурации`)
        if (rule.sourceIP && (!Array.isArray(rule.sourceIP) || rule.sourceIP.length !== 1 || ![deviceIp, DISABLED_SOURCE].includes(rule.sourceIP[0]))) throw new Error('Некорректный IP источника в файле')
        if (deviceIp && !rule.sourceIP) throw new Error('В правиле устройства отсутствует IP источника')
        for (const field of ['domain', 'ip', 'inboundTag'] as const) {
          const values = rule[field]
          if (values !== undefined && (!Array.isArray(values) || values.length > 256 || values.some(value => typeof value !== 'string' || value.length > 512))) throw new Error(`Некорректное поле ${field}`)
        }
        if (rule.network && !['tcp', 'udp', 'tcp,udp'].includes(rule.network)) throw new Error('Некорректный тип сети')
      }
      if (!names.has(deviceIp ? `device:${deviceIp}:VPN` : 'VPN')) throw new Error('В файле отсутствует маршрут по умолчанию')
      if (!window.confirm(`Заменить ${deviceIp ? `правила ${deviceIp}` : 'общие правила'} из файла «${file.name}»?`)) return
      const replace = (current: XrayRule[]) => {
        const positions = current.map((rule, index) => inScope(rule, deviceIp) ? index : -1).filter(index => index >= 0)
        if (!positions.length) throw new Error('Текущая таблица правил не найдена')
        const first = positions[0]
        return [...current.slice(0, first), ...imported, ...current.slice(first).filter(rule => !inScope(rule, deviceIp))]
      }
      const applied = deviceIp ? await onDeviceChange(deviceIp, replace) : await onChange(replace)
      if (!applied) throw new Error('Не удалось применить импортированные правила')
    } catch (error) { onError(error instanceof Error ? error.message : 'Не удалось импортировать правила') }
  }

  const edit = (index: number, row: TableRule, isNew: boolean) => {
    const targetValid = row.outboundTag === '@bypass' ? !isNew && baseRuleTag(rules[index]) === 'VPN' : row.outboundTag.startsWith('@balancer:') ? balancers.includes(row.outboundTag.slice(10)) : outbounds.some(out => out.tag === row.outboundTag)
    if (!targetValid) { onError('Выберите существующее исходящее подключение'); return }
    if (isNew && (!row.description.trim() || row.description.length > 40 || /[<>\r\n]/.test(row.description))) { onError('Укажите название правила: от 1 до 40 символов'); return }
    if (isNew && (!row.domain.length && !row.ip.length || !!row.domain.length && !!row.ip.length)) { onError('Для нового правила укажите домены или IP'); return }
    if (row.port && !/^\d{1,5}(?:-\d{1,5})?(?:,\d{1,5}(?:-\d{1,5})?)*$/.test(row.port)) { onError('Неверный формат порта'); return }
    run(current => {
      if (isNew) {
        const added = row.domain.length ? addCustomRoute(current, row.description, row.domain) : addCustomIpRoute(current, row.description, row.ip)
        const tag = `custom:${encodeURIComponent(row.description.trim())}`
        return applyRow(added, tag, row)
      }
      const original = current[index]
      if (!original || !managed(original, routeTags(current))) throw new Error('Правило изменилось. Обновите страницу')
      const tag = baseRuleTag(original)
      let changed = current
      if (tag.startsWith('custom:') && row.description.trim() !== routeLabel(tag)) {
        changed = renameCustomRoute(changed, tag, row.description)
        const nextTag = `custom:${encodeURIComponent(row.description.trim())}`
        changed = changed.map(rule => {
          const name = baseRuleTag(rule)
          return name.startsWith('disabled:device:') && name.endsWith(`:${tag}`)
            ? { ...rule, ruleTag: rule.ruleTag!.replace(`:${tag}`, `:${nextTag}`) } : rule
        })
      }
      const finalTag = tag.startsWith('custom:') ? `custom:${encodeURIComponent(row.description.trim())}` : tag
      return applyRow(changed, finalTag, row)
    })
  }

  function applyRow(current: XrayRule[], tag: string, row: TableRule): XrayRule[] {
    const original = current.find(rule => baseRuleTag(rule) === tag)
    if (!original) throw new Error('Правило не найдено')
    const groupTags = isRuGroup(original) ? ['RU', 'RU_IP'] : [tag]
    if (isRuGroup(original) && (!row.domain.length || !row.ip.length)) throw new Error('Для RU укажите категории доменов и IP')
    if (tag === 'VPN' && (row.domain.length !== (original.domain?.length ?? 0) || row.ip.length !== (original.ip?.length ?? 0))) throw new Error('Ресурсы маршрута по умолчанию менять нельзя')
    const withFields = current.map(rule => {
      const name = baseRuleTag(rule).replace(/^disabled:/, '')
      const sameResource = groupTags.some(groupTag => name === groupTag || name.startsWith('device:') && name.endsWith(`:${groupTag}`))
      if (!sameResource) return rule
      if (!groupTags.includes(name)) return { ...rule, ...ruBranchResources(rule, row.domain, row.ip) }
      return { ...rule, network: row.network || 'tcp,udp', inboundTag: row.inboundTag.length ? row.inboundTag : undefined,
        ...ruBranchResources(rule, row.domain, row.ip),
        port: row.port || undefined }
    })
    const currentDestination = destination(withFields.find(rule => baseRuleTag(rule) === tag)!)
    const selected = currentDestination === row.outboundTag ? withFields : groupTags.reduce((changed, groupTag) => updateGlobalRules(changed, groupTag, row.outboundTag), withFields)
    const ordered = tag === 'VPN' && row.outboundTag === '@bypass' ? placeBypassFirst(selected) : selected
    return ordered.map(rule => groupTags.includes(baseRuleTag(rule)) ? { ...rule, sourceIP: row.enabled ? undefined : [DISABLED_SOURCE] } : rule)
  }

  return <div className="space-y-5 p-3">
    <div className="border-border flex flex-col gap-2 border-b pb-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant={!deviceIp ? 'default' : 'outline'} onClick={() => setDeviceIp('')}>Общая маршрутизация</Button>
        {devices.map(ip => <DeviceTab key={ip} ip={ip} selected={deviceIp === ip} disabled={false} onSelect={() => setDeviceIp(ip)} onRemove={() => {
        if (window.confirm(`Удалить отдельные правила ${ip}?`)) {
          void onDeviceChange(ip, current => current.filter(rule => !baseRuleTag(rule).startsWith(`device:${ip}:`)))
          if (deviceIp === ip) setDeviceIp('')
        }
        }} />)}
        {deviceIp && !devices.includes(deviceIp) && <Button size="sm" variant="outline">{deviceIp}</Button>}
        <Button size="sm" variant="outline" onClick={() => setAddIpOpen(true)}>+ Добавить IP</Button>
      </div>
    </div>
    <Dialog open={addIpOpen} onOpenChange={open => { setAddIpOpen(open); if (!open) setNewIp('') }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>Добавить устройство</DialogTitle></DialogHeader>
        <Input value={newIp} onChange={event => setNewIp(event.target.value)} onKeyDown={event => {
          if (event.key === 'Enter' && validDeviceIp(newIp) && !devices.includes(newIp.trim())) { setDeviceIp(newIp.trim()); setAddIpOpen(false); setNewIp('') }
        }} placeholder="192.168.0.20" aria-label="IP нового устройства" />
        <DialogFooter><Button disabled={!validDeviceIp(newIp) || devices.includes(newIp.trim())} onClick={() => { setDeviceIp(newIp.trim()); setAddIpOpen(false); setNewIp('') }}>Добавить</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <section className="border-border bg-input-background/70 space-y-3 rounded-xl border p-3">
      <div className="flex items-center justify-between gap-2"><h3 className="text-base font-semibold">Протоколы</h3><Button size="sm" variant="outline" disabled={testingAll || pingPending !== null} onClick={() => void pingAll()}><IconBolt size={16} /> {testingAll ? 'Проверка…' : 'Пинг'}</Button></div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6 2xl:grid-cols-7">
        {orderedCards.map(out => <div key={out.tag} draggable onDragStart={event => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', out.tag); setDraggedProtocol(out.tag) }} onDragOver={event => { if (draggedProtocol) { event.preventDefault(); event.dataTransfer.dropEffect = 'move' } }} onDrop={event => { event.preventDefault(); if (draggedProtocol) moveProtocol(draggedProtocol, out.tag); setDraggedProtocol(null) }} onDragEnd={() => setDraggedProtocol(null)} title="Перетащите карточку, чтобы изменить порядок в браузере" className={cn('relative cursor-grab rounded-md border text-sm transition-colors active:cursor-grabbing', draggedProtocol === out.tag && 'opacity-60', selectedVpn?.outboundTag === out.tag && !isFullBypass(selectedVpn) ? 'border-blue-400 bg-blue-500/20' : 'border-ring/40 hover:border-blue-400 hover:bg-blue-500/10')}>
          <button type="button" className="flex min-h-22 w-full flex-col justify-between px-3 py-2.5 text-left" aria-pressed={selectedVpn?.outboundTag === out.tag && !isFullBypass(selectedVpn)} onClick={() => chooseVpn(out.tag)}><span className="grid w-full grid-cols-[minmax(0,1fr)_4rem] gap-2"><span className="min-w-0 break-words font-medium">{out.label}</span><span aria-hidden="true" /></span><ProtocolDetails outbound={(parsed.outbounds as any[]).find(raw => raw.tag === out.tag)} /></button>
          <button type="button" className={cn('absolute right-2 top-2 w-16 rounded p-1 text-xs font-medium tabular-nums hover:bg-blue-500/20', latencies[out.tag]?.ms !== undefined ? 'text-green-400' : latencies[out.tag]?.error ? 'text-red-400' : 'text-sky-400')} disabled={testingAll || pingPending !== null} onClick={() => void ping(out.tag)} title={latencies[out.tag]?.error || 'Проверить соединение через узел'} aria-label={`Пинг ${out.label}`}>{pingPending === out.tag ? '…' : latencies[out.tag]?.ms !== undefined ? `${latencies[out.tag].ms} мс` : latencies[out.tag]?.error ? '✕' : <IconBolt size={17} />}</button>
        </div>)}
      </div>
    </section>
    {deviceIp ? <XrayDeviceRoutingTable deviceIp={deviceIp} content={content} onChange={change => onDeviceChange(deviceIp, change)} onError={onError} utilities={utilities} onImportFile={importRules} onExportRules={exportRules} /> : <>
    {fullBypass && <p className="text-muted-foreground text-xs">Полный обход активен: все общие правила ниже сохранены, но временно недоступны.</p>}
    <RoutingTable
      rules={own.map(({ rule, index }) => toTable(rule, index))}
      showTitle={false}
      outbounds={destinations} inbounds={[]}
      disabled={fullBypass} latencies={latencies} pingPending={pingPending} onPing={tag => void ping(tag)}
      toolbarAction={<><Button size="sm" variant={fullBypass ? 'default' : 'outline'} aria-pressed={fullBypass} onClick={() => chooseVpn(fullBypass ? 'direct' : '@bypass')}>🔓 Полный обход без VPN: {fullBypass ? 'включён' : 'выключен'}</Button>{utilities}</>}
      onImportFile={importRules} onExportRules={exportRules}
      onAddRule={row => edit(-1, row, true)}
      onEditRule={(id, row) => edit(Number(id), row, false)}
      onDeleteRule={id => run(current => {
        const tag = baseRuleTag(current[Number(id)])
        const groupTags = isRuGroup(current[Number(id)]) ? ['RU', 'RU_IP'] : [tag]
        return groupTags.reduce((changed, groupTag) => removeCustomRoute(changed, groupTag).filter(rule => !baseRuleTag(rule).startsWith('disabled:device:') || !baseRuleTag(rule).endsWith(`:${groupTag}`)), current)
      })}
      onReorder={(from, to) => run(current => reorderRuGroups(current, rule => managed(rule, routeTags(current)), from, to))}
      onToggleEnabled={id => run(current => current.map((rule, index) => index === Number(id) || sameRuGroup(rule, current[Number(id)]) ? { ...rule, sourceIP: disabled(rule) ? undefined : [DISABLED_SOURCE] } : rule))}
      canDelete={row => baseRuleTag(rules[Number(row.id)]) !== 'VPN'}
      canReorder={row => baseRuleTag(rules[Number(row.id)]) !== 'VPN'}
      canToggle={row => baseRuleTag(rules[Number(row.id)]) !== 'VPN'}
    />
    </>}
  </div>
}

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { apiCall } from '@/lib/api'
import { IconBolt, IconChevronDown, IconChevronUp, IconGripVertical } from '@tabler/icons-react'
import { parse as parseJsonc } from 'jsonc-parser'
import { useEffect, useMemo, useState } from 'react'
import type { Config } from '@/lib/types'
import { RouteIcon, routeLabel } from '@/components/configuration/RouteIcon'
import { GeoDatabasePicker } from '@/components/configuration/GeoDatabasePicker'
import { DeviceTab } from '@/components/configuration/DeviceTab'
import { baseRuleTag, deviceRuleTag, readDeviceIps, routeTags, usesSelector, validDeviceIp, type RouteTag, type RoutingRule } from '@/lib/xrayDeviceRouting'

interface Outbound {
  tag: string
  protocol: string
  xkeenDisplayName?: string
  streamSettings?: { network?: string; method?: string; security?: string }
}

function countryFlag(outbound: Outbound): string {
  const name = `${outbound.xkeenDisplayName ?? ''} ${outbound.tag}`.toLowerCase()
  if (/🇫🇮|finland|финлянд/.test(name)) return '🇫🇮 '
  if (/🇳🇱|netherlands|нидерланд|(?:^|[-_])nl\d?/.test(name)) return '🇳🇱 '
  return ''
}

function outboundTitle(outbound: Outbound): string {
  if (outbound.tag === 'nfqws-direct') return 'nfqws2 · zapret2'
  if (/csqtt/i.test(outbound.tag)) return 'CSQTT'
  if (outbound.tag === 'wdtt-plus') return 'WDTT Plus'
  if (outbound.protocol === 'freedom') return '🔓 Без VPN'
  const protocol = /^(hysteria|hysteria2)$/i.test(outbound.protocol) ? 'Hysteria2' : outbound.protocol.toUpperCase()
  return `${countryFlag(outbound)}${protocol}`
}

function outboundTransport(outbound: Outbound): string {
  if (outbound.tag === 'nfqws-direct') return 'Прямой WAN через nfqws2'
  if (/csqtt/i.test(outbound.tag)) return 'Интерфейс csqtt0'
  if (outbound.tag === 'wdtt-plus') return 'Локальный SOCKS5 · TCP / UDP'
  if (outbound.protocol === 'freedom') return 'Прямое соединение'
  if (outbound.protocol === 'hysteria' || outbound.protocol === 'hysteria2') return 'Hysteria2 · TLS / QUIC'
  if (outbound.protocol === 'tuic') return 'TUIC · TLS / QUIC'
  const network = (outbound.streamSettings?.network ?? outbound.streamSettings?.method)?.toLowerCase()
  const security = outbound.streamSettings?.security?.toUpperCase()
  if (outbound.protocol === 'vless') {
    const transport = network === 'xhttp' ? 'XHTTP' : network === 'tcp' || network === 'raw' ? 'TCP' : network?.toUpperCase()
    return ['VLESS', transport, security].filter(Boolean).join(' · ').replace(' · REALITY', ' / REALITY').replace(' · TLS', ' / TLS') || 'VLESS · транспорт не указан'
  }
  return [network?.toUpperCase(), security].filter(Boolean).join(' / ') || 'Транспорт не указан'
}

const protocolOrderKey = 'xkeen-xray-protocol-card-order'
let automaticPingStarted = false

function defaultProtocolRank(tag: string): number {
  if (tag === 'direct') return 0
  if (tag === 'nfqws-direct' || tag === '@nfqws2') return 1
  if (/csqtt/i.test(tag) || tag === '@missing-csqtt') return 3
  if (tag === 'wdtt-plus') return 4
  if (tag === '@selector') return 5
  return 2
}

export function XraySelectorsPanel({ config, onSelect, onDeviceSelect, onAddRoute, onAddIpRoute, onEditResources, onRemoveRoute, onRenameRoute, onExtendRoute, onReorder }: {
  config: Config
  onSelect: (file: string, ruleIndex: number, outboundTag: string) => Promise<void>
  onDeviceSelect: (file: string, ip: string, route: RouteTag | null, outboundTag?: string) => Promise<void>
  onAddRoute: (file: string, name: string, domains: string[]) => Promise<boolean>
  onAddIpRoute: (file: string, name: string, ips: string[]) => Promise<boolean>
  onEditResources: (file: string, tag: string, values: string[]) => Promise<boolean>
  onRemoveRoute: (file: string, tag: string) => Promise<void>
  onRenameRoute: (file: string, tag: string, name: string) => Promise<boolean>
  onExtendRoute: (file: string, tag: string, domains: string[]) => Promise<boolean>
  onReorder: (file: string, order: number[]) => Promise<boolean>
}) {
  const [pending, setPending] = useState<string | null>(null)
  const [deviceIp, setDeviceIp] = useState('')
  const [newIp, setNewIp] = useState('')
  const [addingRoute, setAddingRoute] = useState(false)
  const [routeName, setRouteName] = useState('')
  const [resourceKind, setResourceKind] = useState<'domain' | 'ip'>('domain')
  const [newIpResources, setNewIpResources] = useState('')
  const [editingTag, setEditingTag] = useState('')
  const [resourceText, setResourceText] = useState('')
  const [editDomainResources, setEditDomainResources] = useState<string[]>([])
  const [newDomainResources, setNewDomainResources] = useState<string[]>([])
  const [testingTag, setTestingTag] = useState<string | null>(null)
  const [testingAll, setTestingAll] = useState(false)
  const [testingRoute, setTestingRoute] = useState('')
  const [latencies, setLatencies] = useState<Record<string, { ms?: number; error?: string }>>({})
  const [collapsedRoutes, setCollapsedRoutes] = useState<Record<string, boolean>>({})
  const [renamingTag, setRenamingTag] = useState('')
  const [renamingName, setRenamingName] = useState('')
  const [draggedCard, setDraggedCard] = useState<string | null>(null)
  const [draggedProtocol, setDraggedProtocol] = useState<string | null>(null)
  const [protocolOrder, setProtocolOrder] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(protocolOrderKey) ?? '[]')
      return Array.isArray(saved) ? saved.filter((tag): tag is string => typeof tag === 'string') : []
    } catch { return [] }
  })
  const [nfqwsCanary, setNfqwsCanary] = useState<{ installed: boolean; running: boolean; device: string; strategyMode: 'tcp' | 'tcp-quic'; mode: string } | null>(null)
  useEffect(() => {
    let mounted = true
    void apiCall<{ installed: boolean; running: boolean; device: string; strategyMode: 'tcp' | 'tcp-quic'; mode: string }>('GET', 'nfqws2/status')
      .then((status) => { if (mounted) setNfqwsCanary(status) }).catch(() => {})
    return () => { mounted = false }
  }, [])
  const parsed = useMemo(() => {
    try {
      const value = parseJsonc(config.savedContent) as { outbounds?: Outbound[]; routing?: { rules?: RoutingRule[]; balancers?: Array<{ tag: string }> } }
      const outbounds = (value.outbounds ?? []).filter((item) => item.tag && (['vless', 'hysteria', 'hysteria2', 'tuic'].includes(item.protocol.toLowerCase()) || item.tag === 'direct' || item.tag === 'nfqws-direct' || /csqtt/i.test(item.tag) || item.tag === 'wdtt-plus'))
      const rules: (RoutingRule & { index: number })[] = (value.routing?.rules ?? []).map((rule, index) => ({ ...rule, index }))
      return { outbounds, rules, devices: readDeviceIps(rules) }
    } catch {
      return { outbounds: [], rules: [], devices: [] }
    }
  }, [config.savedContent])
  const globalDirect = parsed.rules.some((rule) => baseRuleTag(rule) === 'VPN' && rule.outboundTag === 'direct')
  const globalCsqtt = parsed.rules.some((rule) => baseRuleTag(rule) === 'VPN' && rule.outboundTag?.toLowerCase() === 'csqtt')
  const globalWdtt = parsed.rules.some((rule) => baseRuleTag(rule) === 'VPN' && rule.outboundTag?.toLowerCase() === 'wdtt-plus')
  const globalLocked = globalDirect || globalCsqtt || globalWdtt
  const activeDevice = parsed.devices.includes(deviceIp) ? deviceIp : ''
  const activeDeviceDirect = !!activeDevice && parsed.rules.some((rule) => baseRuleTag(rule) === deviceRuleTag(activeDevice, 'VPN') && rule.outboundTag === 'direct')
  const activeDeviceCsqtt = !!activeDevice && parsed.rules.some((rule) => baseRuleTag(rule) === deviceRuleTag(activeDevice, 'VPN') && rule.outboundTag?.toLowerCase() === 'csqtt')
  const activeDeviceWdtt = !!activeDevice && parsed.rules.some((rule) => baseRuleTag(rule) === deviceRuleTag(activeDevice, 'VPN') && rule.outboundTag?.toLowerCase() === 'wdtt-plus')
  const activeDeviceLocked = activeDeviceDirect || activeDeviceCsqtt || activeDeviceWdtt
  const deviceRoutes = activeDevice ? parsed.rules.flatMap((rule) => {
    const match = /^device:[^:]+:(.+)$/.exec(baseRuleTag(rule))
    return match && baseRuleTag(rule).startsWith(`device:${activeDevice}:`) ? [match[1]] : []
  }).filter((tag, index, all) => all.indexOf(tag) === index) : []
  const matchingRoute = routeTags(parsed.rules).find((tag) => routeLabel(tag).toLowerCase() === routeName.trim().toLowerCase())
  const matchingRule = parsed.rules.find((rule) => baseRuleTag(rule) === matchingRoute)
  const matchingKind = matchingRule && Array.isArray(matchingRule.ip) && !Array.isArray(matchingRule.domain) ? 'ip' : 'domain'
  const resourceLines = (text: string) => text.split(/[\r\n,]+/).map((value) => value.trim()).filter(Boolean)
  const pingTargets = parsed.outbounds.filter((outbound) => outbound.tag.startsWith('sub-') || outbound.tag === 'direct' || outbound.tag === 'nfqws-direct' || /csqtt/i.test(outbound.tag) || outbound.tag === 'wdtt-plus')
  const pingTargetKey = pingTargets.map((outbound) => outbound.tag).join('|')
  const visibleRoutes = activeDevice
    ? activeDeviceLocked ? ['VPN'] : ['VPN', ...deviceRoutes.filter((tag) => tag !== 'VPN')]
    : globalLocked ? ['VPN'] : ['VPN', ...routeTags(parsed.rules).filter((tag) => tag !== 'VPN')]

  function moveProtocol(source: string, target: string, visible: string[]) {
    if (!source || source === target || pending !== null) return
    const order = [...visible]
    const from = order.indexOf(source)
    const to = order.indexOf(target)
    if (from < 0 || to < 0) return
    order.splice(from, 1)
    order.splice(to, 0, source)
    const next = [...order, ...protocolOrder.filter((tag) => !order.includes(tag))]
    setProtocolOrder(next)
    try { window.localStorage.setItem(protocolOrderKey, JSON.stringify(next)) } catch { /* Storage may be unavailable. */ }
  }

  async function reorderCard(source: string, target: string) {
    if (!source || source === target || source === 'VPN' || target === 'VPN' || pending !== null) return
    const movable = visibleRoutes.filter((tag) => tag !== 'VPN')
    const sourceRank = movable.indexOf(source)
    const targetRank = movable.indexOf(target)
    if (sourceRank < 0 || targetRank < 0) return
    const slots = movable.map((tag) => parsed.rules.findIndex((rule) => baseRuleTag(rule) === (activeDevice ? deviceRuleTag(activeDevice, tag) : tag)))
    if (slots.some((index) => index < 0)) return
    const changed = [...movable]
    const [moved] = changed.splice(sourceRank, 1)
    changed.splice(targetRank, 0, moved)
    const order = parsed.rules.map((_, index) => index)
    changed.forEach((tag, rank) => { order[slots[rank]] = parsed.rules.findIndex((rule) => baseRuleTag(rule) === (activeDevice ? deviceRuleTag(activeDevice, tag) : tag)) })
    setPending('reorder')
    try { await onReorder(config.file, order) } finally { setPending(null) }
  }

  async function dropCard(target: string) {
    const source = draggedCard
    setDraggedCard(null)
    if (source) await reorderCard(source, target)
  }

  async function change(route: RouteTag, tag: string, index: number) {
    setPending(`${activeDevice}:${route}`)
    try {
      if (activeDevice) await onDeviceSelect(config.file, activeDevice, route, tag)
      else await onSelect(config.file, index, tag)
    } finally { setPending(null) }
  }

  async function addDevice() {
    const ip = newIp.trim()
    if (!validDeviceIp(ip) || parsed.devices.includes(ip)) return
    const vpn = parsed.rules.find((rule) => baseRuleTag(rule) === 'VPN')
    if (!vpn?.outboundTag && !vpn?.balancerTag) return
    setPending(`add:${ip}`)
    try {
      await onDeviceSelect(config.file, ip, 'VPN', '@selector')
      setDeviceIp(ip)
      setNewIp('')
    } finally { setPending(null) }
  }

  async function testOutbound(tag: string) {
    setTestingTag(tag)
    try {
      const result = await apiCall<{ success: boolean; latencyMs?: number; error?: string }>('POST', 'xray/latency', { tag })
      setLatencies((current) => ({ ...current, [tag]: result.success && result.latencyMs !== undefined ? { ms: result.latencyMs } : { error: result.error || 'Нет ответа' } }))
    } catch (error) {
      setLatencies((current) => ({ ...current, [tag]: { error: error instanceof Error ? error.message : 'Нет ответа' } }))
    } finally { setTestingTag(null) }
  }

  async function testAllOutbounds(route: string) {
    setTestingRoute(route)
    setTestingAll(true)
    try {
      for (const outbound of pingTargets) await testOutbound(outbound.tag)
    } finally { setTestingAll(false); setTestingRoute('') }
  }

  useEffect(() => {
    if (automaticPingStarted || !pingTargetKey) return
    automaticPingStarted = true
    void testAllOutbounds('auto')
  }, [pingTargetKey])

  return (
    <div className="absolute inset-0 overflow-y-auto p-4">
      <div className="bg-card z-20 mb-4 flex shrink-0 flex-wrap items-center gap-2 border-b pb-3">
        <Button size="sm" variant={!activeDevice ? 'default' : 'outline'} onClick={() => setDeviceIp('')}>Общая маршрутизация</Button>
        {parsed.devices.map((ip) => <DeviceTab key={ip} ip={ip} selected={activeDevice === ip} disabled={pending !== null} onSelect={() => setDeviceIp(ip)} onRemove={async () => { setPending('remove'); try { await onDeviceSelect(config.file, ip, null); if (activeDevice === ip) setDeviceIp('') } finally { setPending(null) } }} />)}
        <Button size="icon-sm" variant="outline" className="ml-auto" aria-label={Object.values(collapsedRoutes).some((value) => value) ? 'Развернуть все маршруты' : 'Свернуть все маршруты'} onClick={() => {
          const collapse = !Object.values(collapsedRoutes).some((value) => value)
          setCollapsedRoutes(Object.fromEntries(['VPN', ...routeTags(parsed.rules)].map((route) => [route, collapse])))
        }}>{Object.values(collapsedRoutes).some((value) => value) ? <IconChevronDown size={16} /> : <IconChevronUp size={16} />}</Button>
      </div>
      {<div className="border-border mb-4 flex shrink-0 flex-wrap items-center gap-2 border-b pb-3">
        <span className="text-sm font-medium">Маршрутизация для устройства</span>
        <Input className="max-w-44" value={newIp} onChange={(event) => setNewIp(event.target.value)} placeholder="192.168.0.20" aria-label="IP устройства" />
        <Button size="sm" disabled={!validDeviceIp(newIp) || parsed.devices.includes(newIp.trim()) || pending !== null} onClick={() => void addDevice()}>Добавить IP</Button>
      </div>}
      <div className="space-y-4">
      {!(activeDevice ? activeDeviceLocked : globalLocked) && <div className="border-border mb-4 border-b pb-3">
        <Button size="sm" variant="outline" onClick={() => setAddingRoute(true)}>+ Добавить маршрут</Button>
        <Dialog open={addingRoute} onOpenChange={setAddingRoute}><DialogContent className="max-w-[min(94vw,680px)]! max-h-[85dvh] overflow-y-auto"><DialogHeader><DialogTitle>Новый маршрут</DialogTitle></DialogHeader><div className="flex flex-col gap-4">
          <p className="text-muted-foreground text-xs">Новый маршрут появится в общей и выборочной маршрутизации всех устройств. Выход для каждого устройства можно выбрать отдельно.</p>
<label className="space-y-2 text-sm font-medium">Название маршрута<Input value={routeName} onChange={(event) => setRouteName(event.target.value)} placeholder="Например, Работа или Видеосервисы" aria-label="Название маршрута" maxLength={40} /></label>
          <div className="flex gap-2" aria-label="Тип ресурсов">
            <Button size="sm" variant={resourceKind === 'domain' ? 'default' : 'outline'} onClick={() => setResourceKind('domain')}>Домены</Button>
            <Button size="sm" variant={resourceKind === 'ip' ? 'default' : 'outline'} onClick={() => setResourceKind('ip')}>IP-диапазоны</Button>
          </div>
          {resourceKind === 'domain' ? <GeoDatabasePicker kind="domain" resources={newDomainResources} onChange={setNewDomainResources} onPick={(name) => setRouteName((current) => current || name)} /> : <>
            <p className="text-muted-foreground text-xs">Выберите готовый IP-список или введите несколько IPv4/CIDR, по одному в строке.</p>
            <GeoDatabasePicker kind="ip" resources={resourceLines(newIpResources)} onChange={values => setNewIpResources(values.join("\n"))} />
            <Textarea value={newIpResources} onChange={(event) => setNewIpResources(event.target.value)} rows={5} aria-label="IP-адреса и диапазоны" placeholder={'203.0.113.0/24\n198.51.100.7'} />
          </>}
          {matchingRoute && matchingKind !== resourceKind && <p className="text-amber-400 text-xs">Это название уже занято маршрутом другого типа. Укажи другое название.</p>}
          <Button size="sm" disabled={pending !== null || !routeName.trim() || (!!matchingRoute && matchingKind !== resourceKind) || (resourceKind === 'domain' ? newDomainResources.length === 0 || newDomainResources.length > 30 : resourceLines(newIpResources).length === 0 || resourceLines(newIpResources).length > 30)} onClick={async () => { setPending('add-route'); try {
            const saved = resourceKind === 'domain'
              ? await (matchingRoute ? onExtendRoute(config.file, matchingRoute, newDomainResources) : onAddRoute(config.file, routeName, newDomainResources))
              : matchingRoute ? await onEditResources(config.file, matchingRoute, [...(matchingRule?.ip ?? []), ...resourceLines(newIpResources)]) : await onAddIpRoute(config.file, routeName, resourceLines(newIpResources))
            if (saved) { setRouteName(''); setNewDomainResources([]); setNewIpResources('');  setAddingRoute(false) }
          } finally { setPending(null) } }}>{matchingRoute ? 'Добавить ресурсы в маршрут' : 'Создать маршрут'}</Button>
        </div></DialogContent></Dialog>
      </div>}
      <p className="text-muted-foreground mb-4 text-sm">
        {activeDeviceDirect ? `Для ${activeDevice} включён полный обход перехвата: весь трафик идёт напрямую. Правила сервисов скрыты и не применяются.` : activeDeviceCsqtt || activeDeviceWdtt ? `Весь трафик ${activeDevice} направлен через ${activeDeviceWdtt ? 'WDTT Plus' : 'CSQTT'}. Правила сервисов скрыты и не применяются, пока выбран этот общий маршрут.` : activeDevice ? `Показаны только правила ${activeDevice}. Перетащите карточку или используйте стрелки, чтобы изменить приоритет.` : globalDirect ? 'По умолчанию трафик идёт напрямую. Индивидуальный выбор VPN для устройств имеет приоритет.' : globalCsqtt || globalWdtt ? `Общий ${globalWdtt ? 'WDTT Plus' : 'CSQTT'} задаёт маршрут по умолчанию. Индивидуальные настройки устройств имеют приоритет.` : 'Правила сервисов применяются по порядку 1, 2, 3… Селектор −1 служит общим маршрутом для остального трафика. Перетащите карточку или используйте стрелки, чтобы изменить приоритет.'}
      </p>
      <div className="text-muted-foreground mb-4 flex flex-wrap items-center gap-2 text-xs">
        <span>Карточки подключений можно перетаскивать мышью. Их порядок сохраняется в этом браузере.</span>
        {protocolOrder.length > 0 && <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => { setProtocolOrder([]); try { window.localStorage.removeItem(protocolOrderKey) } catch { /* Storage may be unavailable. */ } }}>Стандартный порядок</Button>}
      </div>
      {!parsed.outbounds.some((outbound) => outbound.protocol !== 'freedom') && <p className="text-muted-foreground mb-4 text-sm">Добавьте подписку или Xray outbound, чтобы появились карточки прокси.</p>}
      <div className="flex flex-col gap-4">
        {visibleRoutes.map((route) => {
          const global = parsed.rules.find((rule) => baseRuleTag(rule) === route)
          if (!global) return null
          const routeResourceKind = Array.isArray(global.ip) && !Array.isArray(global.domain) ? 'ip' : 'domain'
          const specific = activeDevice ? parsed.rules.find((rule) => baseRuleTag(rule) === deviceRuleTag(activeDevice, route)) : undefined
          const inherited = !!activeDevice && !specific && route !== 'VPN'
          const selectedRule = specific ?? global
          const selected = selectedRule.ruleTag?.endsWith('|nfqws2') ? '@nfqws2' : usesSelector(selectedRule) ? '@selector' : selectedRule.outboundTag ?? (selectedRule.balancerTag ? `@balancer:${selectedRule.balancerTag}` : undefined)
          const subscribed = parsed.outbounds.filter((outbound) => outbound.tag.startsWith('sub-'))
          const base = subscribed.length ? parsed.outbounds.filter((outbound) => outbound.tag.startsWith('sub-') || outbound.tag === 'direct' || outbound.tag === 'nfqws-direct' || /csqtt/i.test(outbound.tag) || outbound.tag === 'wdtt-plus') : parsed.outbounds
          const primary = parsed.outbounds.filter((outbound) => base.includes(outbound) || outbound.tag === selected)
          const primaryByTag = new Map(primary.map((outbound) => [outbound.tag, outbound]))
          const showSelector = route !== 'VPN' || !!activeDevice
          const showCanary = route === 'VPN' && nfqwsCanary?.installed && nfqwsCanary.mode !== 'global' && activeDevice === nfqwsCanary.device
          const showMissingCsqtt = !parsed.outbounds.some((outbound) => /csqtt/i.test(outbound.tag))
          const defaultCards = [...primary.map((outbound) => outbound.tag), ...(showCanary ? ['@nfqws2'] : []), ...(showMissingCsqtt ? ['@missing-csqtt'] : []), ...(showSelector ? ['@selector'] : [])]
            .sort((a, b) => defaultProtocolRank(a) - defaultProtocolRank(b))
          const orderedCards = protocolOrder.length
            ? [...protocolOrder.filter((tag) => defaultCards.includes(tag)), ...defaultCards.filter((tag) => !protocolOrder.includes(tag))]
            : defaultCards
          const card = (outbound: Outbound) => <div key={outbound.tag} className={cn('relative rounded-md border text-sm transition-colors', selected === outbound.tag ? 'border-blue-400 bg-blue-500/20' : 'border-ring/40 hover:border-blue-400 hover:bg-blue-500/10')}>
            <button type="button" disabled={pending !== null} aria-pressed={selected === outbound.tag}
              onClick={() => { if (selected !== outbound.tag || (activeDevice && !specific)) void change(route, outbound.tag, global.index) }}
              className="flex min-h-22 w-full flex-col justify-between px-3 py-2.5 pr-12 text-left disabled:opacity-60">
              <span className="font-medium">{outboundTitle(outbound)}</span>
              <span className="text-muted-foreground text-xs">{route === 'VPN' && outbound.tag === 'direct' ? 'Полный обход перехвата · напрямую' : outbound.tag === 'nfqws-direct' ? `Прямой WAN · ${nfqwsCanary?.strategyMode === 'tcp' ? 'TCP' : 'TCP + QUIC'}` : outboundTransport(outbound)}</span>
            </button>
            <button type="button" disabled={testingTag !== null || testingAll} aria-label={`Проверить соединение через ${outboundTitle(outbound)}`} title={latencies[outbound.tag]?.error ?? 'Проверить соединение через узел'}
              onClick={() => void testOutbound(outbound.tag)} className={cn('absolute right-2 top-2 rounded p-1 text-xs font-medium tabular-nums hover:bg-blue-500/20 disabled:opacity-50', latencies[outbound.tag]?.ms !== undefined ? 'text-green-400' : latencies[outbound.tag]?.error ? 'text-red-400' : 'text-sky-400')}>
              {testingTag === outbound.tag ? '…' : latencies[outbound.tag]?.ms !== undefined ? `${latencies[outbound.tag].ms} мс` : latencies[outbound.tag]?.error ? '✕' : <IconBolt size={17} />}
            </button>
          </div>
          return (
            <section key={route} onDragOver={(event) => { if (route !== 'VPN' && draggedCard && pending === null) { event.preventDefault(); event.dataTransfer.dropEffect = 'move' } }} onDrop={(event) => { event.preventDefault(); void dropCard(route) }} className={cn('border-border bg-input-background rounded-xl border p-4', draggedCard && route !== 'VPN' && 'hover:border-blue-400 hover:bg-blue-500/10')}>
              <div className="mb-2 flex items-center gap-2 text-[15px] font-medium">
                <span className="text-muted-foreground flex w-7 shrink-0 justify-center rounded border px-1 py-0.5 text-xs tabular-nums">{route === 'VPN' ? '−1' : visibleRoutes.indexOf(route)}</span>
                {route !== 'VPN' && !inherited && <span draggable={pending === null} onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', route); setDraggedCard(route) }} onDragEnd={() => setDraggedCard(null)} className="text-muted-foreground flex cursor-grab items-center rounded p-1 active:cursor-grabbing" title={`Перетащить ${routeLabel(route)}`} aria-label={`Перетащить ${routeLabel(route)}`}><IconGripVertical size={19} /></span>}
                {route !== 'VPN' && <div className="flex shrink-0 items-center gap-1" aria-label={`Порядок маршрута ${routeLabel(route)}`}>
                  <Button size="sm" variant="outline" className="h-8 px-2 text-xs" disabled={pending !== null || inherited || visibleRoutes.indexOf(route) <= 1} aria-label={`Поднять ${routeLabel(route)}`} onClick={() => void reorderCard(route, visibleRoutes[visibleRoutes.indexOf(route) - 1])}>↑ <span className="hidden sm:inline">Выше</span></Button>
                  <Button size="sm" variant="outline" className="h-8 px-2 text-xs" disabled={pending !== null || inherited || visibleRoutes.indexOf(route) >= visibleRoutes.length - 1} aria-label={`Опустить ${routeLabel(route)}`} onClick={() => void reorderCard(route, visibleRoutes[visibleRoutes.indexOf(route) + 1])}>↓ <span className="hidden sm:inline">Ниже</span></Button>
                </div>}
                <RouteIcon route={route} />{routeLabel(route)}
                <div className="ml-auto flex items-center gap-2">
                  <Button size="icon-sm" variant="outline" aria-label={collapsedRoutes[route] ? `Развернуть ${routeLabel(route)}` : `Свернуть ${routeLabel(route)}`} onClick={() => setCollapsedRoutes((current) => ({ ...current, [route]: !current[route] }))}>{collapsedRoutes[route] ? <IconChevronDown size={16} /> : <IconChevronUp size={16} />}</Button>
                  {route !== 'VPN' && <Button size="sm" variant="outline" disabled={pending !== null} title="Ресурсы этого маршрута общие для всех устройств" onClick={() => { setEditingTag(route); setResourceText(global.ip?.join('\n') ?? ''); setEditDomainResources(global.domain ?? []); }}>Ресурсы</Button>}
                  {route.startsWith('custom:') && <Button size="sm" variant="outline" disabled={pending !== null} title="Название маршрута общее для всех устройств" onClick={() => { setRenamingTag(route); setRenamingName(routeLabel(route)) }}>Переименовать</Button>}
                  {route !== 'VPN' && <Button size="sm" variant="outline" disabled={pending !== null} title="Удалит маршрут у всех устройств" onClick={() => { if (window.confirm(`Удалить маршрут «${routeLabel(route)}» для всех устройств?`)) void onRemoveRoute(config.file, route) }}>Удалить маршрут</Button>}
                  <Button size="sm" variant="outline" disabled={testingTag !== null || testingAll || pingTargets.length === 0} aria-label={`Пинг ${routeLabel(route)}`} title="HTTP GET через подключения этого правила" onClick={() => void testAllOutbounds(route)}><IconBolt size={16} /> {testingRoute === route ? 'Пинг…' : 'Пинг'}</Button>
                </div>
              </div>
              <Dialog open={editingTag === route} onOpenChange={(open) => { if (!open) setEditingTag('') }}><DialogContent className="max-w-[min(94vw,680px)]! max-h-[85dvh] overflow-y-auto"><DialogHeader><DialogTitle>Ресурсы: {routeLabel(route)}</DialogTitle></DialogHeader>
                <p className="text-muted-foreground text-xs">Этот набор ресурсов используется в общей и выборочной маршрутизации всех устройств.</p>
                {routeResourceKind === 'domain' ? <GeoDatabasePicker kind="domain" resources={editDomainResources} onChange={setEditDomainResources} /> : <>
                  <p className="text-muted-foreground text-sm">Выбери готовый IP-список или укажи IPv4/CIDR, по одному в строке.</p>
            <GeoDatabasePicker kind="ip" resources={resourceLines(resourceText)} onChange={values => setResourceText(values.join("\n"))} />
                  <Textarea value={resourceText} onChange={(event) => setResourceText(event.target.value)} rows={8} aria-label="IP-адреса и диапазоны маршрута" />
                </>}
                <div className="flex justify-end gap-2"><Button size="sm" variant="outline" onClick={() => setEditingTag('')}>Отмена</Button><Button size="sm" disabled={pending !== null || (routeResourceKind === 'domain' ? editDomainResources.length === 0 || editDomainResources.length > 30 : resourceLines(resourceText).length === 0 || resourceLines(resourceText).length > 30)} onClick={async () => { setPending(`resources:${route}`); try { if (await onEditResources(config.file, route, routeResourceKind === 'domain' ? editDomainResources : resourceLines(resourceText))) setEditingTag('') } finally { setPending(null) } }}>Сохранить ресурсы</Button></div>
              </DialogContent></Dialog>
              {renamingTag === route && <div className="mb-3 flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground text-xs">Название изменится для всех устройств.</span>
                <Input className="max-w-64" value={renamingName} maxLength={40} onChange={(event) => setRenamingName(event.target.value)} aria-label="Новое название маршрута" />
                <Button size="sm" disabled={pending !== null || !renamingName.trim()} onClick={async () => { setPending(`rename:${route}`); try { if (await onRenameRoute(config.file, route, renamingName)) { setRenamingTag(''); setRenamingName('') } } finally { setPending(null) } }}>Сохранить</Button>
                <Button size="sm" variant="outline" onClick={() => { setRenamingTag(''); setRenamingName('') }}>Отмена</Button>
              </div>}
              <div className="text-muted-foreground mb-3 text-sm">
                {activeDevice && !specific ? 'Как в общей маршрутизации' : selected?.startsWith('@balancer:') ? 'В старой конфигурации выбран Автовыбор. Выберите узел ниже.' : `Выбрано: ${selected === '@selector' ? 'Селектор' : selected === '@nfqws2' ? 'nfqws2 · прямой выход' : selected === 'direct' ? 'Без VPN' : parsed.outbounds.find((outbound) => outbound.tag === selected)?.xkeenDisplayName ?? selected ?? 'не выбрано'}`}
              </div>
              {route === 'Games' && <p className="text-muted-foreground mb-3 text-xs">Правило охватывает указанные домены. Соединения игры с IP-серверами могут идти по общему маршруту.</p>}
              {!collapsedRoutes[route] && route !== 'VPN' && <details className="text-muted-foreground mb-3 text-xs"><summary className="cursor-pointer">Что входит в маршрут</summary><div className="mt-1 break-words">{routeResourceKind === 'ip' ? 'IP-диапазоны' : 'Домены'}: {(routeResourceKind === 'ip' ? global.ip : global.domain)?.join(', ') || 'не заданы'}</div></details>}
              {!collapsedRoutes[route] && <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
                {orderedCards.map((tag) => <div key={tag} draggable={pending === null} title="Перетащить карточку, чтобы изменить порядок в этом браузере"
                  onDragStart={(event) => { event.stopPropagation(); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', tag); setDraggedProtocol(tag) }}
                  onDragOver={(event) => { event.stopPropagation(); if (draggedProtocol) { event.preventDefault(); event.dataTransfer.dropEffect = 'move' } }}
                  onDrop={(event) => { event.preventDefault(); event.stopPropagation(); if (draggedProtocol) moveProtocol(draggedProtocol, tag, orderedCards); setDraggedProtocol(null) }}
                  onDragEnd={(event) => { event.stopPropagation(); setDraggedProtocol(null) }}
                  className={cn('cursor-grab active:cursor-grabbing', draggedProtocol === tag && 'opacity-60')}>
                  {tag === '@selector' ? <button type="button" disabled={pending !== null} aria-pressed={selected === '@selector'} onClick={() => { if (selected !== '@selector' || (activeDevice && !specific)) void change(route, '@selector', global.index) }} className={cn('flex min-h-22 w-full flex-col justify-between rounded-md border px-3 py-2.5 text-left text-sm', selected === '@selector' ? 'border-blue-400 bg-blue-500/20' : 'border-ring/40 hover:border-blue-400 hover:bg-blue-500/10')}><span className="font-medium">🌐 Селектор</span><span className="text-muted-foreground text-xs">Общий выбор протокола</span></button>
                    : tag === '@nfqws2' ? <button type="button" disabled={pending !== null} aria-pressed={selected === '@nfqws2'} onClick={() => void change(route, '@nfqws2', global.index)} className={cn('flex min-h-22 w-full flex-col justify-between rounded-md border px-3 py-2.5 text-left text-sm', selected === '@nfqws2' ? 'border-blue-400 bg-blue-500/20' : 'border-ring/40 hover:border-blue-400 hover:bg-blue-500/10')}><span className="font-medium">nfqws2 · zapret2</span><span className="text-muted-foreground text-xs">Прямой WAN через nfqws2 · только {nfqwsCanary?.device}. Сохраните маршрут для применения.</span></button>
                    : tag === '@missing-csqtt' ? <div className="border-ring/30 text-muted-foreground flex min-h-22 flex-col justify-between rounded-md border border-dashed px-3 py-2.5 text-sm"><span className="font-medium">CSQTT</span><span className="text-xs">Локальный выход не настроен</span></div>
                    : primaryByTag.has(tag) ? card(primaryByTag.get(tag)!) : null}
                </div>)}
              </div>
              {activeDevice && specific && route !== 'VPN' && <Button size="sm" variant="ghost" disabled={pending !== null} className="mt-2" onClick={() => void onDeviceSelect(config.file, activeDevice, route, '')}>Вернуть общую настройку</Button>}
              </>}
            </section>
          )
        })}
      </div>
      </div>
    </div>
  )
}

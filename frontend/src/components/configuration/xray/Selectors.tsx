import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { apiCall } from '@/lib/api'
import { IconBolt, IconChevronDown, IconChevronUp, IconGripVertical } from '@tabler/icons-react'
import { parse as parseJsonc } from 'jsonc-parser'
import { useEffect, useMemo, useState } from 'react'
import type { Config } from '@/lib/types'
import { RouteIcon, routeLabel } from '@/components/configuration/RouteIcon'
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
  if (/csqtt/i.test(outbound.tag)) return 'CSQTT'
  if (outbound.tag === 'wdtt-plus') return 'WDTT Plus'
  if (outbound.protocol === 'freedom') return '🔓 Без VPN'
  const protocol = /^(hysteria|hysteria2)$/i.test(outbound.protocol) ? 'Hysteria2' : outbound.protocol.toUpperCase()
  return `${countryFlag(outbound)}${protocol}`
}

function outboundTransport(outbound: Outbound): string {
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

const categoryLabels: Record<string, string> = { youtube: 'YouTube', discord: 'Discord', telegram: 'Telegram', github: 'GitHub' }
const aiDomains = ['geosite:openai', 'geosite:anthropic', 'geosite:perplexity', 'domain:gemini.google.com', 'domain:aistudio.google.com']

export function XraySelectorsPanel({ config, onSelect, onDeviceSelect, onAddRoute, onRemoveRoute, onRenameRoute, onExtendRoute, onReorder }: {
  config: Config
  onSelect: (file: string, ruleIndex: number, outboundTag: string) => Promise<void>
  onDeviceSelect: (file: string, ip: string, route: RouteTag | null, outboundTag?: string) => Promise<void>
  onAddRoute: (file: string, name: string, domains: string[]) => Promise<boolean>
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
  const [categorySearch, setCategorySearch] = useState('')
  const [selectedCategory, setSelectedCategory] = useState('')
  const [categories, setCategories] = useState<Array<{ name: string; count: number }>>([])
  const [categoryError, setCategoryError] = useState('')
  const [testingTag, setTestingTag] = useState<string | null>(null)
  const [testingAll, setTestingAll] = useState(false)
  const [testingRoute, setTestingRoute] = useState('')
  const [latencies, setLatencies] = useState<Record<string, { ms?: number; error?: string }>>({})
  const [collapsedRoutes, setCollapsedRoutes] = useState<Record<string, boolean>>({})
  const [renamingTag, setRenamingTag] = useState('')
  const [renamingName, setRenamingName] = useState('')
  const [draggedCard, setDraggedCard] = useState<string | null>(null)
  const parsed = useMemo(() => {
    try {
      const value = parseJsonc(config.savedContent) as { outbounds?: Outbound[]; routing?: { rules?: RoutingRule[]; balancers?: Array<{ tag: string }> } }
      const outbounds = (value.outbounds ?? []).filter((item) => item.tag && (['vless', 'hysteria', 'hysteria2', 'tuic'].includes(item.protocol.toLowerCase()) || item.tag === 'direct' || /csqtt/i.test(item.tag) || item.tag === 'wdtt-plus'))
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
  const deviceRoutes = activeDevice ? parsed.rules.flatMap((rule) => {
    const match = /^device:[^:]+:(.+)$/.exec(baseRuleTag(rule))
    return match && baseRuleTag(rule).startsWith(`device:${activeDevice}:`) ? [match[1]] : []
  }).filter((tag, index, all) => all.indexOf(tag) === index) : []
  const matchingRoute = routeTags(parsed.rules).find((tag) => routeLabel(tag).toLowerCase() === routeName.trim().toLowerCase())
  const pingTargets = parsed.outbounds.filter((outbound) => outbound.tag.startsWith('sub-') || outbound.tag === 'direct' || /csqtt/i.test(outbound.tag) || outbound.tag === 'wdtt-plus')
  const visibleRoutes = activeDevice
    ? activeDeviceDirect || activeDeviceCsqtt || activeDeviceWdtt ? ['VPN'] : ['VPN', ...deviceRoutes.filter((tag) => tag !== 'VPN')]
    : globalLocked ? ['VPN'] : ['VPN', ...routeTags(parsed.rules).filter((tag) => tag !== 'VPN')]

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

  useEffect(() => {
    if (!addingRoute) return
    let alive = true
    void apiCall<{ success: boolean; categories?: Array<{ name: string; count: number }>; error?: string }>('GET', 'geo/categories')
      .then((result) => { if (alive) { setCategories(result.categories ?? []); setCategoryError(result.success ? '' : result.error || 'Не удалось загрузить категории') } })
      .catch((error) => { if (alive) setCategoryError(error instanceof Error ? error.message : 'Не удалось загрузить категории') })
    return () => { alive = false }
  }, [addingRoute])

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

  return (
    <div className="absolute inset-0 overflow-y-auto p-4">
      <div className="bg-card z-20 mb-4 flex shrink-0 flex-wrap items-center gap-2 border-b pb-3">
        <Button size="sm" variant={!activeDevice ? 'default' : 'outline'} onClick={() => setDeviceIp('')}>Общая маршрутизация</Button>
        {parsed.devices.map((ip) => <Button key={ip} size="sm" variant={activeDevice === ip ? 'default' : 'outline'} onClick={() => setDeviceIp(ip)}>{ip}</Button>)}
        {activeDevice && <Button size="sm" variant="outline" disabled={pending !== null} onClick={async () => { setPending('remove'); try { await onDeviceSelect(config.file, activeDevice, null); setDeviceIp('') } finally { setPending(null) } }}>Удалить {activeDevice}</Button>}
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
      {!globalLocked && !activeDevice && <div className="border-border mb-4 border-b pb-3">
        <Button size="sm" variant="outline" onClick={() => setAddingRoute(true)}>+ Добавить маршрут</Button>
        <Dialog open={addingRoute} onOpenChange={setAddingRoute}><DialogContent className="max-w-[min(94vw,680px)]! max-h-[85dvh] overflow-y-auto"><DialogHeader><DialogTitle>Новый маршрут</DialogTitle></DialogHeader><div className="flex flex-col gap-4">
<label className="space-y-2 text-sm font-medium">Название маршрута<Input value={routeName} onChange={(event) => setRouteName(event.target.value)} placeholder="Например, Работа или Видеосервисы" aria-label="Название маршрута" maxLength={40} /></label>
          <Input value={categorySearch} onChange={(event) => setCategorySearch(event.target.value)} placeholder="Поиск категории: youtube, telegram, discord…" aria-label="Поиск категории GeoSite" />
          {categoryError && <p role="alert" className="text-sm text-red-400">{categoryError}</p>}
          <div className="border-border max-h-52 overflow-y-auto rounded-md border p-1">
            {(!categorySearch.trim() || 'нейронки ai artificial intelligence'.includes(categorySearch.trim().toLowerCase())) && <button type="button" onClick={() => { setSelectedCategory('ai-bundle'); setRouteName(current => current || 'Нейронки') }} className={cn('flex w-full justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-blue-500/10', selectedCategory === 'ai-bundle' && 'bg-blue-500/20')}><span>Нейронки</span><span className="text-muted-foreground">набор</span></button>}
            {categories.filter((item) => `${item.name} ${categoryLabels[item.name] ?? ''}`.toLowerCase().includes(categorySearch.trim().toLowerCase())).slice(0, 100).map((item) => <button key={item.name} type="button" onClick={() => { setSelectedCategory(item.name); setRouteName(current => current || categoryLabels[item.name] || item.name) }} className={cn('flex w-full justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-blue-500/10', selectedCategory === item.name && 'bg-blue-500/20')}><span>{categoryLabels[item.name] ? `${categoryLabels[item.name]} · ${item.name}` : item.name}</span><span className="text-muted-foreground">{item.count}</span></button>)}
          </div>
          {selectedCategory && <><p className="text-muted-foreground text-xs">Категория {selectedCategory} выбрана. Домены хранятся в базе GeoSite и не загромождают маршрут.</p></>}
          <Button size="sm" disabled={pending !== null || !routeName.trim() || !selectedCategory} onClick={async () => { setPending('add-route'); try { const domains = selectedCategory === 'ai-bundle' ? aiDomains : [`geosite:${selectedCategory}`]; const saved = matchingRoute ? await onExtendRoute(config.file, matchingRoute, domains) : await onAddRoute(config.file, routeName, domains); if (saved) { setRouteName(''); setSelectedCategory(''); setCategorySearch(''); setAddingRoute(false) } } finally { setPending(null) } }}>{matchingRoute ? 'Добавить категорию в маршрут' : 'Создать маршрут'}</Button>
        </div></DialogContent></Dialog>
      </div>}
      <p className="text-muted-foreground mb-4 text-sm">
        {activeDeviceDirect ? `Для ${activeDevice} включён полный обход перехвата: весь трафик идёт напрямую. Правила сервисов этого устройства не применяются.` : activeDeviceCsqtt || activeDeviceWdtt ? `Для ${activeDevice} выбран только ${activeDeviceWdtt ? 'WDTT Plus' : 'CSQTT'}. Правила сервисов этого устройства временно не применяются.` : activeDevice ? `Показаны только правила ${activeDevice}. Перетащите карточку или используйте стрелки, чтобы изменить приоритет.` : globalDirect ? 'По умолчанию трафик идёт напрямую. Индивидуальный выбор VPN для устройств имеет приоритет.' : globalCsqtt || globalWdtt ? `Общий ${globalWdtt ? 'WDTT Plus' : 'CSQTT'} задаёт маршрут по умолчанию. Индивидуальные настройки устройств имеют приоритет.` : 'Правила сервисов применяются по порядку 1, 2, 3… Селектор −1 служит общим маршрутом для остального трафика. Перетащите карточку или используйте стрелки, чтобы изменить приоритет.'}
      </p>
      {!parsed.outbounds.some((outbound) => outbound.protocol !== 'freedom') && <p className="text-muted-foreground mb-4 text-sm">Добавьте подписку или Xray outbound, чтобы появились карточки прокси.</p>}
      <div className="flex flex-col gap-4">
        {visibleRoutes.map((route) => {
          const global = parsed.rules.find((rule) => baseRuleTag(rule) === route)
          if (!global) return null
          const specific = activeDevice ? parsed.rules.find((rule) => baseRuleTag(rule) === deviceRuleTag(activeDevice, route)) : undefined
          if (activeDevice && !specific) return null
          const selectedRule = specific ?? global
          const selected = usesSelector(selectedRule) ? '@selector' : selectedRule.outboundTag ?? (selectedRule.balancerTag ? `@balancer:${selectedRule.balancerTag}` : undefined)
          const subscribed = parsed.outbounds.filter((outbound) => outbound.tag.startsWith('sub-'))
          const base = subscribed.length ? parsed.outbounds.filter((outbound) => outbound.tag.startsWith('sub-') || outbound.tag === 'direct' || /csqtt/i.test(outbound.tag) || outbound.tag === 'wdtt-plus') : parsed.outbounds
          const primary = parsed.outbounds.filter((outbound) => base.includes(outbound) || outbound.tag === selected)
          const card = (outbound: Outbound) => <div key={outbound.tag} className={cn('relative rounded-md border text-sm transition-colors', selected === outbound.tag ? 'border-blue-400 bg-blue-500/20' : 'border-ring/40 hover:border-blue-400 hover:bg-blue-500/10')}>
            <button type="button" disabled={pending !== null} aria-pressed={selected === outbound.tag}
              onClick={() => { if (selected !== outbound.tag || (activeDevice && !specific)) void change(route, outbound.tag, global.index) }}
              className="flex min-h-22 w-full flex-col justify-between px-3 py-2.5 pr-12 text-left disabled:opacity-60">
              <span className="font-medium">{outboundTitle(outbound)}</span>
              <span className="text-muted-foreground text-xs">{route === 'VPN' && outbound.tag === 'direct' ? 'Полный обход перехвата · напрямую' : outboundTransport(outbound)}</span>
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
                {route !== 'VPN' && <span draggable={pending === null} onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', route); setDraggedCard(route) }} onDragEnd={() => setDraggedCard(null)} className="text-muted-foreground flex cursor-grab items-center rounded p-1 active:cursor-grabbing" title={`Перетащить ${routeLabel(route)}`} aria-label={`Перетащить ${routeLabel(route)}`}><IconGripVertical size={19} /></span>}
                {route !== 'VPN' && <div className="flex shrink-0 items-center gap-1" aria-label={`Порядок маршрута ${routeLabel(route)}`}>
                  <Button size="sm" variant="outline" className="h-8 px-2 text-xs" disabled={pending !== null || visibleRoutes.indexOf(route) <= 1} aria-label={`Поднять ${routeLabel(route)}`} onClick={() => void reorderCard(route, visibleRoutes[visibleRoutes.indexOf(route) - 1])}>↑ <span className="hidden sm:inline">Выше</span></Button>
                  <Button size="sm" variant="outline" className="h-8 px-2 text-xs" disabled={pending !== null || visibleRoutes.indexOf(route) >= visibleRoutes.length - 1} aria-label={`Опустить ${routeLabel(route)}`} onClick={() => void reorderCard(route, visibleRoutes[visibleRoutes.indexOf(route) + 1])}>↓ <span className="hidden sm:inline">Ниже</span></Button>
                </div>}
                <RouteIcon route={route} />{routeLabel(route)}
                <div className="ml-auto flex items-center gap-2">
                  <Button size="icon-sm" variant="outline" aria-label={collapsedRoutes[route] ? `Развернуть ${routeLabel(route)}` : `Свернуть ${routeLabel(route)}`} onClick={() => setCollapsedRoutes((current) => ({ ...current, [route]: !current[route] }))}>{collapsedRoutes[route] ? <IconChevronDown size={16} /> : <IconChevronUp size={16} />}</Button>
                  {!activeDevice && route.startsWith('custom:') && <Button size="sm" variant="outline" disabled={pending !== null} onClick={() => { setRenamingTag(route); setRenamingName(routeLabel(route)) }}>Переименовать</Button>}
                  {!activeDevice && route !== 'VPN' && <Button size="sm" variant="outline" disabled={pending !== null} onClick={() => { if (window.confirm(`Удалить маршрут «${routeLabel(route)}» для всех устройств?`)) void onRemoveRoute(config.file, route) }}>Удалить маршрут</Button>}
                  <Button size="sm" variant="outline" disabled={testingTag !== null || testingAll || pingTargets.length === 0} aria-label={`Пинг ${routeLabel(route)}`} title="HTTP GET через подключения этого правила" onClick={() => void testAllOutbounds(route)}><IconBolt size={16} /> {testingRoute === route ? 'Пинг…' : 'Пинг'}</Button>
                </div>
              </div>
              {renamingTag === route && <div className="mb-3 flex flex-wrap items-center gap-2">
                <Input className="max-w-64" value={renamingName} maxLength={40} onChange={(event) => setRenamingName(event.target.value)} aria-label="Новое название маршрута" />
                <Button size="sm" disabled={pending !== null || !renamingName.trim()} onClick={async () => { setPending(`rename:${route}`); try { if (await onRenameRoute(config.file, route, renamingName)) { setRenamingTag(''); setRenamingName('') } } finally { setPending(null) } }}>Сохранить</Button>
                <Button size="sm" variant="outline" onClick={() => { setRenamingTag(''); setRenamingName('') }}>Отмена</Button>
              </div>}
              <div className="text-muted-foreground mb-3 text-sm">
                {activeDevice && !specific ? 'Как в общей маршрутизации' : selected?.startsWith('@balancer:') ? 'В старой конфигурации выбран Автовыбор. Выберите узел ниже.' : `Выбрано: ${selected === '@selector' ? 'Селектор' : selected === 'direct' ? 'Без VPN' : parsed.outbounds.find((outbound) => outbound.tag === selected)?.xkeenDisplayName ?? selected ?? 'не выбрано'}`}
              </div>
              {route === 'Games' && <p className="text-muted-foreground mb-3 text-xs">Правило охватывает указанные домены. Соединения игры с IP-серверами могут идти по общему маршруту.</p>}
              {!collapsedRoutes[route] && route !== 'VPN' && <details className="text-muted-foreground mb-3 text-xs"><summary className="cursor-pointer">Что входит в маршрут</summary><div className="mt-1 break-words">{(global.domain ?? []).join(', ') || 'Домены не заданы'}</div></details>}
              {!collapsedRoutes[route] && <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
                {(route !== 'VPN' || activeDevice) && <button type="button" disabled={pending !== null} aria-pressed={selected === '@selector'} onClick={() => { if (selected !== '@selector' || (activeDevice && !specific)) void change(route, '@selector', global.index) }} className={cn('flex min-h-22 flex-col justify-between rounded-md border px-3 py-2.5 text-left text-sm transition-colors', selected === '@selector' ? 'border-blue-400 bg-blue-500/20' : 'border-ring/40 hover:border-blue-400 hover:bg-blue-500/10')}><span className="font-medium">🌐 Селектор</span><span className="text-muted-foreground text-xs">Общий выбор протокола</span></button>}
                {primary.map(card)}
                {!parsed.outbounds.some((outbound) => /csqtt/i.test(outbound.tag)) && (
                  <div className="border-ring/30 text-muted-foreground flex min-h-22 flex-col justify-between rounded-md border border-dashed px-3 py-2.5 text-sm">
                    <span className="font-medium">CSQTT</span>
                    <span className="text-xs">Локальный выход не настроен</span>
                  </div>
                )}
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

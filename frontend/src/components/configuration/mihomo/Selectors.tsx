import * as yaml from 'js-yaml'
import { DeviceTab } from '@/components/configuration/DeviceTab'
import { readSelections } from '@/lib/mihomoRoutingBackup'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  IconBoltFilled,
  IconGripVertical,
  IconFolder,
  IconPlugX,
} from '@tabler/icons-react'
import { createContext, useContext, useCallback, useEffect, useMemo, useState } from 'react'

import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { apiCall, clashFetch } from '../../../lib/api'
import { fetchClashProxies, useProxiesStore, useAppContext } from '../../../lib/store'
import { defaultMihomoChoices, isMihomoRouteEnabled, readMihomoFullBypass, orderedMihomoRouteTags, readMihomoDevices, readMihomoRouteResources, readMihomoRouteNetwork, type MihomoRouteNetwork } from '../../../lib/mihomoDeviceRouting'
import { RoutingTable, type RoutingRule as TableRule } from '../xray/RoutingTable'
import { resourceLabel } from '@/lib/geoLabels'
import { validDeviceIp, type RouteTag } from '../../../lib/xrayDeviceRouting'
import { routeLabel } from '../RouteIcon'
import { GeoDatabasePicker } from '../GeoDatabasePicker'

interface ProxyHistory {
  time: string
  delay: number
}

interface ProxyInfo {
  name: string
  type: string
  udp: boolean
  uot?: boolean
  xudp?: boolean
  network?: string
  alive: boolean
  hidden?: boolean
  now?: string
  fixed?: string
  all?: string[]
  history: ProxyHistory[]
  'provider-name'?: string
  icon?: string
}

type ClashMode = 'rule' | 'global' | 'direct'

interface Props {
  clashApiPort: string
  mode: ClashMode
  clashApiSecret: string | null
  clashApiUnix?: string | null
  isDraft?: boolean
  configContent: string
  onSelectDraft: (name: string, target: string) => Promise<boolean>
  onDeviceSelect: (ip: string, route: RouteTag | null, target?: string) => Promise<boolean>
  onSaveRoute: (tag: RouteTag | null, name: string, resources: string[], target: string, deviceIp?: string, network?: MihomoRouteNetwork, enabled?: boolean) => Promise<boolean>
  onBulkOutbound: (tags: string[], target: string, deviceIp?: string) => Promise<boolean>
  onImportRoutes: (rules: Array<{ tag: string; name: string; resources: string[]; outbound: string; network?: MihomoRouteNetwork }>) => Promise<boolean>
  onRemoveRoute: (tag: string) => Promise<boolean>
  onReorderRoute: (source: RouteTag, target: RouteTag) => Promise<boolean>
  onToggleRoute: (tag: RouteTag, enabled: boolean, deviceIp?: string) => Promise<boolean>
}

const NO_DELAY_TYPES = new Set(['reject', 'reject-drop', 'dns', 'pass', 'passrule', 'relay'])
function specialPingTag(name: string): string | null {
  if (/^nfqws2 · zapret2$/i.test(name)) return 'nfqws-direct'
  if (/^csqtt$/i.test(name)) return 'CSQTT'
  if (/^wdtt[ -]plus$/i.test(name)) return 'wdtt-plus'
  return null
}
function canProbe(proxy?: ProxyInfo): boolean {
  return !!proxy && (proxy.name === 'DIRECT' || !!specialPingTag(proxy.name) || !NO_DELAY_TYPES.has(proxy.type.toLowerCase()))
}
const SELECTOR_TYPES = new Set(['Selector', 'Fallback', 'URLTest', 'LoadBalance'])
const DEVICE_IP_KEY = 'mihomoDeviceIp'

function fieldResources(resources: string[], kind: 'domain' | 'ip', providerBehaviors: Record<string, string>): string[] {
  const isIp = (value: string) => /^(?:GEOIP|IP-CIDR|IP-CIDR6),/i.test(value) || /^RULE-SET,/i.test(value) && providerBehaviors[value.slice(9)] === 'ipcidr'
  return resources.filter(value => kind === 'ip' ? isIp(value) : !isIp(value)).map(value => {
    const [rule, ...rest] = value.split(',')
    const item = rest.join(',')
    if (rule === 'GEOSITE' || rule === 'GEOIP') return `${rule.toLowerCase()}:${item}`
    if (rule === 'DOMAIN') return `full:${item}`
    if (rule === 'DOMAIN-SUFFIX') return `domain:${item}`
    if (rule === 'DOMAIN-KEYWORD') return `keyword:${item}`
    if (rule === 'IP-CIDR' || rule === 'IP-CIDR6') return item
    return value
  })
}

function parseFieldResources(text: string, kind: 'domain' | 'ip'): string[] {
  const tokens = text.match(/(?:RULE-SET|DOMAIN-SUFFIX|DOMAIN-KEYWORD|DOMAIN|GEOSITE|GEOIP|IP-CIDR6|IP-CIDR),[^,\s]+|[^,\s]+/gi) ?? []
  return tokens.map(value => value.trim()).filter(Boolean).map(value => {
    if (kind === 'ip') {
      if (/^geoip:/i.test(value)) return `GEOIP,${value.slice(6)}`
      if (/^(?:GEOIP|IP-CIDR|IP-CIDR6|RULE-SET),/i.test(value)) return value
      if (/^[\da-f:.]+\/\d+$/i.test(value)) return `${value.includes(':') ? 'IP-CIDR6' : 'IP-CIDR'},${value}`
      throw new Error(`Некорректный IP-ресурс: ${value}`)
    }
    if (/^geosite:/i.test(value)) return `GEOSITE,${value.slice(8)}`
    if (/^full:/i.test(value)) return `DOMAIN,${value.slice(5)}`
    if (/^domain:/i.test(value)) return `DOMAIN-SUFFIX,${value.slice(7)}`
    if (/^keyword:/i.test(value)) return `DOMAIN-KEYWORD,${value.slice(8)}`
    if (/^(?:RULE-SET|DOMAIN|DOMAIN-SUFFIX|DOMAIN-KEYWORD|GEOSITE),/i.test(value)) return value
    if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(value)) return `DOMAIN-SUFFIX,${value}`
    throw new Error(`Некорректный домен: ${value}`)
  })
}

function MihomoResourceFields({ resources, onChange, onValidChange, providerBehaviors }: { resources: string[]; onChange: (resources: string[]) => void; onValidChange: (valid: boolean) => void; providerBehaviors: Record<string, string> }) {
  useEffect(() => { onValidChange(true) }, [onValidChange])
  const [picker, setPicker] = useState<'domain' | 'ip' | null>(null)
  const [domainText, setDomainText] = useState(() => fieldResources(resources, 'domain', providerBehaviors).join(', '))
  const [ipText, setIpText] = useState(() => fieldResources(resources, 'ip', providerBehaviors).join(', '))
  const [error, setError] = useState('')
  useEffect(() => {
    if (error) return
    try {
      const local = [...parseFieldResources(domainText, 'domain'), ...parseFieldResources(ipText, 'ip')]
      if (JSON.stringify(local) !== JSON.stringify(resources)) {
        setDomainText(fieldResources(resources, 'domain', providerBehaviors).join(', '))
        setIpText(fieldResources(resources, 'ip', providerBehaviors).join(', '))
      }
    } catch { /* Keep incomplete text visible while editing. */ }
  }, [resources, domainText, ipText, error, providerBehaviors])
  function update(kind: 'domain' | 'ip', text: string) {
    if (kind === 'domain') setDomainText(text); else setIpText(text)
    try {
      onChange([...parseFieldResources(kind === 'domain' ? text : domainText, 'domain'), ...parseFieldResources(kind === 'ip' ? text : ipText, 'ip')])
      setError('')
      onValidChange(true)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Неверный ресурс'); onValidChange(false) }
  }
  return <>
    {(['domain', 'ip'] as const).map(kind => <div key={kind} className="space-y-1.5"><label className="text-muted-foreground text-sm">{kind === 'domain' ? 'Домен' : 'IP'}</label><div className="relative"><Input className="pr-10" value={kind === 'domain' ? domainText : ipText} onChange={event => update(kind, event.target.value)} placeholder={kind === 'domain' ? 'domain:example.com, geosite:youtube' : '203.0.113.0/24, geoip:ru'} /><button type="button" className="text-muted-foreground hover:text-primary absolute right-2 top-1/2 -translate-y-1/2" title="Выбрать из базы" onClick={() => setPicker(kind)}><IconFolder size={19} /></button></div></div>)}
    {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    <Dialog open={picker !== null} onOpenChange={open => { if (!open) setPicker(null) }}><DialogContent className="max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-[1100px]"><DialogHeader><DialogTitle>{picker === 'ip' ? 'IP-адреса' : 'Домены'}</DialogTitle></DialogHeader>{picker && <GeoDatabasePicker nativeOnly kind={picker} resources={fieldResources(resources, picker, providerBehaviors)} onChange={values => update(picker, values.join(', '))} />}<div className="flex justify-end"><Button onClick={() => setPicker(null)}>Готово</Button></div></DialogContent></Dialog>
  </>
}
const NO_SORT_TYPES = new Set(['Dns', 'Compatible', 'Direct', 'Reject', 'RejectDrop', 'Pass', 'Fallback', 'URLTest', 'LoadBalance', 'Selector'])
let automaticPingStarted = false

function isGeneralSelector(name: string): boolean { return name === 'VPN' || name === 'Селектор' }
function isNoVpn(name: string): boolean { return /без\s*(?:vpn|впн)/i.test(name) }
function isGeneralDirect(proxies: Record<string, ProxyInfo | undefined>, override?: { selector: string; target: string }): boolean {
  let name: string | undefined = proxies.VPN ? 'VPN' : 'Селектор'
  const seen = new Set<string>()
  while (name && !seen.has(name)) {
    if (name === 'DIRECT' || isNoVpn(name)) return true
    seen.add(name)
    const proxy: ProxyInfo | undefined = proxies[name]
    if (!proxy || !SELECTOR_TYPES.has(proxy.type)) return false
    name = name === override?.selector ? override.target : proxy.now
  }
  return false
}
function displayName(name: string): string {
  if (isGeneralSelector(name)) return 'Маршрут по умолчанию'
  if (name === 'DIRECT' || isNoVpn(name)) return '🔓 Без VPN'
  return name
}
interface SelectorsStore {
  testingAll: Record<string, boolean>
  testingSingle: Record<string, boolean>
  nodeTransports: Record<string, string>
  httpHistory: Record<string, ProxyHistory[]>
  pingErrors: Record<string, string>
}

const useSelectorsStore = create<SelectorsStore>(() => ({
  testingAll: {},
  testingSingle: {},
  nodeTransports: {},
  httpHistory: {},
  pingErrors: {},
}))

function getLastDelay(proxy: ProxyInfo): number | null {
  if (!canProbe(proxy)) return null
  return proxy.history.length > 0 ? proxy.history.at(-1)!.delay : null
}

function delayColor(delay: number | null): string {
  if (!delay) return 'text-red-400'
  if (delay < 300) return 'text-green-400'
  if (delay < 600) return 'text-yellow-400'
  return 'text-red-400'
}

function getProxyTransport(proxy: ProxyInfo): string {
  const type = proxy.type.toLowerCase()
  if (isNoVpn(proxy.name)) return 'прямое соединение'
  if (isGeneralSelector(proxy.name)) return 'общий выбор'
  if (SELECTOR_TYPES.has(proxy.type)) return 'группа'
  if (/csqtt/i.test(proxy.name)) return 'интерфейс csqtt0'
  if (type === 'direct') return 'прямое соединение'
  if (type === 'hysteria2' || type === 'hy2') return 'Hysteria2 · TLS / QUIC'
  if (type === 'tuic') return 'TUIC · TLS / QUIC'
  if (type === 'vless') {
    const network = proxy.network?.toLowerCase()
    return network === 'xhttp' ? 'VLESS · XHTTP / REALITY' : network === 'tcp' || network === 'raw' ? 'VLESS · TCP / TLS' : network ? `VLESS · ${network.toUpperCase()}` : 'VLESS · транспорт не указан'
  }
  return proxy.network?.toUpperCase() || 'транспорт не указан'
}

const CARD_ORDER_KEY = 'xkeen-mihomo-protocol-card-order'
const useCardOrder = create<{ order: string[]; move: (source: string, target: string, visible: string[]) => void; reset: () => void }>((set, get) => {
  let order: string[] = []
  try { const stored = JSON.parse(localStorage.getItem(CARD_ORDER_KEY) ?? '[]'); if (Array.isArray(stored)) order = stored.filter(value => typeof value === 'string') } catch { /* Default order. */ }
  return { order, move: (source, target, visible) => {
    const next = [...new Set([...visible, ...get().order])]
    const from = next.indexOf(source), to = next.indexOf(target)
    if (from < 0 || to < 0 || from === to) return
    next.splice(to, 0, ...next.splice(from, 1))
    localStorage.setItem(CARD_ORDER_KEY, JSON.stringify(next)); set({ order: next })
  }, reset: () => { localStorage.removeItem(CARD_ORDER_KEY); set({ order: [] }) } }
})
function orderedCards(names: string[], order: string[]): string[] {
  return order.length ? [...names].sort((a, b) => (order.indexOf(a) < 0 ? Infinity : order.indexOf(a)) - (order.indexOf(b) < 0 ? Infinity : order.indexOf(b))) : names
}

/* ====================== ОСНОВНОЙ КОМПОНЕНТ ====================== */
function SelectorsBody({ clashApiPort, mode, clashApiSecret, clashApiUnix, configContent, onDeviceSelect, onSaveRoute, onBulkOutbound, onImportRoutes, onRemoveRoute, onReorderRoute, onToggleRoute, onSelectDraft }: Props) {
  const { showToast } = useAppContext()
  const loading = useRoutingProxies((s) => s.loading)
  const error = useRoutingProxies((s) => s.error)
  const [deviceIp, setDeviceIp] = useState(() => sessionStorage.getItem(DEVICE_IP_KEY) ?? '')
  const [newIp, setNewIp] = useState('')
  const [devicePending, setDevicePending] = useState(false)
  const testingGroups = useSelectorsStore((s) => s.testingAll)
  const [routeResourcesValid, setRouteResourcesValid] = useState(true)
  const [selectedRules, setSelectedRules] = useState<string[]>([])
  const testingSingle = useSelectorsStore(s => s.testingSingle)
  const [routePending, setRoutePending] = useState(false)
  const [deletingTag, setDeletingTag] = useState<RouteTag | null>(null)
  const cardOrder = useCardOrder(s => s.order)
  const moveCard = useCardOrder(s => s.move)
  const resetCards = useCardOrder(s => s.reset)
  const [draggedProtocol, setDraggedProtocol] = useState<string | null>(null)
  
  const devices = useMemo(() => readMihomoDevices(configContent), [configContent])
  const defaultChoices = useMemo(() => defaultMihomoChoices(configContent), [configContent])
  const orderedTags = useMemo(() => orderedMihomoRouteTags(configContent), [configContent])
  useEffect(() => { sessionStorage.setItem(DEVICE_IP_KEY, deviceIp) }, [deviceIp])
  const allProxyData = useRoutingProxies((s) => s.proxies as Record<string, ProxyInfo | undefined>)
  const nodeTransports = useSelectorsStore((s) => s.nodeTransports)
  const pingErrors = useSelectorsStore((s) => s.pingErrors)
  useEffect(() => {
    let mounted = true
    void apiCall<{ success: boolean; nodes?: Record<string, string> }>('GET', 'mihomo/node-metadata')
      .then((result) => { if (mounted && result.success && result.nodes) useSelectorsStore.setState({ nodeTransports: result.nodes }) })
      .catch(() => {})
    return () => { mounted = false }
  }, [])
  const deviceOptions = useMemo(() => {
    const names = ['DIRECT', ...Object.keys(allProxyData).filter((name) => name !== 'GLOBAL' && name !== 'REJECT' && !allProxyData[name]?.hidden)]
    return [...new Set(names)]
  }, [allProxyData])
  const protocolCards = useMemo(() => deviceOptions.filter(name =>
    name === 'DIRECT' || (!name.startsWith('xkeen-device-node-') && !/^(?:PASS(?:-RULE)?|COMPATIBLE|REJECT(?:-DROP)?|DNS)$/i.test(name) && !!allProxyData[name] && (!NO_SORT_TYPES.has(allProxyData[name]!.type) || !!specialPingTag(name)) && !['compatible', 'pass', 'passrule', 'pass-rule', 'reject', 'reject-drop', 'rejectdrop', 'dns'].includes(allProxyData[name]!.type.toLowerCase()))
  ), [deviceOptions, allProxyData])

  async function changeDevice(ip: string, route: RouteTag | null, target?: string): Promise<boolean> {
    setDevicePending(true)
    try { return await onDeviceSelect(ip, route, target) } finally { setDevicePending(false) }
  }

  const requestProxyDelay = useCallback(
    async (proxyName: string, diagnostic = true) => {
      try {
        const special = specialPingTag(proxyName)
        if (special) {
          const result = await apiCall<{success: boolean; latencyMs?: number; error?: string}>('POST', 'xray/latency', {tag: special})
          if (!result.success || !result.latencyMs) throw new Error(result.error || 'Нет ответа от подключения')
          return result.latencyMs
        }
        let name = proxyName
        const seen = new Set<string>()
        const proxies = allProxyData
        while (proxies[name]?.now && !seen.has(name)) { seen.add(name); name = proxies[name]!.now! }
        try {
          const query = new URLSearchParams({ url: 'https://cp.cloudflare.com/', timeout: '10000' })
          const response = await clashFetch<{ delay: number }>(clashApiPort, `proxies/${encodeURIComponent(name)}/delay?${query}`, { secret: clashApiSecret, unix: clashApiUnix, retry: false })
          if (Number.isFinite(response.delay) && response.delay > 0) return response.delay
          throw new Error('Нет ответа через выбранное подключение')
        } catch (apiError) {
          if (proxies[name]?.type.toLowerCase() === 'wireguard') throw new Error('AWG не ответил через работающий Mihomo. Повторный туннель с тем же ключом не запускается')
          if (!diagnostic) throw apiError
          const data = await apiCall<{ success: boolean; delay?: number; error?: string }>('POST', 'mihomo/node-ping', { name })
          if (!data.success || !Number.isFinite(data.delay) || !data.delay || data.delay <= 0) throw new Error(data.error || 'Нет ответа через выбранное подключение')
          return data.delay
        }
      } catch (error) {
        throw error
      }
    },
    [allProxyData, clashApiPort, clashApiSecret, clashApiUnix]
  )

  const applyDelayResults = useCallback((results: ReadonlyArray<readonly [string, number]>) => {
    if (!results.length) return
    const time = new Date().toISOString()
    useSelectorsStore.setState((state) => {
      const next = { ...state.httpHistory }
      for (const [name, delay] of results) {
        next[name] = [...(next[name] ?? []), { time, delay }].slice(-10)
      }
      return { httpHistory: next }
    })
  }, [])

  const selectorNames = useRoutingProxies(
    useShallow((s) => {
      const allSelectors = Object.values(s.proxies).filter((p: any) => {
        if (!SELECTOR_TYPES.has(p.type) || p.hidden || p.name.startsWith('xkeen-device-node-') || isNoVpn(p.name) || /fallback/i.test(p.name)) return false
        if (p.name !== defaultChoices.VPN && !orderedTags.some(tag => defaultChoices[tag] === p.name)) return false
        return mode === 'global' ? p.name === 'GLOBAL' : p.name !== 'GLOBAL'
      }) as ProxyInfo[]
      const globalProxy = s.proxies['GLOBAL'] as ProxyInfo | undefined
      if (!globalProxy?.all) return allSelectors.map((p) => p.name)
      const globalOrder = globalProxy.all.filter((name) => SELECTOR_TYPES.has((s.proxies[name] as any)?.type))
      const orderMap = new Map(globalOrder.map((name, i) => [name, i]))
      return [...allSelectors].sort((a, b) => (orderMap.get(a.name) ?? Infinity) - (orderMap.get(b.name) ?? Infinity)).map((p) => p.name)
    })
  )
  const generalSelector = selectorNames.find((name) => name === 'VPN') ?? selectorNames.find(isGeneralSelector)
  const globalDirect = !!generalSelector && isGeneralDirect(allProxyData) && readMihomoFullBypass(configContent)
  const activeDevice = devices.find((profile) => profile.ip === deviceIp)
  async function moveRoute(source: RouteTag, target: RouteTag) {
    if (source === target || routePending) return
    setRoutePending(true)
    try { await onReorderRoute(source, target) } finally { setRoutePending(false) }
  }

  const testSingle = useCallback(
    async (proxyName: string) => {
      if (useSelectorsStore.getState().testingSingle[proxyName]) return
      useSelectorsStore.setState((s) => ({ testingSingle: { ...s.testingSingle, [proxyName]: true } }))
      try {
        const delay = await requestProxyDelay(proxyName)
        applyDelayResults([[proxyName, delay]])
        await fetchClashProxies(clashApiPort, clashApiSecret, true, clashApiUnix ?? null).catch(() => {})
        useSelectorsStore.setState((s) => ({ pingErrors: { ...s.pingErrors, [proxyName]: '' } }))
      } catch (error) {
        applyDelayResults([[proxyName, 0]])
        useSelectorsStore.setState((s) => ({ pingErrors: { ...s.pingErrors, [proxyName]: error instanceof Error ? error.message : 'Нет ответа' } }))
        showToast(error instanceof Error ? error.message : 'Не удалось проверить подключение', 'error')
      } finally {
        useSelectorsStore.setState((s) => ({ testingSingle: { ...s.testingSingle, [proxyName]: false } }))
      }
    },
    [applyDelayResults, clashApiPort, clashApiSecret, clashApiUnix, requestProxyDelay, showToast]
  )

  const providerBehaviors = useMemo(() => {
    try {
      const providers = (yaml.load(configContent) as any)?.['rule-providers'] ?? {}
      return Object.fromEntries(Object.entries(providers).map(([name, value]) => [name, String((value as any)?.behavior ?? '')])) as Record<string, string>
    } catch { return {} as Record<string, string> }
  }, [configContent])
  function exportRoutes() {
    const rules = orderedTags.map(tag => ({ tag, name: routeLabel(tag), resources: readMihomoRouteResources(configContent, tag), network: readMihomoRouteNetwork(configContent, tag), outbound: allProxyData[defaultChoices[tag]]?.now ?? 'DIRECT' }))
    const blob = new Blob([JSON.stringify({ format: 'xkeen-mihomo-routes-v1', rules }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url; anchor.download = 'mihomo-routes.json'; anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  async function importRoutes(file: File) {
    try {
      if (file.size > 1024 * 1024) throw new Error('Файл правил слишком большой')
      const data = JSON.parse(await file.text()) as { format?: string; rules?: unknown }
      if (data.format !== 'xkeen-mihomo-routes-v1' || !Array.isArray(data.rules) || data.rules.length > 50 || data.rules.some((rule: any) => typeof rule?.tag !== 'string' || typeof rule?.name !== 'string' || !Array.isArray(rule?.resources) || rule.resources.some((value: unknown) => typeof value !== 'string') || typeof rule?.outbound !== 'string' || rule?.network !== undefined && !['tcp,udp', 'tcp', 'udp'].includes(rule.network))) throw new Error('Неверный формат файла правил Mihomo')
      setRoutePending(true)
      await onImportRoutes(data.rules as Array<{ tag: string; name: string; resources: string[]; outbound: string; network?: MihomoRouteNetwork }>)
    } catch (error) { showToast(error instanceof Error ? error.message : 'Не удалось импортировать правила', 'error') }
    finally { setRoutePending(false) }
  }
  const testAll = useCallback(
    async (selectorName: string, targets?: string[]) => {
      const selector = allProxyData[selectorName]
      const candidates = targets ?? selector?.all
      if (!candidates || useSelectorsStore.getState().testingAll[selectorName]) return

      useSelectorsStore.setState((s) => ({ testingAll: { ...s.testingAll, [selectorName]: true } }))

      try {
        const proxies = allProxyData
        const names = candidates.filter((name) => canProbe(proxies[name]))
        for (let offset = 0; offset < names.length; offset += 3) {
          const batch = await Promise.all(names.slice(offset, offset + 3).map(async name => {
            try {
              const delay = await requestProxyDelay(name)
              useSelectorsStore.setState((s) => ({ pingErrors: { ...s.pingErrors, [name]: '' } }))
              return [name, delay] as const
            } catch (error) {
              useSelectorsStore.setState((s) => ({ pingErrors: { ...s.pingErrors, [name]: error instanceof Error ? error.message : 'Нет ответа' } }))
              return [name, 0] as const
            }
          }))
          applyDelayResults(batch)
        }
        await fetchClashProxies(clashApiPort, clashApiSecret, true, clashApiUnix ?? null).catch(() => {})
      } catch {
        /* */
      } finally {
        useSelectorsStore.setState((s) => ({ testingAll: { ...s.testingAll, [selectorName]: false } }))
      }
    },
    [applyDelayResults, clashApiPort, clashApiSecret, clashApiUnix, requestProxyDelay, allProxyData]
  )

  useEffect(() => {
    const handleTestAll = () => {
      const general = selectorNames.find(isGeneralSelector) ?? selectorNames[0]
      if (general) void testAll(general)
    }
    window.addEventListener('mihomo:test-all', handleTestAll)
    return () => window.removeEventListener('mihomo:test-all', handleTestAll)
  }, [selectorNames, testAll])

  useEffect(() => {
    const general = selectorNames.find(isGeneralSelector) ?? selectorNames[0]
    if (loading || !general || automaticPingStarted) return
    automaticPingStarted = true
    void testAll(general)
  }, [loading, selectorNames, testAll])

  useEffect(() => { setSelectedRules([]) }, [deviceIp])
  const tableRules: TableRule[] = [...orderedTags, 'VPN'].map(route => {
    const group = defaultChoices[route]
    const choice = activeDevice?.choices[route]
    const target = choice === group ? '@inherit' : choice === '@direct' ? 'DIRECT' : choice ?? allProxyData[group]?.now ?? 'DIRECT'
    const values = route === 'VPN' ? [] : readMihomoRouteResources(configContent, route)
    const network = readMihomoRouteNetwork(configContent, route)
    return { id: route, enabled: isMihomoRouteEnabled(configContent, route, activeDevice?.ip), description: routeLabel(route), network: network === 'mixed' ? '' : network, networkMixed: network === 'mixed', inboundTag: [], outboundTag: target, domain: fieldResources(values, 'domain', providerBehaviors), ip: fieldResources(values, 'ip', providerBehaviors), port: '', sourcePort: '', sourceIP: [] }
  })
  const tableOutbounds = [...(activeDevice ? [{tag: '@inherit', protocol: '', label: 'Как в общей маршрутизации'}] : []), ...protocolCards.map(name => ({tag: name, protocol: allProxyData[name]?.type ?? '', label: displayName(name)}))]
  const tableLatencies = Object.fromEntries(protocolCards.map(name => { const delay = allProxyData[name] ? getLastDelay(allProxyData[name]!) : null; return [name, delay && delay > 0 ? {ms: delay} : delay === 0 ? {error: pingErrors[name] || 'Нет ответа'} : {}] }))
  async function saveTableRule(tag: string | null, rule: TableRule): Promise<boolean> {
    if (!routeResourcesValid || rule.networkMixed) return false
    setRoutePending(true)
    try {
      const values = tag === 'VPN' ? [] : [...parseFieldResources(rule.domain.join('\n'), 'domain'), ...parseFieldResources(rule.ip.join('\n'), 'ip')]
      return await onSaveRoute(tag, rule.description, values, rule.outboundTag, activeDevice?.ip, rule.network || 'tcp,udp', rule.enabled)
    } catch (error) { showToast(error instanceof Error ? error.message : 'Не удалось сохранить правило', 'error'); return false }
    finally { setRoutePending(false) }
  }

  if (loading) {
    return (
      <div className="text-muted-foreground flex min-h-48 items-center justify-center text-sm">
        <Spinner className="mr-2 size-5" /> Загрузка...
      </div>
    )
  }

  if (error || selectorNames.length === 0) {
    return (
      <div className="relative m-4 h-64">
        <Empty className="text-muted-foreground border-border absolute inset-0 gap-3 rounded-xl border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <IconPlugX />
            </EmptyMedia>
            <EmptyTitle className="text-sm tracking-normal">
              <span>{error ? 'Ошибка загрузки данных Clash API' : 'Селекторы не найдены'}</span>
            </EmptyTitle>
          </EmptyHeader>
          <EmptyContent>
            <Button
              variant="outline"
              size="sm"
              onClick={() => fetchClashProxies(clashApiPort, clashApiSecret, false, clashApiUnix ?? null)}
            >
              Повторить
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    )
  }

  return (
    <TooltipProvider delayDuration={500}>
      <div className="space-y-4 p-4">
        <div className="bg-card flex shrink-0 flex-wrap items-center gap-2 border-b pb-3">
          <Button size="sm" variant={!activeDevice ? 'default' : 'outline'} onClick={() => setDeviceIp('')}>Общая маршрутизация</Button>
          {devices.map((profile) => <DeviceTab key={profile.ip} ip={profile.ip} selected={activeDevice?.ip === profile.ip} disabled={devicePending} onSelect={() => setDeviceIp(profile.ip)} onRemove={async () => { if (await changeDevice(profile.ip, null) && activeDevice?.ip === profile.ip) setDeviceIp('') }} />)}
        </div>
        <div className="border-border flex shrink-0 flex-wrap items-center gap-2 border-b pb-3">
          <span className="text-sm font-medium">Маршрутизация для устройства</span>
          <Input className="max-w-44" value={newIp} onChange={(event) => setNewIp(event.target.value)} placeholder="192.168.0.20" aria-label="IP устройства" />
          <Button size="sm" disabled={!validDeviceIp(newIp) || devices.some((device) => device.ip === newIp.trim()) || devicePending} onClick={async () => { const ip = newIp.trim(); if (await changeDevice(ip, 'VPN')) { setDeviceIp(ip); setNewIp('') } }}>Добавить IP</Button>
        </div>
        <div className="flex flex-col gap-4">
        <section className="border-border bg-input-background/70 order-1 space-y-3 rounded-xl border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-base font-semibold">Маршрут по умолчанию</h3><div className="ml-auto flex items-center gap-2"><Button size="sm" variant="outline" onClick={() => window.dispatchEvent(new Event('mihomo:open-subscriptions'))}>Подписки</Button><Button size="sm" variant="outline" disabled={!!testingGroups[generalSelector ?? 'VPN']} onClick={() => void testAll(generalSelector ?? 'VPN', protocolCards.filter(name => canProbe(allProxyData[name])))}><IconBoltFilled size={16} />{testingGroups[generalSelector ?? 'VPN'] ? 'Проверка…' : 'Пинг'}</Button></div></div>
          <div className="grid grid-cols-2 auto-rows-[100px] gap-2 sm:grid-cols-3 lg:grid-cols-6 2xl:grid-cols-7">
            {orderedCards(protocolCards.filter(name => name !== 'DIRECT' || !!allProxyData.DIRECT), cardOrder).map((name, _, cards) => {
              const proxy = allProxyData[name]
              const delay = proxy ? getLastDelay(proxy) : null
              const selected = activeDevice ? activeDevice.choices.VPN === name : allProxyData[generalSelector ?? 'VPN']?.now === name
              return <div key={name} draggable title="Перетащите карточку, чтобы изменить порядок" onDragStart={event => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', name); setDraggedProtocol(name) }} onDragEnd={() => setDraggedProtocol(null)} onDragOver={event => { if (draggedProtocol) event.preventDefault() }} onDrop={event => { event.preventDefault(); if (draggedProtocol) moveCard(draggedProtocol, name, cards); setDraggedProtocol(null) }} className={cn('relative cursor-grab rounded-md border text-sm transition-colors active:cursor-grabbing', selected ? 'border-blue-400 bg-blue-500/20' : 'border-ring/40 hover:border-blue-400 hover:bg-blue-500/10')}>
                <button type="button" className="flex h-full min-w-0 w-full flex-col gap-1 px-3 py-1.5 text-left" onClick={() => { if (activeDevice) void changeDevice(activeDevice.ip, 'VPN', name === 'DIRECT' ? '@direct' : name); else void onSelectDraft(generalSelector ?? 'VPN', name) }}>
                  <IconGripVertical size={15} className="text-muted-foreground absolute bottom-2 right-2" aria-label="Перетащить карточку" /><span title={name} className="line-clamp-2 h-10 shrink-0 w-full break-words pr-16 font-medium leading-5">{displayName(name)}</span>
                  <span className="text-muted-foreground line-clamp-2 break-words">{nodeTransports[name] ?? (proxy ? getProxyTransport(proxy) : 'Прямое соединение')}</span>
                </button>
                {canProbe(proxy) && <button type="button" className={cn('absolute right-2 top-1.5 w-16 rounded p-1 text-xs font-medium tabular-nums hover:bg-blue-500/20', delay === null ? 'text-sky-400' : delayColor(delay))} title={pingErrors[name] || 'HTTPS через выбранное подключение'} aria-label={`Пинг ${name}`} onClick={() => void testSingle(name)}>{useSelectorsStore.getState().testingSingle[name] ? '…' : delay === null ? <IconBoltFilled size={17} /> : delay > 0 ? `${delay} мс` : '✕'}</button>}
              </div>
            })}
          </div>
        </section>
        <p className="text-muted-foreground order-1 text-xs">Карточки можно перетаскивать мышью. <button type="button" className="ml-2 underline" onClick={resetCards}>Стандартный порядок</button></p>
        <div className="order-2">
          <RoutingTable rules={tableRules} outbounds={tableOutbounds} inbounds={[]} showTitle={false}
            disabled={routePending || devicePending} deviceMode={!!activeDevice}
            canDelete={rule => rule.id !== 'VPN' && !activeDevice}
            canReorder={rule => rule.id !== 'VPN' && !activeDevice}
            canEditResources={rule => rule.id !== 'VPN' && !activeDevice}
            canEditDescription={rule => rule.id.startsWith('custom:') && !activeDevice}
            onAddRule={rule => saveTableRule(null, rule)}
            onEditRule={(id, rule) => saveTableRule(id, rule)}
            onDeleteRule={id => setDeletingTag(id)}
            onReorder={(from, to) => void moveRoute(tableRules[from].id, tableRules[to].id)}
            onToggleEnabled={id => { setRoutePending(true); void onToggleRoute(id, !isMihomoRouteEnabled(configContent, id, activeDevice?.ip), activeDevice?.ip).finally(() => setRoutePending(false)) }}
            onImportFile={!activeDevice ? importRoutes : undefined} onExportRules={!activeDevice ? exportRoutes : undefined}
            selectedRuleIds={selectedRules} onSelectionChange={setSelectedRules}
            onApplyOutbound={async target => { setRoutePending(true); try { const saved = await onBulkOutbound(selectedRules, target, activeDevice?.ip); if (saved) setSelectedRules([]); return saved } finally { setRoutePending(false) } }}
            toolbarAction={<Button size="sm" variant={(activeDevice ? activeDevice.choices.VPN === 'DIRECT' : globalDirect) ? 'default' : 'outline'} disabled={routePending} onClick={() => { if (activeDevice) void changeDevice(activeDevice.ip, 'VPN', activeDevice.choices.VPN === 'DIRECT' ? '@direct' : 'DIRECT'); else void onSelectDraft(defaultChoices.VPN, globalDirect ? 'DIRECT' : '@bypass') }}>🔓 Полный обход без VPN: {(activeDevice ? activeDevice.choices.VPN === 'DIRECT' : globalDirect) ? 'включён' : 'выключен'}</Button>}
            latencies={tableLatencies} onPing={name => void testSingle(name)} pingPending={Object.entries(testingSingle).find(([, pending]) => pending)?.[0] ?? null}
            resourceLabeler={value => value.startsWith('RULE-SET,') ? `Rule-set · ${value.slice(9)}` : resourceLabel(value)}
            editorValid={routeResourcesValid}
            onEditorOpen={() => setRouteResourcesValid(true)}
            renderResources={(rule, update) => rule.id === 'VPN' ? null : activeDevice ? <p className="text-muted-foreground text-sm">Домены и IP задаются в общей маршрутизации.</p> : <MihomoResourceFields key={rule.id} resources={[...parseFieldResources(rule.domain.join('\n'), 'domain'), ...parseFieldResources(rule.ip.join('\n'), 'ip')]} providerBehaviors={providerBehaviors} onValidChange={setRouteResourcesValid} onChange={values => update({domain: fieldResources(values, 'domain', providerBehaviors), ip: fieldResources(values, 'ip', providerBehaviors)})} />}
          />
        </div>
        <Dialog open={!!deletingTag} onOpenChange={open => { if (!open && !routePending) setDeletingTag(null) }}><DialogContent><DialogHeader><DialogTitle>Удалить правило «{deletingTag ? routeLabel(deletingTag) : ''}»?</DialogTitle></DialogHeader><p className="text-muted-foreground">Правило будет удалено из общей маршрутизации и правил устройств.</p><div className="flex justify-end gap-2"><Button variant="outline" disabled={routePending} onClick={() => setDeletingTag(null)}>Отмена</Button><Button variant="destructive" disabled={routePending} onClick={async () => { if (!deletingTag) return; setRoutePending(true); try { if (await onRemoveRoute(deletingTag)) setDeletingTag(null) } finally { setRoutePending(false) } }}>Удалить</Button></div></DialogContent></Dialog>
        </div>
      </div>
    </TooltipProvider>
  )
}

const RoutingProxies = createContext<Record<string, any> | null>(null)
function useRoutingProxies<T>(selector: (state: ReturnType<typeof useProxiesStore.getState>) => T): T {
  const state = useProxiesStore()
  const proxies = useContext(RoutingProxies)
  return selector(proxies ? { ...state, proxies } : state)
}
export function SelectorsPanel(props: Props) {
  const live = useProxiesStore(s => s.proxies)
  const httpHistory = useSelectorsStore(s => s.httpHistory)
  const preview = useMemo(() => {
    try {
      const config = yaml.load(props.configContent) as any
      const groups = config?.['proxy-groups'] ?? []
      const selections = props.isDraft ? readSelections(props.configContent) : {}
      const result: Record<string, any> = { ...live }
      const names = new Set(groups.map((g: any) => g.name))
      for (const [name, proxy] of Object.entries(result)) {
        if (SELECTOR_TYPES.has(proxy.type) && name !== 'GLOBAL' && !names.has(name)) delete result[name]
      }
      for (const group of groups) {
        const current = result[group.name]
        const providerNodes = Object.values(live).filter((p: any) => group.use?.includes(p['provider-name'])).map((p: any) => p.name)
        const all = [...new Set([...(group.proxies ?? []), ...providerNodes, ...(group.use?.length ? current?.all ?? [] : [])])]
        result[group.name] = { history: [], alive: true, udp: true, ...current, name: group.name,
          type: ({select: 'Selector', fallback: 'Fallback', 'url-test': 'URLTest', 'load-balance': 'LoadBalance'} as any)[group.type] ?? 'Selector',
          all, now: selections[group.name] ?? current?.now ?? all[0], icon: group.icon, hidden: group.hidden }
      }
      return Object.fromEntries(Object.entries(result).map(([name, proxy]) => [name, {
        ...proxy, history: httpHistory[name] ?? [],
      }]))
    } catch { return Object.fromEntries(Object.entries(live).map(([name, proxy]) => [name, {
      ...proxy, history: httpHistory[name] ?? [],
    }])) }
  }, [props.configContent, props.isDraft, live, httpHistory])
  return <RoutingProxies.Provider value={preview}><SelectorsBody {...props} /></RoutingProxies.Provider>
}

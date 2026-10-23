import * as yaml from 'js-yaml'
import { DeviceTab } from '@/components/configuration/DeviceTab'
import { readSelections } from '@/lib/mihomoRoutingBackup'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList } from '@/components/ui/combobox'
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { InputGroupAddon } from '@/components/ui/input-group'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  IconBoltFilled,
  IconChevronDown,
  IconChevronUp,
  IconCircleArrowRightFilled,
  IconLoader2,
  IconLock,
  IconGripVertical,
  IconFolder,
  IconPlugX,
} from '@tabler/icons-react'
import { createContext, useContext, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { apiCall, clashFetch } from '../../../lib/api'
import { fetchClashProxies, useProxiesStore, useAppContext } from '../../../lib/store'
import { defaultMihomoChoices, isMihomoRouteEnabled, readMihomoFullBypass, isMihomoFullRoute, orderedMihomoRouteTags, readMihomoDevices, readMihomoRouteResources, readMihomoRouteNetwork, type MihomoRouteNetwork } from '../../../lib/mihomoDeviceRouting'
import { findRoutePresets } from '../../../lib/routePresets'
import { validDeviceIp, type RouteTag } from '../../../lib/xrayDeviceRouting'
import { RouteIcon, routeLabel } from '../RouteIcon'
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
  onCollapsedStateChange?: (collapsed: boolean) => void
  isDraft?: boolean
  configContent: string
  onSelectDraft: (name: string, target: string) => Promise<boolean>
  onDeviceSelect: (ip: string, route: RouteTag | null, target?: string) => Promise<boolean>
  onSaveRoute: (tag: RouteTag | null, name: string, resources: string[], target: string, deviceIp?: string, network?: MihomoRouteNetwork) => Promise<boolean>
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
const AUTO_POLICY_TYPES = new Set(['Fallback', 'URLTest', 'LoadBalance'])
const COLLAPSE_SELECTORS_KEY = 'collapseSelectors'
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
const TOGGLE_ALL_SELECTORS_EVENT = 'mihomo:toggle-all-selectors'
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
function cardTitle(proxy: ProxyInfo): string {
  return displayName(proxy.name)
}
function isProtocolProxy(proxy?: ProxyInfo): boolean {
  return !!proxy && ['vless', 'hysteria2', 'hy2', 'tuic', 'wireguard'].includes(proxy.type.toLowerCase())
}
function isRouteOption(name: string, general: boolean, proxies: Record<string, ProxyInfo | undefined>): boolean {
  if (proxies[`${name} · XKeen`]) return false
  if (name === 'DIRECT' && !general) return true
  const proxy = proxies[name]
  if (!proxy) return false
  if (isProtocolProxy(proxy) || /csqtt|wdtt|nfqws/i.test(name) || isNoVpn(name)) return true
  if (name === 'DIRECT') return !Object.keys(proxies).some((key) => isNoVpn(key))
  return !general && isGeneralSelector(name)
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

function GraveIcon({ className, size = 16 }: { className?: string; size?: number }) {
  return (
    <svg viewBox="0 0 512 512" fill="currentColor" aria-hidden="true" className={className} style={{ width: size, height: size }}>
      <rect x="46.913" y="424.382" width="418.175" height="87.618" />
      <path d="M263.957 0h-15.916C160.059 0 88.737 71.322 88.737 159.305v238.941h334.525V159.305C423.262 71.322 351.941 0 263.957 0m75.009 225.189h-61.389v95.91h-43.155v-95.91h-61.389v-43.304h61.389v-59.918h43.155v59.918h61.389z" />
    </svg>
  )
}

function getLastDelay(proxy: ProxyInfo): number | null {
  if (!canProbe(proxy)) return null
  return proxy.history.length > 0 ? proxy.history.at(-1)!.delay : null
}

function hasDelayHistory(proxy?: ProxyInfo): boolean {
  return canProbe(proxy) && proxy!.history.length > 0
}

function isTimedOutProxy(proxy?: ProxyInfo): boolean {
  return !!proxy && hasDelayHistory(proxy) && getLastDelay(proxy) === 0
}

function isSelectionDisabled(autoPolicy: boolean, proxy?: ProxyInfo): boolean {
  return autoPolicy && isTimedOutProxy(proxy)
}

function delayColor(delay: number | null): string {
  if (!delay) return 'text-red-400'
  if (delay < 300) return 'text-green-400'
  if (delay < 600) return 'text-yellow-400'
  return 'text-red-400'
}

function delayColorImportant(delay: number | null): string {
  if (!delay) return 'text-red-400!'
  if (delay < 300) return 'text-green-400!'
  if (delay < 600) return 'text-yellow-400!'
  return 'text-red-400!'
}

function shouldShowDelay(proxy?: ProxyInfo, isTesting = false): boolean {
  if (!proxy || !canProbe(proxy)) return false
  return getLastDelay(proxy) !== null || isTesting
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

function hasNConsecutiveTimeouts(proxy: ProxyInfo | undefined, n: number): boolean {
  if (!proxy || n < 1) return false
  if (proxy.history.length < n) return false
  return proxy.history.slice(-n).every((entry) => entry.delay === 0)
}

function sortProxyNames(
  proxyNames: string[],
  order: string,
  proxies: Record<string, ProxyInfo | undefined>
): string[] {
  if (order === 'default') {
    const priority = (name: string) => name === 'DIRECT' || isNoVpn(name) ? 0 : /nfqws/i.test(name) ? 1 : isProtocolProxy(proxies[name]) ? 2 : /^csqtt$/i.test(name) ? 3 : /^wdtt/i.test(name) ? 4 : 5
    return [...proxyNames].sort((a, b) => priority(a) - priority(b))
  }
  const sortable: { name: string; index: number; delay: number | null }[] = []
  const nonSortable: { name: string; index: number }[] = []
  proxyNames.forEach((name, index) => {
    const proxy = proxies[name]
    if (proxy && NO_SORT_TYPES.has(proxy.type)) {
      nonSortable.push({ name, index })
    } else {
      sortable.push({ name, index, delay: proxy ? getLastDelay(proxy) : null })
    }
  })
  if (order === 'name') {
    sortable.sort((a, b) => a.name.localeCompare(b.name))
  } else {
    sortable.sort((a, b) => {
      if (a.delay === null && b.delay === null) return 0
      if (a.delay === null) return 1
      if (b.delay === null) return -1
      return a.delay - b.delay
    })
  }
  const result = new Array(proxyNames.length)
  for (const item of nonSortable) result[item.index] = item.name
  let sortIdx = 0
  for (let i = 0; i < result.length; i++) {
    if (result[i] === undefined) {
      result[i] = sortable[sortIdx++].name
    }
  }
  return result
}

function getChainData(proxies: Record<string, ProxyInfo | undefined>, startName?: string): string {
  const parts: string[] = []
  let current = startName
  const visited = new Set<string>()

  while (current && !visited.has(current)) {
    visited.add(current)
    const proxy = proxies[current]
    parts.push(current, proxy?.icon ?? '')
    if (!proxy || !SELECTOR_TYPES.has(proxy.type) || !proxy.now) break
    current = proxy.now
  }

  return parts.join('\x00')
}

function parseChain(chainStr: string) {
  if (!chainStr) return []
  const parts = chainStr.split('\x00')
  return Array.from({ length: parts.length / 2 }, (_, i) => ({ name: parts[i * 2], icon: parts[i * 2 + 1] || undefined }))
}

function readCollapsedSelectors(): Record<string, boolean> {
  if (typeof window === 'undefined') return {}

  try {
    const raw = localStorage.getItem(COLLAPSE_SELECTORS_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    if (!parsed || typeof parsed !== 'object') return {}

    const next: Record<string, boolean> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'boolean') next[key] = value
    }
    return next
  } catch {
    return {}
  }
}

function blurActiveElement() {
  if (typeof document === 'undefined') return
  const activeElement = document.activeElement
  if (activeElement instanceof HTMLElement) activeElement.blur()
}

/* ====================== ОДИНОЧНАЯ КАРТОЧКА ====================== */
const ProxyCard = memo(function ProxyCard({
  proxyName,
  selectorName,
  autoPolicy,
  lockSelection,
  onSelect,
  onTestSingle,
}: {
  proxyName: string
  selectorName: string
  autoPolicy: boolean
  lockSelection?: boolean
  onSelect: (selectorName: string, proxyName: string) => void
  onTestSingle: (proxyName: string) => Promise<void>
}) {
  const proxy = useRoutingProxies((s) => s.proxies[proxyName] as ProxyInfo | undefined)
  const isActive = useRoutingProxies((s) => (s.proxies[selectorName] as ProxyInfo | undefined)?.now === proxyName)
  const isFixed = useRoutingProxies((s) => (s.proxies[selectorName] as ProxyInfo | undefined)?.fixed === proxyName)
  const isTestingSingle = useSelectorsStore((s) => !!s.testingSingle[proxyName])
  const cachedTransport = useSelectorsStore((s) => s.nodeTransports[proxyName])

  const chainStr = useRoutingProxies((s): string => {
    const p = s.proxies[proxyName] as ProxyInfo | undefined
    return !p || !SELECTOR_TYPES.has(p.type) || !p.now ? '' : getChainData(s.proxies as Record<string, ProxyInfo | undefined>, proxyName)
  })
  const chain = useMemo(() => parseChain(chainStr), [chainStr])

  if (!proxy) return null

  const delay = getLastDelay(proxy)
  const hasHistory = hasDelayHistory(proxy)
  const canTest = canProbe(proxy)
  const selectionDisabled = lockSelection || isSelectionDisabled(autoPolicy, proxy)
  const transport = cachedTransport ?? getProxyTransport(proxy)

  return (
    <div
      className={cn(
        'relative flex min-h-28 flex-col justify-between gap-2 rounded-xl border p-3.5 pr-12 text-sm',
        selectionDisabled ? 'cursor-not-allowed opacity-55' : 'cursor-pointer',
        isFixed
          ? 'border-purple-400 bg-linear-to-b from-purple-500/25 to-purple-500/15'
          : isActive
            ? 'border-blue-400 bg-blue-500/20'
            : selectionDisabled
              ? 'border-ring/35 bg-[linear-gradient(135deg,rgba(148,163,184,0.08)_0%,transparent_55%)]'
              : 'border-ring/40 hover:border-blue-400 hover:bg-blue-500/10'
      )}
      onClick={() => !selectionDisabled && onSelect(selectorName, proxyName)}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {proxy.icon && (
          <img
            src={proxy.icon}
            alt=""
            className="size-4 shrink-0 rounded-sm object-contain"
            onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
          />
        )}
        {chain.length > 0 ? (
          <Tooltip>
            <TooltipTrigger render={<span className="truncate text-sm font-medium" title={proxyName}>{cardTitle(proxy)}</span>} />
            <TooltipContent side="top" className="p-2">
              <div className="flex flex-wrap items-center gap-1">
                {chain.map((item, i) => (
                  <div key={item.name} className="flex items-center gap-1">
                    {i > 0 && <IconCircleArrowRightFilled size={10} className="text-muted-foreground shrink-0" />}
                    {item.icon && (
                      <img
                        src={item.icon}
                        alt=""
                        className="size-3.5 shrink-0 rounded-sm object-contain"
                        onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
                      />
                    )}
                    <span className="text-[13px]">{displayName(item.name)}</span>
                  </div>
                ))}
              </div>
            </TooltipContent>
          </Tooltip>
        ) : (
          <span className="truncate text-sm font-medium" title={proxyName}>{cardTitle(proxy)}</span>
        )}
      </div>

      <div className="flex items-center justify-between gap-1">
        <span className="text-muted-foreground text-xs">
          {transport}
        </span>

        {canTest && (
          <Tooltip>
            <TooltipTrigger render={
              <span
                className={cn(
                  'absolute right-2 top-2 cursor-pointer rounded p-1 text-xs font-medium tabular-nums transition-opacity',
                  delayColor(delay),
                  isTestingSingle && 'opacity-40'
                )}
                onClick={(e) => {
                  e.stopPropagation()
                  if (!isTestingSingle) onTestSingle(proxyName)
                }}
              >
                {isTestingSingle ? (
                  <Spinner />
                ) : hasHistory ? (
                  delay || <GraveIcon size={14} />
                ) : (
                  <IconBoltFilled size={13} className="text-foreground" />
                )}
              </span>
            } />
            {proxy.history.length > 0 ? (
              <TooltipContent side="top" className="p-2">
                <div className="flex min-w-35 flex-col gap-1">
                  {proxy.history.map((entry, i) => (
                    <div key={i} className="flex items-center justify-between gap-3 text-[13px]">
                      <span className="tabular-nums">
                        {new Date(entry.time).toLocaleString('sv-SE', { hour12: false }).replace('T', ' ')}
                      </span>
                      <span className={cn('font-medium tabular-nums', delayColor(entry.delay))}>
                        {entry.delay ? `${entry.delay}ms` : '—'}
                      </span>
                    </div>
                  ))}
                </div>
              </TooltipContent>
            ) : (
              <TooltipContent>HTTP GET через выбранное подключение</TooltipContent>
            )}
          </Tooltip>
        )}
      </div>
    </div>
  )
})

/* ====================== МЕТА-СТРОКА СЕЛЕКТОРА ====================== */
const SelectorStatusRow = memo(function SelectorStatusRow({
  selectorName,
  label,
  fixedProxyName,
  onClearFixed,
}: {
  selectorName: string
  label: string
  fixedProxyName?: string
  onClearFixed?: () => Promise<void>
}) {
  const chainStr = useRoutingProxies((s) =>
    getChainData(s.proxies as Record<string, ProxyInfo | undefined>, (s.proxies[selectorName] as ProxyInfo | undefined)?.now)
  )
  const chain = useMemo(() => parseChain(chainStr), [chainStr])
  const [isClearingFixed, setIsClearingFixed] = useState(false)

  async function handleClearFixed(e: React.MouseEvent<HTMLButtonElement>) {
    e.preventDefault()
    e.stopPropagation()
    if (!onClearFixed || isClearingFixed) return
    blurActiveElement()
    setIsClearingFixed(true)
    try {
      await onClearFixed()
    } finally {
      setIsClearingFixed(false)
    }
  }

  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-1 text-[13px]">
      <span className="truncate">{label}</span>
      {chain.map((item, i) => (
        <div key={item.name} className="flex min-w-0 items-center gap-1">
          <IconCircleArrowRightFilled size={13} className="text-muted-foreground shrink-0" />
          {item.icon && (
            <img
              src={item.icon}
              alt=""
              className="size-4 shrink-0 rounded-sm object-contain"
              onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
            />
          )}
          {i === 0 && fixedProxyName === item.name && onClearFixed && (
            <Tooltip>
              <TooltipTrigger render={
                <button
                  type="button"
                  className="flex size-4 shrink-0 items-center justify-center rounded-sm text-purple-400 transition-colors hover:text-purple-300 disabled:opacity-50"
                  onClick={handleClearFixed}
                  disabled={isClearingFixed}
                  aria-label="Снять фиксацию выбора"
                >
                  {isClearingFixed ? <IconLoader2 size={12} className="animate-spin" /> : <IconLock size={17} />}
                </button>
              } />
              <TooltipContent>Снять фиксацию</TooltipContent>
            </Tooltip>
          )}
          <span className="truncate">{displayName(item.name)}</span>
        </div>
      ))}
    </div>
  )
})

const CollapsedProxyOption = memo(function CollapsedProxyOption({
  proxyName,
  disabled,
  onTestSingle,
}: {
  proxyName: string
  disabled: boolean
  onTestSingle: (proxyName: string) => Promise<void>
}) {
  const proxy = useRoutingProxies((s) => s.proxies[proxyName] as ProxyInfo | undefined)
  const isTestingSingle = useSelectorsStore((s) => !!s.testingSingle[proxyName])
  const delay = proxy ? getLastDelay(proxy) : null
  const hasHistory = hasDelayHistory(proxy)
  const showDelay = shouldShowDelay(proxy, isTestingSingle)
  const canTest = canProbe(proxy)

  return (
    <div className={cn('flex w-full min-w-0 items-center gap-2', disabled && 'opacity-70')}>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {proxy?.icon && (
          <img
            src={proxy.icon}
            alt=""
            className="size-4 shrink-0 rounded-sm object-contain"
            onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
          />
        )}
        <span className="truncate">{displayName(proxyName)}</span>
      </div>
      {canTest && (
        <Tooltip>
          <TooltipTrigger render={
            <button
              type="button"
              data-slot="proxy-delay-test"
              className={cn(
                'ml-auto flex h-5 min-w-8 shrink-0 cursor-pointer items-center justify-center bg-transparent px-1.5 text-xs font-medium tabular-nums outline-hidden',
                showDelay ? delayColorImportant(delay) : 'text-foreground!'
              )}
              style={showDelay ? undefined : { color: '#fff' }}
              onMouseDown={(e) => {
                e.preventDefault()
                e.stopPropagation()
              }}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                if (!isTestingSingle) void onTestSingle(proxyName)
              }}
            >
              {isTestingSingle ? <Spinner /> : hasHistory ? delay || <GraveIcon size={14} /> : <IconBoltFilled className="size-3.5" />}
            </button>
          } />
          <TooltipContent>HTTP GET через выбранное подключение</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
})

const SelectorCombobox = memo(function SelectorCombobox({
  selectorName,
  options,
  autoPolicy,
  lockSelection,
  onSelect,
  onTestSingle,
  visible,
}: {
  selectorName: string
  options: string[]
  autoPolicy: boolean
  lockSelection?: boolean
  onSelect: (selectorName: string, proxyName: string) => void
  onTestSingle: (proxyName: string) => Promise<void>
  visible: boolean
}) {
  const selector = useRoutingProxies((s) => s.proxies[selectorName] as ProxyInfo | undefined)
  const value = selector?.now ?? null
  const selectedProxy = useRoutingProxies((s) => (value ? (s.proxies[value] as ProxyInfo | undefined) : undefined))
  const isFixed = !!value && selector?.fixed === value
  const disabledOptions = useRoutingProxies(
    useShallow((s) =>
      Object.fromEntries(
        options.map((proxyName) => [proxyName, lockSelection || isSelectionDisabled(autoPolicy, s.proxies[proxyName] as ProxyInfo | undefined)])
      )
    )
  )
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!visible) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOpen(false)
    }
  }, [visible])

  return (
    <Combobox
      items={options}
      value={value}
      open={visible ? open : false}
      itemToStringLabel={(item) => displayName(item)}
      itemToStringValue={(item) => item}
      onOpenChange={setOpen}
      onValueChange={(proxyName) => proxyName && !disabledOptions[proxyName] && onSelect(selectorName, proxyName)}
      autoHighlight
    >
      <ComboboxInput
        fullWidth
        className={cn(
          'w-full *:data-[slot=input-group-control]:bg-transparent! *:data-[slot=input-group-control]:hover:bg-transparent! *:data-[slot=input-group-control]:focus:bg-transparent! *:data-[slot=input-group-control]:focus-visible:bg-transparent!',
          isFixed && 'border-purple-400! hover:border-purple-400!'
        )}
        openBorderColor={isFixed ? '#c084fc' : undefined}
        openShadowColor={isFixed ? 'rgba(192,132,252,0.2)' : undefined}
        placeholder={lockSelection ? 'Балансировка нагрузки' : 'Выберите прокси'}
      >
        {selectedProxy?.icon && (
          <InputGroupAddon align="inline-start">
            <img
              src={selectedProxy.icon}
              alt=""
              className="size-4 shrink-0 rounded-sm object-contain"
              onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
            />
          </InputGroupAddon>
        )}
      </ComboboxInput>
      <ComboboxContent>
        <ComboboxEmpty>Ничего не найдено</ComboboxEmpty>
        <ComboboxList>
          {(proxyName: string) => (
            <ComboboxItem
              key={proxyName}
              value={proxyName}
              aria-disabled={disabledOptions[proxyName] || undefined}
              className={cn(
                disabledOptions[proxyName] &&
                'pointer-events-none cursor-not-allowed opacity-70 [&_[data-slot=proxy-delay-test]]:pointer-events-auto'
              )}
            >
              <CollapsedProxyOption proxyName={proxyName} disabled={!!disabledOptions[proxyName]} onTestSingle={onTestSingle} />
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
})

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

/* ====================== СТРОКА СЕЛЕКТОРА ====================== */
const SelectorRow = memo(function SelectorRow({
  selectorName,
  onTestAll,
  onSelect,
  onTestSingle,
  onClearFixed,
  collapsed,
  onToggleCollapse,
  orderControls,
}: {
  selectorName: string
  onTestAll: (name: string) => void
  onSelect: (selectorName: string, proxyName: string) => void
  onTestSingle: (proxyName: string) => Promise<void>
  onClearFixed: (selectorName: string) => Promise<void>
  collapsed: boolean
  onToggleCollapse: (name: string) => void
  orderControls?: import('react').ReactNode
}) {
  const cardOrder = useCardOrder(s => s.order)
  const moveCard = useCardOrder(s => s.move)
  const [draggedCard, setDraggedCard] = useState<string | null>(null)
  const selector = useRoutingProxies((s) => s.proxies[selectorName] as ProxyInfo | undefined)
  const isTesting = useSelectorsStore((s) => !!s.testingAll[selectorName])
  const selectedProxy = useRoutingProxies((s) => {
    const currentName = (s.proxies[selectorName] as ProxyInfo | undefined)?.now
    return currentName ? (s.proxies[currentName] as ProxyInfo | undefined) : undefined
  })

  if (!selector) return null

  const allProxies = selector.all ?? []
  const autoPolicy = AUTO_POLICY_TYPES.has(selector.type)
  const lockSelection = selector.type === 'LoadBalance'
  const selectedDelay = selectedProxy ? getLastDelay(selectedProxy) : null
  const showSelectedDelay = !!selectedProxy && selectedDelay !== null && selectedDelay > 0

  const hideUnavailable = false
  const hideCounter = 3
  const sortOrder = "default" as "default" | "name" | "ping"
  const allProxiesMap = useRoutingProxies((s) => s.proxies as Record<string, ProxyInfo | undefined>)

  const filteredSortedProxies = useMemo(() => {
    let result = allProxies.filter((name) => isRouteOption(name, isGeneralSelector(selectorName), allProxiesMap)
      && !(name !== 'DIRECT' && isNoVpn(name) && allProxies.includes('DIRECT')))
    if (hideUnavailable) {
      result = result.filter((name) => !hasNConsecutiveTimeouts(allProxiesMap[name], hideCounter))
    }
    result = sortProxyNames(result, sortOrder, allProxiesMap)
    return orderedCards(result, cardOrder)
  }, [allProxies, selectorName, hideUnavailable, hideCounter, sortOrder, allProxiesMap, cardOrder])

  return (
    <div className="border-border bg-input-background rounded-xl border p-4">
      <div className="mb-2.5 flex flex-col gap-2">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {orderControls}
            {selector.icon && (
              <img
                src={selector.icon}
                alt=""
                className="size-6 shrink-0 rounded-sm object-contain"
                onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
              />
            )}
            <span className="truncate text-base font-semibold">{displayName(selectorName)}</span>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={collapsed ? 'Развернуть селектор' : 'Свернуть селектор'}
              onMouseDown={blurActiveElement}
              onClick={() => onToggleCollapse(selectorName)}
            >
              {collapsed ? <IconChevronDown size={13} /> : <IconChevronUp size={13} />}
            </Button>
            <Tooltip>
              <TooltipTrigger render={
                <Button
                  variant="outline"
                  size="sm"
                  className={cn('px-2 text-xs font-medium tabular-nums', showSelectedDelay && delayColor(selectedDelay))}
                  onClick={() => onTestAll(selectorName)}
                  disabled={isTesting}
                >
                  {isTesting ? <IconLoader2 size={13} className="animate-spin" /> : <IconBoltFilled size={13} />}
                  Пинг{showSelectedDelay ? ` ${selectedDelay} мс` : ''}
                </Button>
              } />
              <TooltipContent>HTTP GET через выбранное подключение</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <SelectorStatusRow
          selectorName={selectorName}
          label="Выбрано:"
          fixedProxyName={autoPolicy ? selector.fixed : undefined}
          onClearFixed={autoPolicy && selector.fixed ? () => onClearFixed(selectorName) : undefined}
        />
      </div>

      <div className="flex flex-col gap-0">
        <div
          className={cn(
            'grid',
            collapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              {filteredSortedProxies.map((proxyName) => (
                <div key={proxyName} draggable title="Перетащить карточку подключения"
                  onDragStart={event => { event.stopPropagation(); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', proxyName); setDraggedCard(proxyName) }}
                  onDragEnd={() => setDraggedCard(null)}
                  onDragOver={event => { if (draggedCard && draggedCard !== proxyName) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move' } }}
                  onDrop={event => { if (!draggedCard) return; event.preventDefault(); event.stopPropagation(); moveCard(draggedCard, proxyName, filteredSortedProxies); setDraggedCard(null) }}>
                <ProxyCard
                  key={proxyName}
                  proxyName={proxyName}
                  selectorName={selectorName}
                  autoPolicy={autoPolicy}
                  lockSelection={lockSelection}
                  onSelect={onSelect}
                  onTestSingle={onTestSingle}
                />
                </div>
              ))}
            </div>
          </div>
        </div>

        <div
          className={cn(
            'grid',
            collapsed ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
          )}
        >
          <div className={cn('min-h-0', collapsed ? 'overflow-visible' : 'overflow-hidden')}>
            <SelectorCombobox
              key={selectorName}
              selectorName={selectorName}
              options={filteredSortedProxies}
              autoPolicy={autoPolicy}
              lockSelection={lockSelection}
              onSelect={onSelect}
              onTestSingle={onTestSingle}
              visible={collapsed}
            />
          </div>
        </div>
      </div>
    </div>
  )
})

/* ====================== ОСНОВНОЙ КОМПОНЕНТ ====================== */
function SelectorsBody({ clashApiPort, mode, clashApiSecret, clashApiUnix, onCollapsedStateChange, configContent, onDeviceSelect, onSaveRoute, onImportRoutes, onRemoveRoute, onReorderRoute, onToggleRoute, onSelectDraft }: Props) {
  const { showToast } = useAppContext()
  const loading = useRoutingProxies((s) => s.loading)
  const error = useRoutingProxies((s) => s.error)
  const [collapsedSelectors, setCollapsedSelectors] = useState<Record<string, boolean>>(() => readCollapsedSelectors())
  const [deviceIp, setDeviceIp] = useState(() => sessionStorage.getItem(DEVICE_IP_KEY) ?? '')
  const [newIp, setNewIp] = useState('')
  const [devicePending, setDevicePending] = useState(false)
  const testingGroups = useSelectorsStore((s) => s.testingAll)
  const [addingRoute, setAddingRoute] = useState(false)
  const [routeSearch, setRouteSearch] = useState('')
  const [routeName, setRouteName] = useState('')
  const [routeDomains, setRouteDomains] = useState('')
  const [routeResourcesValid, setRouteResourcesValid] = useState(true)
  const [routeTarget, setRouteTarget] = useState('DIRECT')
  const [routeNetwork, setRouteNetwork] = useState<MihomoRouteNetwork>('tcp,udp')
  const [routePending, setRoutePending] = useState(false)
  const importInput = useRef<HTMLInputElement>(null)
  const [draggedRoute, setDraggedRoute] = useState<RouteTag | null>(null)
  const [deletingTag, setDeletingTag] = useState<RouteTag | null>(null)
  const [editingTag, setEditingTag] = useState<RouteTag | null>(null)
  const [editingName, setEditingName] = useState('')
  const [editingTarget, setEditingTarget] = useState('DIRECT')
  const [editingNetwork, setEditingNetwork] = useState<MihomoRouteNetwork | 'mixed'>('tcp,udp')
  const [resources, setResources] = useState<string[]>([])
  const [editingResourcesValid, setEditingResourcesValid] = useState(true)
  const [resourceSearch, setResourceSearch] = useState('')
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

  const clearFixedSelection = useCallback(
    async (selectorName: string) => {
      try {
        await clashFetch(clashApiPort, `proxies/${encodeURIComponent(selectorName)}`, {
          method: 'DELETE',
          secret: clashApiSecret,
          unix: clashApiUnix ?? null,
        })
        await fetchClashProxies(clashApiPort, clashApiSecret, true, clashApiUnix ?? null)
      } catch {
        /* */
      }
    },
    [clashApiPort, clashApiSecret, clashApiUnix]
  )

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
  const activeDeviceDirect = !!activeDevice && isMihomoFullRoute(activeDevice.choices.VPN)
  const orderedSelectorNames = useMemo(() => {
    const priority = orderedTags.map((tag) => defaultChoices[tag])
    return [...selectorNames].sort((a, b) => {
      if (isGeneralSelector(a)) return -1
      if (isGeneralSelector(b)) return 1
      return (priority.indexOf(a) < 0 ? Infinity : priority.indexOf(a)) - (priority.indexOf(b) < 0 ? Infinity : priority.indexOf(b))
    })
  }, [selectorNames, orderedTags, defaultChoices])

  async function moveRoute(source: RouteTag, target: RouteTag) {
    if (source === target || routePending) return
    setRoutePending(true)
    try { await onReorderRoute(source, target) } finally { setRoutePending(false); setDraggedRoute(null) }
  }

  const persistedCollapsedSelectors = useMemo(
    () => Object.fromEntries(selectorNames.map((name) => [name, collapsedSelectors[name] ?? false])),
    [selectorNames, collapsedSelectors]
  )

  useEffect(() => {
    localStorage.setItem(COLLAPSE_SELECTORS_KEY, JSON.stringify(persistedCollapsedSelectors))
  }, [persistedCollapsedSelectors])

  useEffect(() => {
    onCollapsedStateChange?.(selectorNames.length > 0 && selectorNames.every((name) => persistedCollapsedSelectors[name]))
  }, [onCollapsedStateChange, persistedCollapsedSelectors, selectorNames])

  useEffect(() => {
    function handleToggleAll(event: Event) {
      const collapsed = (event as CustomEvent<{ collapsed?: boolean }>).detail?.collapsed
      if (typeof collapsed !== 'boolean') return
      blurActiveElement()
      setCollapsedSelectors((prev) => {
        const next = { ...prev }
        for (const name of selectorNames) next[name] = collapsed
        return next
      })
    }

    window.addEventListener(TOGGLE_ALL_SELECTORS_EVENT, handleToggleAll as EventListener)
    return () => window.removeEventListener(TOGGLE_ALL_SELECTORS_EVENT, handleToggleAll as EventListener)
  }, [selectorNames])

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

  const resourceOptions = useMemo(() => {
    try {
      const config = yaml.load(configContent) as any
      const providers = Object.keys(config?.['rule-providers'] ?? {}).map(name => `RULE-SET,${name}`)
      const existing = orderedTags.flatMap(tag => readMihomoRouteResources(configContent, tag))
      return [...new Set([...providers, ...existing])]
    } catch { return [] }
  }, [configContent, orderedTags])
  const providerBehaviors = useMemo(() => {
    try {
      const providers = (yaml.load(configContent) as any)?.['rule-providers'] ?? {}
      return Object.fromEntries(Object.entries(providers).map(([name, value]) => [name, String((value as any)?.behavior ?? '')])) as Record<string, string>
    } catch { return {} as Record<string, string> }
  }, [configContent])
  function destinationSummary(values: string[]) {
    const domains: string[] = []
    const ips: string[] = []
    for (const value of values) {
      const [kind, ...rest] = value.split(',')
      const name = rest.join(',')
      const target = kind === 'GEOIP' || kind === 'IP-CIDR' || kind === 'IP-CIDR6' || (kind === 'RULE-SET' && providerBehaviors[name] === 'ipcidr') ? ips : domains
      target.push(kind === 'RULE-SET' ? `Rule-set: ${name}` : kind === 'GEOSITE' || kind === 'GEOIP' ? `${kind}: ${name}` : kind.startsWith('DOMAIN') ? name : value)
    }
    return <div className="max-h-24 overflow-auto break-words">{domains.length > 0 && <div><span className="font-medium text-foreground">Домены:</span> {domains.join(' · ')}</div>}{ips.length > 0 && <div><span className="font-medium text-foreground">IP:</span> {ips.join(' · ')}</div>}{!domains.length && !ips.length && '—'}</div>
  }
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
  function openRouteEditor(route: RouteTag) {
    const group = defaultChoices[route]
    const choice = activeDevice?.choices[route]
    setEditingTag(route)
    setEditingName(routeLabel(route))
    setResources(route === 'VPN' ? [] : readMihomoRouteResources(configContent, route))
    setEditingResourcesValid(true)
    setEditingTarget(choice === group ? '@inherit' : choice === '@direct' ? 'DIRECT' : choice ?? allProxyData[group]?.now ?? 'DIRECT')
    setEditingNetwork(readMihomoRouteNetwork(configContent, route))
    setResourceSearch('')
  }
  function routeControls(route: RouteTag) {
    const index = orderedTags.indexOf(route)
    return <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-muted-foreground flex w-7 justify-center rounded border px-1 py-0.5 tabular-nums">{route === 'VPN' ? orderedTags.length + 1 : index + 1}</span>
      {route !== 'VPN' && <>
        <span draggable={!routePending} onDragStart={event => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', route); setDraggedRoute(route) }} onDragEnd={() => setDraggedRoute(null)} className="text-muted-foreground cursor-grab p-1 active:cursor-grabbing" title="Перетащить правило"><IconGripVertical size={18} /></span>
        <Button size="icon-xs" title="Изменить правило" aria-label="Изменить правило" variant="outline" disabled={routePending} onClick={() => openRouteEditor(route)}>✎</Button>
        <Button size="icon-xs" title="Удалить маршрут" aria-label="Удалить маршрут" variant="outline" disabled={routePending} onClick={() => setDeletingTag(route)}>×</Button>
      </>}
      {route === 'VPN' && <Button size="icon-xs" title="Изменить исходящее" aria-label="Изменить исходящее" variant="outline" disabled={routePending} onClick={() => openRouteEditor(route)}>✎</Button>}
    </div>
  }

  const selectProxy = useCallback((name: string, target: string) => {
    void onSelectDraft(name, target)
  }, [onSelectDraft])

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

  const toggleCollapse = useCallback((selectorName: string) => {
    blurActiveElement()
    setCollapsedSelectors((prev) => ({ ...prev, [selectorName]: !prev[selectorName] }))
  }, [])

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
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-base font-semibold">Общий маршрут</h3><div className="ml-auto flex items-center gap-2"><Button size="sm" variant="outline" onClick={() => window.dispatchEvent(new Event('mihomo:open-subscriptions'))}>Подписки</Button><Button size="sm" variant="outline" disabled={!!testingGroups[generalSelector ?? 'VPN']} onClick={() => void testAll(generalSelector ?? 'VPN', protocolCards.filter(name => canProbe(allProxyData[name])))}><IconBoltFilled size={16} />{testingGroups[generalSelector ?? 'VPN'] ? 'Проверка…' : 'Пинг'}</Button></div></div>
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
        {<div className="order-2 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => { setRouteTarget(allProxyData[defaultChoices.VPN]?.now ?? 'DIRECT'); setRouteNetwork('tcp,udp'); setRouteResourcesValid(true); setAddingRoute(true) }}>{activeDevice ? '+ Добавить общее правило' : '+ Добавить правило'}</Button>
          <input ref={importInput} type="file" accept=".json,application/json" className="hidden" aria-label="Файл правил Mihomo" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importRoutes(file) }} />
          {!activeDevice && <><Button size="sm" variant="outline" disabled={routePending} onClick={() => importInput.current?.click()}>Импорт</Button><Button size="sm" variant="outline" onClick={exportRoutes}>Экспорт</Button></>}
          {!activeDevice && <Button size="sm" className="ml-auto" variant={globalDirect ? 'default' : 'outline'} disabled={routePending} onClick={() => void onSelectDraft(defaultChoices.VPN, globalDirect ? 'DIRECT' : '@bypass')}>🔓 Полный обход без VPN: {globalDirect ? 'включён' : 'выключен'}</Button>}
          <Dialog open={addingRoute} onOpenChange={setAddingRoute}><DialogContent className="max-w-[min(94vw,680px)]! max-h-[85dvh] overflow-y-auto"><DialogHeader><DialogTitle>Новое правило</DialogTitle></DialogHeader><div className="flex flex-col gap-4">
<label className="space-y-2 text-sm font-medium">Комментарий<Input value={routeName} onChange={(event) => setRouteName(event.target.value)} placeholder="Например, Работа или Видеосервисы" aria-label="Название маршрута" maxLength={40} /></label>
            <Input value={routeSearch} onChange={(event) => setRouteSearch(event.target.value)} placeholder="Найти сервис: Telegram, YouTube, нейронки…" aria-label="Поиск сервиса" />
            <div className="flex flex-wrap gap-2">{findRoutePresets(routeSearch).map((preset) => <Button key={preset.name} size="sm" variant="outline" onClick={() => { setRouteName(current => current || preset.name); setRouteDomains(current => [...new Set([...current.split('\n').filter(Boolean), ...preset.domains])].join('\n')); setRouteResourcesValid(true) }}>{preset.name}</Button>)}</div>

            <div className="flex flex-wrap gap-2">{routeDomains.split('\n').filter(Boolean).map(value => <button key={value} type="button" className="rounded border border-blue-400 bg-blue-500/20 px-2 py-1 text-xs" onClick={() => { setRouteDomains(routeDomains.split('\n').filter(item => item !== value).join('\n')); setRouteResourcesValid(true) }}>{value} ×</button>)}</div>
            <MihomoResourceFields resources={routeDomains.split('\n').filter(Boolean)} onChange={values => setRouteDomains(values.join('\n'))} onValidChange={setRouteResourcesValid} providerBehaviors={providerBehaviors} />
          <div className="max-h-64 overflow-y-auto rounded border p-1">{resourceOptions.filter(value => value.toLowerCase().includes(routeSearch.toLowerCase())).map(value => { const selected = routeDomains.split('\n').includes(value); return <button type="button" key={value} aria-pressed={selected} className={cn('block w-full rounded px-2 py-2 text-left hover:bg-blue-500/10', selected && 'bg-blue-500/20')} onClick={() => { setRouteDomains(selected ? routeDomains.split('\n').filter(item => item !== value).join('\n') : [...routeDomains.split('\n').filter(Boolean), value].join('\n')); setRouteResourcesValid(true) }}>{selected ? '✓ ' : ''}{value}</button> })}</div>

            <label className="space-y-2 text-sm font-medium">Сеть<select className="border-border bg-input-background w-full rounded-lg border px-3 py-2 text-sm" value={routeNetwork} onChange={event => setRouteNetwork(event.target.value as MihomoRouteNetwork)}><option value="tcp,udp">TCP, UDP</option><option value="tcp">TCP</option><option value="udp">UDP</option></select></label>
            <label className="space-y-2 text-sm font-medium">Исходящее<select className="border-border bg-input-background w-full rounded-lg border px-3 py-2 text-sm" value={routeTarget} onChange={event => setRouteTarget(event.target.value)}>{[...new Set([routeTarget, ...protocolCards])].map(name => <option key={name} value={name}>{displayName(name)}</option>)}</select></label>
            <Button size="sm" disabled={routePending || !routeResourcesValid || !routeName.trim() || !routeDomains.trim()} onClick={async () => { setRoutePending(true); try { const saved = await onSaveRoute(null, routeName, routeDomains.split(/\r?\n/).map((domain) => domain.trim()).filter(Boolean), routeTarget, activeDevice?.ip, routeNetwork); if (saved) { setRouteName(''); setRouteDomains(''); setRouteSearch(''); setRouteResourcesValid(true); setAddingRoute(false) } } finally { setRoutePending(false) } }}>Создать правило</Button>
          </div></DialogContent></Dialog>

        </div>}
        <p className="text-muted-foreground order-1 text-xs">Карточки можно перетаскивать мышью. <button type="button" className="ml-2 underline" onClick={resetCards}>Стандартный порядок</button></p>
        <Dialog open={!!deletingTag} onOpenChange={open => { if (!open && !routePending) setDeletingTag(null) }}><DialogContent><DialogHeader><DialogTitle>Удалить маршрут «{deletingTag ? routeLabel(deletingTag) : ''}»?</DialogTitle></DialogHeader><p className="text-muted-foreground">Маршрут будет удалён из общей маршрутизации и правил устройств сразу после проверки конфигурации.</p><div className="flex justify-end gap-2"><Button variant="outline" disabled={routePending} onClick={() => setDeletingTag(null)}>Отмена</Button><Button variant="destructive" disabled={routePending} onClick={async () => { if (!deletingTag) return; setRoutePending(true); try { if (await onRemoveRoute(deletingTag)) setDeletingTag(null) } finally { setRoutePending(false) } }}>{routePending ? 'Удаление…' : 'Удалить'}</Button></div></DialogContent></Dialog>
        <Dialog open={!!editingTag} onOpenChange={open => { if (!open) setEditingTag(null) }}><DialogContent className="max-w-[min(94vw,680px)]! max-h-[85dvh] overflow-y-auto"><DialogHeader><DialogTitle>Правило: {editingTag ? routeLabel(editingTag) : ''}</DialogTitle></DialogHeader>
          {editingTag?.startsWith('custom:') && <label className="space-y-2 text-sm font-medium">Комментарий<Input value={editingName} maxLength={40} onChange={event => setEditingName(event.target.value)} /></label>}
          {editingTag !== 'VPN' && !activeDevice && <><p className="text-muted-foreground text-sm">Ресурсы правила общие для всех устройств.</p>
          <div className="flex flex-wrap gap-2">{resources.map(value => <button key={value} type="button" className="rounded border border-blue-400 bg-blue-500/20 px-2 py-1 text-xs" onClick={() => { setResources(resources.filter(item => item !== value)); setEditingResourcesValid(true) }}>{value} ×</button>)}</div>
          <MihomoResourceFields resources={resources} onChange={setResources} onValidChange={setEditingResourcesValid} providerBehaviors={providerBehaviors} />
          <Input value={resourceSearch} onChange={event => setResourceSearch(event.target.value)} placeholder="Поиск ресурса…" />
          <div className="max-h-64 overflow-y-auto rounded border p-1">{resourceOptions.filter(value => value.toLowerCase().includes(resourceSearch.toLowerCase())).map(value => <button type="button" key={value} aria-pressed={resources.includes(value)} className={cn('block w-full rounded px-2 py-2 text-left hover:bg-blue-500/10', resources.includes(value) && 'bg-blue-500/20')} onClick={() => { setResources(resources.includes(value) ? resources.filter(item => item !== value) : [...resources, value]); setEditingResourcesValid(true) }}>{resources.includes(value) ? '✓ ' : ''}{value}</button>)}</div></>}
          {editingTag !== 'VPN' && !activeDevice && <label className="space-y-2 text-sm font-medium">Сеть<select className="border-border bg-input-background w-full rounded-lg border px-3 py-2 text-sm" value={editingNetwork} onChange={event => setEditingNetwork(event.target.value as MihomoRouteNetwork)}>{editingNetwork === 'mixed' && <option value="mixed" disabled>Смешанная — выберите сеть</option>}<option value="tcp,udp">TCP, UDP</option><option value="tcp">TCP</option><option value="udp">UDP</option></select></label>}
          <label className="space-y-2 text-sm font-medium">Исходящее<select className="border-border bg-input-background w-full rounded-lg border px-3 py-2 text-sm" value={editingTarget} onChange={event => setEditingTarget(event.target.value)}>{activeDevice && <option value="@inherit">Общая настройка</option>}{[...new Set([editingTarget, ...protocolCards])].filter(name => name !== '@inherit').map(name => <option key={name} value={name}>{displayName(name)}</option>)}</select></label>
          {activeDevice && editingTag !== 'VPN' && <p className="text-muted-foreground text-sm">Для этого устройства меняется только исходящее. Домены и IP задаются в общей маршрутизации.</p>}
          <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setEditingTag(null)}>Отмена</Button><Button disabled={routePending || !editingResourcesValid || (editingTag !== 'VPN' && !resources.length) || (!activeDevice && editingTag !== 'VPN' && editingNetwork === 'mixed') || !editingName.trim()} onClick={async () => { if (!editingTag) return; setRoutePending(true); try { if (await onSaveRoute(editingTag, editingName, resources, editingTarget, activeDevice?.ip, editingNetwork === 'mixed' ? undefined : editingNetwork)) setEditingTag(null) } finally { setRoutePending(false) } }}>Применить</Button></div>
        </DialogContent></Dialog>
        {globalDirect && <p className="text-muted-foreground order-2 text-sm">Общий трафик идёт напрямую. Для отдельных правил и устройств можно выбрать VPN ниже.</p>}
        {<div className="border-border bg-card order-3 overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[900px] table-fixed text-left text-sm">
            <thead className="bg-input-background text-muted-foreground"><tr><th className="w-16 px-3 py-3 font-medium">#</th><th className="w-40 px-3 py-3 font-medium">Действия</th><th className="w-24 px-3 py-3 font-medium">Включить</th><th className="w-40 px-3 py-3 font-medium">Комментарий</th><th className="w-24 px-3 py-3 font-medium">Сеть</th><th className="px-3 py-3 font-medium">Пункт назначения</th><th className="w-52 px-3 py-3 font-medium">Исходящее</th></tr></thead>
            <tbody>{[...orderedTags, 'VPN'].map(route => {
              const group = defaultChoices[route]
              const inherited = !!activeDevice && activeDevice.choices[route] === group
              const choice = activeDevice ? activeDevice.choices[route] : allProxyData[group]?.now
              const target = choice === '@direct' ? 'DIRECT' : inherited ? allProxyData[group]?.now ?? group : choice ?? 'DIRECT'
              const proxy = allProxyData[target]
              const delay = proxy ? getLastDelay(proxy) : null
              const values = route === 'VPN' ? [] : readMihomoRouteResources(configContent, route)
              return <tr key={route} className="border-border border-t hover:bg-muted/20"
                onDragOver={event => { if (draggedRoute && route !== 'VPN' && route !== draggedRoute) event.preventDefault() }}
                onDrop={event => { event.preventDefault(); if (draggedRoute && route !== 'VPN') void moveRoute(draggedRoute, route) }}>
                <td className="px-3 py-3 text-muted-foreground tabular-nums">{route === 'VPN' ? orderedTags.length + 1 : orderedTags.indexOf(route) + 1}</td>
                <td className="px-3 py-3"><div className="flex items-center gap-1">{route !== 'VPN' && <><span draggable={!routePending} onDragStart={event => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', route); setDraggedRoute(route) }} onDragEnd={() => setDraggedRoute(null)} className="text-muted-foreground cursor-grab p-1" title="Перетащить правило"><IconGripVertical size={17} /></span><Button size="icon-xs" title="Повысить приоритет" aria-label={`Повысить приоритет ${routeLabel(route)}`} variant="outline" disabled={routePending || orderedTags.indexOf(route) < 1} onClick={() => void moveRoute(route, orderedTags[orderedTags.indexOf(route) - 1])}><IconChevronUp size={14} /></Button><Button size="icon-xs" title="Понизить приоритет" aria-label={`Понизить приоритет ${routeLabel(route)}`} variant="outline" disabled={routePending || orderedTags.indexOf(route) >= orderedTags.length - 1} onClick={() => void moveRoute(route, orderedTags[orderedTags.indexOf(route) + 1])}><IconChevronDown size={14} /></Button></>}<Button size="icon-xs" title="Изменить правило" aria-label="Изменить правило" variant="outline" onClick={() => openRouteEditor(route)}>✎</Button>{route !== 'VPN' && <Button size="icon-xs" title="Удалить правило" aria-label="Удалить правило" variant="outline" onClick={() => setDeletingTag(route)}>×</Button>}</div></td>
                <td className="px-3 py-3"><Switch size="sm" checked={isMihomoRouteEnabled(configContent, route, activeDevice?.ip)} disabled={routePending} aria-label={`${isMihomoRouteEnabled(configContent, route, activeDevice?.ip) ? 'Выключить' : 'Включить'} ${routeLabel(route)}`} onCheckedChange={checked => { setRoutePending(true); void onToggleRoute(route, checked, activeDevice?.ip).finally(() => setRoutePending(false)) }} /></td>
                <td className="px-3 py-3 font-medium">{routeLabel(route)}</td>
                <td className="text-muted-foreground px-3 py-3">{route === 'VPN' ? 'TCP, UDP' : readMihomoRouteNetwork(configContent, route) === 'mixed' ? 'Смешанная' : readMihomoRouteNetwork(configContent, route).toUpperCase().replace(',', ', ')}</td>
                <td className="px-3 py-3 text-sm">{route === 'VPN' ? 'Остальной трафик' : destinationSummary(values)}</td>
                <td className="px-3 py-3"><div className="flex items-center gap-2"><button type="button" className="min-w-0 truncate text-left text-primary hover:underline" onClick={() => openRouteEditor(route)} title="Изменить исходящее в правиле">{displayName(target)}</button>{canProbe(proxy) && <button type="button" className={cn('shrink-0 text-xs tabular-nums', delay === null ? 'text-sky-400' : delayColor(delay))} title="HTTPS через выбранное подключение" onClick={() => void testSingle(target)}>{delay === null ? 'Пинг' : delay > 0 ? `${delay} мс` : '✕'}</button>}</div></td>
              </tr>
            })}</tbody>
          </table>
        </div>}
        <details className="order-4 rounded-xl border p-3"><summary className="cursor-pointer text-sm">Настройки групп Mihomo</summary>
        {!activeDevice && orderedSelectorNames.filter(name => !globalDirect || isGeneralSelector(name)).map((name) => {
          const route = orderedTags.find((tag) => defaultChoices[tag] === name)
          return <div key={name} onDragOver={(event) => { if (route && draggedRoute && draggedRoute !== route) { event.preventDefault(); event.dataTransfer.dropEffect = 'move' } }} onDrop={(event) => { event.preventDefault(); if (route && draggedRoute) void moveRoute(draggedRoute, route) }}>
            <SelectorRow
            key={name}
            selectorName={name}
            orderControls={routeControls(route ?? 'VPN')}
            onTestAll={testAll}
            onSelect={selectProxy}
            onTestSingle={testSingle}
            onClearFixed={clearFixedSelection}
            collapsed={!!collapsedSelectors[name]}
            onToggleCollapse={toggleCollapse}
            />
          </div>
        })}
        {activeDeviceDirect && <p className="text-muted-foreground text-sm">Для {activeDevice?.ip} выбран полный маршрут: {displayName(activeDevice.choices.VPN)}. Правила сервисов не применяются.</p>}
        {activeDevice && ['VPN', ...new Set(orderedTags)].filter(route => !activeDeviceDirect || route === 'VPN').map((route) => (
          <section key={route} className="border-border bg-input-background rounded-xl border p-4"
            onDragOver={event => { if (draggedRoute && draggedRoute !== route && route !== 'VPN') { event.preventDefault(); event.dataTransfer.dropEffect = 'move' } }}
            onDrop={event => { event.preventDefault(); if (draggedRoute && route !== 'VPN') void moveRoute(draggedRoute, route) }}>
            <div className="mb-2 flex flex-wrap items-center gap-2 text-[15px] font-medium">{routeControls(route)}<RouteIcon route={route} />{routeLabel(route)}<Button size="sm" variant="outline" className="ml-auto" disabled={!!testingGroups[defaultChoices[route]]} onClick={() => void testAll(defaultChoices[route], deviceOptions.filter((name) => name === 'DIRECT' || (!isNoVpn(name) && isRouteOption(name, route === 'VPN', allProxyData))))}> <IconBoltFilled size={16} />{testingGroups[defaultChoices[route]] ? 'Пинг…' : 'Пинг'}</Button></div>
            {route === 'VPN' && <Button size="sm" className="mb-2" variant={activeDevice.choices.VPN === 'DIRECT' ? 'default' : 'outline'} disabled={devicePending} onClick={() => void changeDevice(activeDevice.ip, route, activeDevice.choices.VPN === 'DIRECT' ? '@direct' : 'DIRECT')}>Полный обход</Button>}
            <div className="text-muted-foreground mb-3 text-sm">Выбрано: {displayName(activeDevice.choices[route] === '@direct' ? 'DIRECT' : activeDevice.choices[route] === defaultChoices[route] ? allProxyData[defaultChoices[route]]?.now ?? activeDevice.choices[route] : activeDevice.choices[route])}</div>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              {orderedCards(sortProxyNames(deviceOptions.filter((name) => name === 'DIRECT' || (!isNoVpn(name) && isRouteOption(name, route === 'VPN', allProxyData))), 'default', allProxyData), cardOrder).map((name, _, cards) => {
                const proxy = allProxyData[name]
                const selected = activeDevice.choices[route] === '@direct' ? 'DIRECT' : activeDevice.choices[route] === defaultChoices[route] ? allProxyData[defaultChoices[route]]?.now ?? activeDevice.choices[route] : activeDevice.choices[route]
                const delay = proxy ? getLastDelay(proxy) : null
                return <div key={name} draggable={!devicePending} title="Перетащить карточку подключения"
                  onDragStart={event => { event.stopPropagation(); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', name); setDraggedProtocol(name) }}
                  onDragEnd={() => setDraggedProtocol(null)}
                  onDragOver={event => { if (draggedProtocol && draggedProtocol !== name) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move' } }}
                  onDrop={event => { if (!draggedProtocol) return; event.preventDefault(); event.stopPropagation(); moveCard(draggedProtocol, name, cards); setDraggedProtocol(null) }} role="button" tabIndex={0} aria-pressed={selected === name} aria-disabled={devicePending}
                  onClick={() => { if (!devicePending && activeDevice.choices[route] !== (route === 'VPN' && name === 'DIRECT' ? '@direct' : name)) void changeDevice(activeDevice.ip, route, route === 'VPN' && name === 'DIRECT' ? '@direct' : name) }}
                  onKeyDown={(event) => { if ((event.key === 'Enter' || event.key === ' ') && !devicePending && activeDevice.choices[route] !== (route === 'VPN' && name === 'DIRECT' ? '@direct' : name)) { event.preventDefault(); void changeDevice(activeDevice.ip, route, route === 'VPN' && name === 'DIRECT' ? '@direct' : name) } }}
                  className={cn('relative flex min-h-28 flex-col justify-between rounded-xl border p-3.5 pr-12 text-left text-sm', selected === name ? 'border-blue-400 bg-blue-500/20' : 'border-ring/40 hover:border-blue-400 hover:bg-blue-500/10', devicePending && 'opacity-60')}>
                  <span className="font-medium" title={name}>{proxy ? cardTitle(proxy) : displayName(name)}</span>
                  <span className="flex items-center justify-between gap-2"><span className="text-muted-foreground text-xs">{nodeTransports[name] ?? (proxy ? getProxyTransport(proxy) : 'Прямое соединение')}</span>
                    {canProbe(proxy) && <button type="button" title={pingErrors[name] || (specialPingTag(name) ? 'HTTP через туннель' : 'HTTPS через выбранное подключение')} aria-label={`Пинг ${name}`} className={cn('absolute right-2 top-2 rounded p-1 text-xs tabular-nums', delay === null ? 'text-muted-foreground' : delayColor(delay))} onClick={(event) => { event.stopPropagation(); void testSingle(name) }}>{useSelectorsStore.getState().testingSingle[name] ? '…' : delay === null ? <IconBoltFilled size={15} /> : delay > 0 ? `${delay} мс` : '✕'}</button>}
                  </span>
                </div>
              })}
            </div>
            {route !== 'VPN' && activeDevice.choices[route] !== defaultChoices[route] && <Button size="sm" variant="ghost" className="mt-2" disabled={devicePending} onClick={() => void changeDevice(activeDevice.ip, route, defaultChoices[route])}>Вернуть общую настройку</Button>}
          </section>
        ))}</details>
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

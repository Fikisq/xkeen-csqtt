import * as yaml from 'js-yaml'
import { DeviceTab } from '@/components/configuration/DeviceTab'
import { readSelections } from '@/lib/mihomoRoutingBackup'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList } from '@/components/ui/combobox'
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { InputGroupAddon } from '@/components/ui/input-group'
import { Input } from '@/components/ui/input'
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
  IconPlugX,
} from '@tabler/icons-react'
import { createContext, useContext, memo, useCallback, useEffect, useMemo, useState } from 'react'

import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { apiCall, clashFetch } from '../../../lib/api'
import { fetchClashProxies, useProxiesStore, useSettings, useAppContext } from '../../../lib/store'
import { defaultMihomoChoices, readMihomoFullBypass, isMihomoFullRoute, mihomoRouteTags, orderedMihomoRouteTags, readMihomoCustomRoutes, readMihomoDevices } from '../../../lib/mihomoDeviceRouting'
import { findRoutePresets } from '../../../lib/routePresets'
import { validDeviceIp, type RouteTag } from '../../../lib/xrayDeviceRouting'
import { RouteIcon, routeLabel } from '../RouteIcon'

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
  onAddRoute: (name: string, domains: string[]) => Promise<boolean>
  onRemoveRoute: (tag: string) => Promise<boolean>
  onRenameRoute: (tag: string, name: string) => Promise<boolean>
  onReorderRoute: (source: RouteTag, target: RouteTag) => Promise<boolean>
}

const NO_DELAY_TYPES = new Set(['reject', 'reject-drop', 'dns', 'pass', 'relay', 'direct', 'socks5'])
function specialPingTag(name: string): string | null {
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
  const type = proxy.type.toLowerCase()
  if (/^wdtt/i.test(proxy.name)) return 'Локальный SOCKS5 · TCP / UDP'
  const protocol = type === 'vless' ? 'VLESS' : type === 'hysteria2' || type === 'hy2' ? 'Hysteria2' : type === 'tuic' ? 'TUIC' : null
  if (!protocol) return displayName(proxy.name)
  const flag = proxy.name.match(/[\u{1F1E6}-\u{1F1FF}]{2}/u)?.[0]
  return `${flag ? flag + ' ' : ''}${protocol}`
}
function isProtocolProxy(proxy?: ProxyInfo): boolean {
  return !!proxy && ['vless', 'hysteria2', 'hy2', 'tuic'].includes(proxy.type.toLowerCase())
}
function isRouteOption(name: string, general: boolean, proxies: Record<string, ProxyInfo | undefined>): boolean {
  if (proxies[`${name} · XKeen`]) return false
  if (name === 'DIRECT' && !general) return true
  const proxy = proxies[name]
  if (!proxy) return false
  if (isProtocolProxy(proxy) || /csqtt|wdtt/i.test(name) || isNoVpn(name)) return true
  if (name === 'DIRECT') return !Object.keys(proxies).some((key) => isNoVpn(key))
  return !general && isGeneralSelector(name)
}

interface SelectorsStore {
  testingAll: Record<string, boolean>
  testingSingle: Record<string, boolean>
  nodeTransports: Record<string, string>
  httpHistory: Record<string, ProxyHistory[]>
}

const useSelectorsStore = create<SelectorsStore>(() => ({
  testingAll: {},
  testingSingle: {},
  nodeTransports: {},
  httpHistory: {},
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

  const hideUnavailable = useSettings((s) => s.hideUnavailableProxies)
  const hideCounter = useSettings((s) => s.hideUnavailableProxiesCounter)
  const sortOrder = useSettings((s) => s.proxySortOrder)
  const allProxiesMap = useRoutingProxies((s) => s.proxies as Record<string, ProxyInfo | undefined>)

  const filteredSortedProxies = useMemo(() => {
    let result = allProxies.filter((name) => isRouteOption(name, isGeneralSelector(selectorName), allProxiesMap)
      && !(name !== 'DIRECT' && isNoVpn(name) && allProxies.includes('DIRECT')))
    if (hideUnavailable) {
      result = result.filter((name) => !hasNConsecutiveTimeouts(allProxiesMap[name], hideCounter))
    }
    result = sortProxyNames(result, sortOrder, allProxiesMap)
    return result
  }, [allProxies, selectorName, hideUnavailable, hideCounter, sortOrder, allProxiesMap])

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
                <ProxyCard
                  key={proxyName}
                  proxyName={proxyName}
                  selectorName={selectorName}
                  autoPolicy={autoPolicy}
                  lockSelection={lockSelection}
                  onSelect={onSelect}
                  onTestSingle={onTestSingle}
                />
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
function SelectorsBody({ clashApiPort, mode, clashApiSecret, clashApiUnix, onCollapsedStateChange, configContent, onDeviceSelect, onAddRoute, onRemoveRoute, onRenameRoute, onReorderRoute, onSelectDraft }: Props) {
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
  const [routePending, setRoutePending] = useState(false)
  const [draggedRoute, setDraggedRoute] = useState<RouteTag | null>(null)
  const [renamingTag, setRenamingTag] = useState('')
  const [renamingName, setRenamingName] = useState('')
  
  const devices = useMemo(() => readMihomoDevices(configContent), [configContent])
  const routeTags = useMemo(() => mihomoRouteTags(configContent), [configContent])
  const customRoutes = useMemo(() => readMihomoCustomRoutes(configContent), [configContent])
  const defaultChoices = useMemo(() => defaultMihomoChoices(configContent), [configContent])
  const orderedTags = useMemo(() => orderedMihomoRouteTags(configContent), [configContent])
  useEffect(() => { sessionStorage.setItem(DEVICE_IP_KEY, deviceIp) }, [deviceIp])
  const allProxyData = useRoutingProxies((s) => s.proxies as Record<string, ProxyInfo | undefined>)
  const nodeTransports = useSelectorsStore((s) => s.nodeTransports)
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
    async (proxyName: string) => {
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
        const data = await apiCall<{success: boolean; delay?: number; error?: string}>('POST', 'mihomo/node-ping', {name})
        if (!data.success) throw new Error(data.error || 'Нет ответа от узла')
        return data.delay && data.delay > 0 ? data.delay : 0
      } catch (error) {
        throw error
      }
    },
    [allProxyData]
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
        if (!Object.values(defaultChoices).includes(p.name)) return false
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
        await fetchClashProxies(clashApiPort, clashApiSecret, true, clashApiUnix ?? null)
        applyDelayResults([[proxyName, delay]])
      } catch (error) {
        applyDelayResults([[proxyName, 0]])
        showToast(error instanceof Error ? error.message : 'Не удалось проверить подключение', 'error')
      } finally {
        useSelectorsStore.setState((s) => ({ testingSingle: { ...s.testingSingle, [proxyName]: false } }))
      }
    },
    [applyDelayResults, clashApiPort, clashApiSecret, clashApiUnix, requestProxyDelay, showToast]
  )

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
        const results: Array<readonly [string, number]> = []
        for (const name of names) {
          try { results.push([name, await requestProxyDelay(name)]) }
          catch { results.push([name, 0]) }
        }
        await fetchClashProxies(clashApiPort, clashApiSecret, true, clashApiUnix ?? null)
        applyDelayResults(results)
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
      <div className="text-muted-foreground absolute inset-4 flex items-center justify-center text-sm">
        <Spinner className="mr-2 size-5" /> Загрузка...
      </div>
    )
  }

  if (error || selectorNames.length === 0) {
    return (
      <div className="absolute inset-4">
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
        <div className="space-y-4">
        {!activeDeviceDirect && <div className="border-border border-b pb-3">
          <Button size="sm" variant="outline" onClick={() => setAddingRoute(true)}>+ Добавить маршрут</Button>
          <Dialog open={addingRoute} onOpenChange={setAddingRoute}><DialogContent className="max-w-[min(94vw,680px)]! max-h-[85dvh] overflow-y-auto"><DialogHeader><DialogTitle>Новый маршрут</DialogTitle></DialogHeader><div className="flex flex-col gap-4">
<label className="space-y-2 text-sm font-medium">Название маршрута<Input value={routeName} onChange={(event) => setRouteName(event.target.value)} placeholder="Например, Работа или Видеосервисы" aria-label="Название маршрута" maxLength={40} /></label>
            <Input value={routeSearch} onChange={(event) => setRouteSearch(event.target.value)} placeholder="Найти сервис: Telegram, YouTube, нейронки…" aria-label="Поиск сервиса" />
            <div className="flex flex-wrap gap-2">{findRoutePresets(routeSearch).map((preset) => <Button key={preset.name} size="sm" variant="outline" onClick={() => { setRouteName(current => current || preset.name); setRouteDomains(preset.domains.join('\n')) }}>{preset.name}</Button>)}</div>

            <textarea className="bg-input-background border-border min-h-20 rounded-md border p-2 text-sm" value={routeDomains} onChange={(event) => setRouteDomains(event.target.value)} placeholder="Домены, по одному в строке" aria-label="Домены маршрута" />
            <Button size="sm" disabled={routePending || !routeName.trim() || !routeDomains.trim()} onClick={async () => { setRoutePending(true); try { const saved = await onAddRoute(routeName, routeDomains.split(/\r?\n|,/).map((domain) => domain.trim()).filter(Boolean)); if (saved) { setRouteName(''); setRouteDomains(''); setRouteSearch(''); setAddingRoute(false) } } finally { setRoutePending(false) } }}>Создать маршрут</Button>
          </div></DialogContent></Dialog>
          {customRoutes.length > 0 && <div className="mt-3 flex flex-wrap gap-2">{customRoutes.map((route) => <div key={route.tag} className="border-border flex flex-wrap items-center gap-2 rounded-md border px-2 py-1 text-sm">
            {renamingTag === route.tag ? <>
              <Input className="w-48" value={renamingName} maxLength={40} onChange={(event) => setRenamingName(event.target.value)} aria-label="Новое название маршрута" />
              <Button size="sm" disabled={routePending || !renamingName.trim()} onClick={async () => { setRoutePending(true); try { if (await onRenameRoute(route.tag, renamingName)) { setRenamingTag(''); setRenamingName('') } } finally { setRoutePending(false) } }}>Сохранить</Button>
              <Button size="sm" variant="ghost" onClick={() => { setRenamingTag(''); setRenamingName('') }}>Отмена</Button>
            </> : <>
              <span>{route.name}</span>
              <Button size="sm" variant="ghost" disabled={routePending} onClick={() => { setRenamingTag(route.tag); setRenamingName(route.name) }}>Переименовать</Button>
              <Button size="sm" variant="ghost" disabled={routePending} onClick={async () => { if (!window.confirm(`Удалить маршрут «${route.name}»?`)) return; setRoutePending(true); try { await onRemoveRoute(route.tag) } finally { setRoutePending(false) } }}>Удалить</Button>
            </>}
          </div>)}</div>}
        </div>}
        {!activeDevice && <Button size="sm" variant={globalDirect ? 'default' : 'outline'} disabled={routePending} onClick={() => void onSelectDraft(defaultChoices.VPN, globalDirect ? 'DIRECT' : '@bypass')}>Полный обход</Button>}
        {globalDirect && <p className="text-muted-foreground text-sm">Общий трафик идёт напрямую. Для отдельных правил и устройств можно выбрать VPN ниже.</p>}
        {!activeDevice && orderedSelectorNames.filter(name => !globalDirect || isGeneralSelector(name)).map((name) => {
          const route = orderedTags.find((tag) => defaultChoices[tag] === name)
          const index = route ? orderedTags.indexOf(route) : -1
          return <div key={name} onDragOver={(event) => { if (route && draggedRoute && draggedRoute !== route) { event.preventDefault(); event.dataTransfer.dropEffect = 'move' } }} onDrop={(event) => { event.preventDefault(); if (route && draggedRoute) void moveRoute(draggedRoute, route) }}>
            <SelectorRow
            key={name}
            selectorName={name}
            orderControls={<div className="flex items-center gap-1.5 text-xs">
              <span className="text-muted-foreground flex w-7 justify-center rounded border px-1 py-0.5 tabular-nums">{isGeneralSelector(name) ? '−1' : route ? index + 1 : '—'}</span>
              {route && <>
                <span draggable={!routePending} onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', route); setDraggedRoute(route) }} onDragEnd={() => setDraggedRoute(null)} className="text-muted-foreground cursor-grab rounded p-1 active:cursor-grabbing" title={`Перетащить ${routeLabel(route)}`} aria-label={`Перетащить ${routeLabel(route)}`}><IconGripVertical size={18} /></span>
                <Button size="sm" variant="outline" disabled={routePending || index === 0} onClick={() => void moveRoute(route, orderedTags[index - 1])}>↑ Выше</Button>
                <Button size="sm" variant="outline" disabled={routePending || index === orderedTags.length - 1} onClick={() => void moveRoute(route, orderedTags[index + 1])}>↓ Ниже</Button>
              </>}
            </div>}
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
        {activeDevice && ['VPN', ...orderedTags, ...routeTags.filter((tag) => tag !== 'VPN' && !orderedTags.includes(tag))].filter(route => !activeDeviceDirect || route === 'VPN').map((route) => (
          <section key={route} className="border-border bg-input-background rounded-xl border p-4">
            <div className="mb-2 flex items-center gap-2 text-[15px] font-medium"><RouteIcon route={route} />{routeLabel(route)}<Button size="sm" variant="outline" className="ml-auto" disabled={!!testingGroups[defaultChoices[route]]} onClick={() => void testAll(defaultChoices[route], deviceOptions.filter((name) => name === 'DIRECT' || (!isNoVpn(name) && isRouteOption(name, route === 'VPN', allProxyData))))}> <IconBoltFilled size={16} />{testingGroups[defaultChoices[route]] ? 'Пинг…' : 'Пинг'}</Button></div>
            {route === 'VPN' && <Button size="sm" className="mb-2" variant={activeDevice.choices.VPN === 'DIRECT' ? 'default' : 'outline'} disabled={devicePending} onClick={() => void changeDevice(activeDevice.ip, route, activeDevice.choices.VPN === 'DIRECT' ? '@direct' : 'DIRECT')}>Полный обход</Button>}
            <div className="text-muted-foreground mb-3 text-sm">Выбрано: {displayName(activeDevice.choices[route] === '@direct' ? 'DIRECT' : activeDevice.choices[route] === defaultChoices[route] ? allProxyData[defaultChoices[route]]?.now ?? activeDevice.choices[route] : activeDevice.choices[route])}</div>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              {sortProxyNames(deviceOptions.filter((name) => name === 'DIRECT' || (!isNoVpn(name) && isRouteOption(name, route === 'VPN', allProxyData))), 'default', allProxyData).map((name) => {
                const proxy = allProxyData[name]
                const selected = activeDevice.choices[route] === '@direct' ? 'DIRECT' : activeDevice.choices[route] === defaultChoices[route] ? allProxyData[defaultChoices[route]]?.now ?? activeDevice.choices[route] : activeDevice.choices[route]
                const delay = proxy ? getLastDelay(proxy) : null
                return <div key={name} role="button" tabIndex={0} aria-pressed={selected === name} aria-disabled={devicePending}
                  onClick={() => { if (!devicePending && activeDevice.choices[route] !== (route === 'VPN' && name === 'DIRECT' ? '@direct' : name)) void changeDevice(activeDevice.ip, route, route === 'VPN' && name === 'DIRECT' ? '@direct' : name) }}
                  onKeyDown={(event) => { if ((event.key === 'Enter' || event.key === ' ') && !devicePending && activeDevice.choices[route] !== (route === 'VPN' && name === 'DIRECT' ? '@direct' : name)) { event.preventDefault(); void changeDevice(activeDevice.ip, route, route === 'VPN' && name === 'DIRECT' ? '@direct' : name) } }}
                  className={cn('relative flex min-h-28 flex-col justify-between rounded-xl border p-3.5 pr-12 text-left text-sm', selected === name ? 'border-blue-400 bg-blue-500/20' : 'border-ring/40 hover:border-blue-400 hover:bg-blue-500/10', devicePending && 'opacity-60')}>
                  <span className="font-medium" title={name}>{proxy ? cardTitle(proxy) : displayName(name)}</span>
                  <span className="flex items-center justify-between gap-2"><span className="text-muted-foreground text-xs">{nodeTransports[name] ?? (proxy ? getProxyTransport(proxy) : 'Прямое соединение')}</span>
                    {canProbe(proxy) && <button type="button" title={specialPingTag(name) ? 'HTTP через туннель' : 'HTTP GET через выбранное подключение'} aria-label={`Пинг ${name}`} className={cn('absolute right-2 top-2 rounded p-1 text-xs tabular-nums', delay === null ? 'text-muted-foreground' : delayColor(delay))} onClick={(event) => { event.stopPropagation(); void testSingle(name) }}>{delay === null ? <IconBoltFilled size={15} /> : delay || <GraveIcon size={14} />}</button>}
                  </span>
                </div>
              })}
            </div>
            {route !== 'VPN' && activeDevice.choices[route] !== defaultChoices[route] && <Button size="sm" variant="ghost" className="mt-2" disabled={devicePending} onClick={() => void changeDevice(activeDevice.ip, route, defaultChoices[route])}>Вернуть общую настройку</Button>}
          </section>
        ))}
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

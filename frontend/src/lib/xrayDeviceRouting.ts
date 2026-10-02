export const ROUTE_TAGS = ['VPN', 'Youtube', 'Discord', 'Games', 'AI', 'Github', 'RU'] as const
export const RU_IP_TAG = 'RU_IP'
export const ROSCOMVPN_DIRECT_IP = 'ext:roscomvpn-geoip-202609260832.dat:direct'
export type RouteTag = string

export function routeTags(rules: RoutingRule[]): string[] {
  return rules.map((rule) => baseRuleTag(rule))
    .filter((tag) => tag === RU_IP_TAG || ROUTE_TAGS.includes(tag as typeof ROUTE_TAGS[number]) || tag.startsWith('custom:'))
    .filter((tag, index, all) => all.indexOf(tag) === index)
}

export function customRouteName(tag: string): string {
  if (!tag.startsWith('custom:')) return tag
  try { return decodeURIComponent(tag.slice(7)) } catch { return tag.slice(7) }
}

export interface RoutingRule {
  type?: string
  ruleTag?: string
  outboundTag?: string
  balancerTag?: string
  sourceIP?: string[]
  domain?: string[]
  ip?: string[]
  network?: string
  [key: string]: unknown
}

export function validDeviceIp(ip: string): boolean {
  const parts = ip.trim().split('.')
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

export function deviceRuleTag(ip: string, route: RouteTag): string {
  return `device:${ip}:${route}`
}

export function baseRuleTag(rule: RoutingRule): string { return (rule.ruleTag ?? '').replace(/\|(selector|nfqws2|split|bypass)$/, '') }
export function usesSelector(rule: RoutingRule): boolean { return rule.ruleTag?.endsWith('|selector') ?? false }
// Legacy direct defaults keep their full bypass until explicitly changed.
export function isFullBypass(rule?: RoutingRule): boolean {
  return rule?.outboundTag === 'direct' && !rule.ruleTag?.endsWith('|split') && !rule.ruleTag?.endsWith('|selector')
}

// Each device owns a complete block, before all general service rules.
export function normalizeDevicePriority(rules: RoutingRule[]): RoutingRule[] {
  const deviceIp = (rule: RoutingRule) => /^device:([^:]+):/.exec(baseRuleTag(rule))?.[1]
  const vpnTag = (ip: string) => deviceRuleTag(ip, 'VPN')
  const locked = (rule?: RoutingRule) => isFullBypass(rule) || ['csqtt', 'wdtt-plus'].includes(rule?.outboundTag ?? '')
  const managed = new Set([...routeTags(rules), RU_IP_TAG])
  const unmanaged = rules.filter((rule) => !deviceIp(rule) && !managed.has(baseRuleTag(rule)))
  const devices = [...new Set(rules.map(deviceIp).filter((ip): ip is string => !!ip))]
  const blocks = devices.flatMap((ip) => {
    const own = rules.filter((rule) => deviceIp(rule) === ip)
    const vpn = own.find((rule) => baseRuleTag(rule) === vpnTag(ip))
    const services = own.filter((rule) => rule !== vpn)
    return vpn ? locked(vpn) ? [vpn, ...services] : [...services, vpn] : services
  })
  const general = rules.filter((rule) => !deviceIp(rule) && managed.has(baseRuleTag(rule)))
  const vpn = general.find((rule) => baseRuleTag(rule) === 'VPN')
  const services = general.filter((rule) => rule !== vpn)
  return [...unmanaged, ...blocks, ...(vpn ? locked(vpn) ? [vpn, ...services] : [...services, vpn] : services)]
}
export function fixedPriorityRuleIndices(rules: RoutingRule[]): number[] {
  const bypassIps = new Set(rules.flatMap((rule) => {
    const match = /^device:([^:]+):VPN$/.exec(baseRuleTag(rule))
    return match && isFullBypass(rule) ? [match[1]] : []
  }))
  return rules.flatMap((rule, index) => {
    const match = /^device:([^:]+):/.exec(baseRuleTag(rule))
    const deviceBypass = !!match && bypassIps.has(match[1])
    const localExclusion = !baseRuleTag(rule) && rule.outboundTag === 'direct' && Array.isArray(rule.ip) && rule.ip.length > 0
    return deviceBypass || localExclusion ? [index] : []
  })
}

export function reorderXrayRules(rules: RoutingRule[], order: number[]): RoutingRule[] {
  if (order.length !== rules.length || new Set(order).size !== rules.length || order.some((index) => !Number.isInteger(index) || index < 0 || index >= rules.length)) {
    throw new Error('Порядок правил устарел. Обновите страницу')
  }
  const fixed = fixedPriorityRuleIndices(rules)
  if (fixed.some((index) => order[index] !== index)) throw new Error('Правила полного обхода и локальной сети должны оставаться на своих местах')
  return order.map((index) => rules[index])
}
function destination(rule?: RoutingRule): Pick<RoutingRule, 'outboundTag' | 'balancerTag'> {
  return rule?.balancerTag ? { balancerTag: rule.balancerTag } : rule?.outboundTag ? { outboundTag: rule.outboundTag } : {}
}
function choice(rule: RoutingRule | undefined, selection: string, linked: boolean): Pick<RoutingRule, 'outboundTag' | 'balancerTag'> {
  return linked ? destination(rule) : { outboundTag: selection }
}

export function readDeviceIps(rules: RoutingRule[]): string[] {
  return [...new Set(rules.flatMap((rule) => {
    const match = /^device:([^:]+):(.+)$/.exec(baseRuleTag(rule))
    return match && routeTags(rules).includes(match[2]) ? [match[1]] : []
  }))]
}

export function addCustomRoute(rules: RoutingRule[], name: string, domains: string[]): RoutingRule[] {
  const title = name.trim()
  if (!title || title.length > 40 || /[<>\r\n]/.test(title)) throw new Error('Название маршрута: от 1 до 40 символов')
  const tag = `custom:${encodeURIComponent(title)}`
  if (routeTags(rules).includes(tag)) throw new Error('Маршрут с таким названием уже есть')
  const normalized = normalizeRouteResources('domain', domains)
  const vpn = rules.find((rule) => baseRuleTag(rule) === 'VPN')
  const target = destination(vpn)
  if (!target.outboundTag && !target.balancerTag) throw new Error('Сначала настройте общий Селектор')
  const firstGlobal = rules.findIndex((rule) => ROUTE_TAGS.includes(baseRuleTag(rule) as typeof ROUTE_TAGS[number]))
  const insertAt = firstGlobal < 0 ? rules.length : firstGlobal
  let updated = [...rules.slice(0, insertAt), { type: 'field', ruleTag: `${tag}|selector`, domain: normalized, ...target }, ...rules.slice(insertAt)]
  for (const ip of readDeviceIps(rules)) {
    const direct = rules.some(rule => baseRuleTag(rule) === deviceRuleTag(ip, 'VPN') && isFullBypass(rule))
    updated = updateDeviceRules(updated, ip, tag, direct ? 'direct' : '@selector')
  }
  return updated
}

function validIpResource(value: string): boolean {
  if (value === ROSCOMVPN_DIRECT_IP || /^(?:geoip:[a-z0-9_-]+|ext:[a-z0-9_][a-z0-9._-]*\.dat:[a-z0-9_-]+)$/i.test(value)) return true
  const pieces = value.split('/')
  if (pieces.length > 2) return false
  const [address, prefix] = pieces
  const parts = address.split('.')
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
    && (prefix === undefined || /^\d{1,2}$/.test(prefix) && Number(prefix) <= 32)
}

export function normalizeRouteResources(kind: 'domain' | 'ip', values: string[]): string[] {
  const resources = [...new Set(values.map((value) => value.trim()).filter(Boolean))]
  if (!resources.length || resources.length > 30) throw new Error('Укажите от 1 до 30 ресурсов')
  if (kind === 'domain') {
    if (resources.some((value) => !/^(?:(?:domain:|full:|geosite:)?[a-z0-9*._-]+|ext:[a-z0-9_][a-z0-9._-]*\.dat:[a-z0-9_-]+)$/i.test(value))) throw new Error('Некорректный домен или категория GeoSite')
    return resources.map((value) => /^(?:domain:|full:|geosite:|ext:)/i.test(value) ? value : `domain:${value}`)
  }
  if (resources.some((value) => !validIpResource(value))) throw new Error('Введите IPv4, CIDR или категорию GeoIP')
  return resources
}

export function addCustomIpRoute(rules: RoutingRule[], name: string, ips: string[]): RoutingRule[] {
  const title = name.trim()
  if (!title || title.length > 40 || /[<>\r\n]/.test(title)) throw new Error('Название маршрута: от 1 до 40 символов')
  const tag = `custom:${encodeURIComponent(title)}`
  if (routeTags(rules).includes(tag)) throw new Error('Маршрут с таким названием уже есть')
  const normalized = normalizeRouteResources('ip', ips)
  const vpn = rules.find((rule) => baseRuleTag(rule) === 'VPN')
  const target = destination(vpn)
  if (!target.outboundTag && !target.balancerTag) throw new Error('Сначала настройте общий Селектор')
  const firstGlobal = rules.findIndex((rule) => routeTags(rules).includes(baseRuleTag(rule)))
  let updated = [...rules.slice(0, firstGlobal < 0 ? rules.length : firstGlobal), { type: 'field', ruleTag: `${tag}|selector`, ip: normalized, ...target }, ...rules.slice(firstGlobal < 0 ? rules.length : firstGlobal)]
  for (const ip of readDeviceIps(rules)) {
    const direct = rules.some((rule) => baseRuleTag(rule) === deviceRuleTag(ip, 'VPN') && rule.outboundTag === 'direct')
    updated = updateDeviceRules(updated, ip, tag, direct ? 'direct' : '@selector')
  }
  return updated
}

export function replaceRouteResources(rules: RoutingRule[], tag: string, values: string[]): RoutingRule[] {
  if (tag === 'VPN') throw new Error('Общий Селектор не содержит ресурсов')
  const global = rules.find((rule) => baseRuleTag(rule) === tag)
  if (!global) throw new Error('Маршрут не найден')
  const kind = Array.isArray(global.ip) && !Array.isArray(global.domain) ? 'ip' : 'domain'
  const resources = normalizeRouteResources(kind, values)
  return rules.map((rule) => {
    const name = baseRuleTag(rule)
    if (name !== tag && !(name.startsWith('device:') && name.endsWith(`:${tag}`))) return rule
    return kind === 'ip' ? { ...rule, ip: resources } : { ...rule, domain: resources }
  })
}

export function mergeRouteDomains(rules: RoutingRule[], tag: string, domains: string[]): RoutingRule[] {
  const global = rules.find((rule) => baseRuleTag(rule) === tag)
  if (!global || tag === 'VPN') throw new Error('Маршрут не найден')
  const normalized = normalizeRouteResources('domain', domains)
  const merged = [...new Set([...(global.domain ?? []), ...normalized])]
  if (merged.length > 30) throw new Error('В одном маршруте может быть не больше 30 доменных ресурсов')
  return rules.map((rule) => baseRuleTag(rule) === tag || baseRuleTag(rule).endsWith(`:${tag}`) ? { ...rule, domain: merged } : rule)
}

export function removeCustomRoute(rules: RoutingRule[], tag: string): RoutingRule[] {
  if (tag === 'VPN' || !routeTags(rules).includes(tag) || !rules.some((rule) => baseRuleTag(rule) === tag)) throw new Error('Маршрут не найден')
  return rules.filter((rule) => baseRuleTag(rule) !== tag && !baseRuleTag(rule).endsWith(`:${tag}`))
}

export function renameCustomRoute(rules: RoutingRule[], tag: string, name: string): RoutingRule[] {
  if (!tag.startsWith('custom:') || !rules.some((rule) => baseRuleTag(rule) === tag)) throw new Error('Переименовать можно только добавленный маршрут')
  const title = name.trim()
  if (!title || title.length > 40 || /[<>\r\n]/.test(title)) throw new Error('Название маршрута: от 1 до 40 символов')
  const nextTag = `custom:${encodeURIComponent(title)}`
  if (nextTag !== tag && routeTags(rules).includes(nextTag)) throw new Error('Маршрут с таким названием уже есть')
  if (nextTag === tag) return rules
  return rules.map((rule) => {
    const current = baseRuleTag(rule)
    const renamed = current === tag ? nextTag : current.endsWith(`:${tag}`) && current.startsWith('device:')
      ? `${current.slice(0, -tag.length)}${nextTag}` : null
    return renamed ? { ...rule, ruleTag: renamed + (usesSelector(rule) ? '|selector' : '') } : rule
  })
}

export function updateGlobalRules(rules: RoutingRule[], route: RouteTag, selection: string): RoutingRule[] {
  const index = rules.findIndex((rule) => baseRuleTag(rule) === route)
  if (index < 0) throw new Error(`Общее правило ${route} не найдено`)
  const linked = route !== 'VPN' && selection === '@selector'
  const vpn = rules.find((rule) => baseRuleTag(rule) === 'VPN')
  const bypass = route === 'VPN' && selection === '@bypass'
  const actualSelection = bypass ? 'direct' : selection
  const target = selection.startsWith('@balancer:') ? { balancerTag: selection.slice(10) } : choice(vpn, actualSelection, linked)
  if (!target.outboundTag && !target.balancerTag) throw new Error('Выберите подключение')
  let updated = rules.map((rule, i) => i === index ? { ...rule, ruleTag: route + (linked ? '|selector' : bypass ? '|bypass' : route === 'VPN' && selection === 'direct' ? '|split' : ''), outboundTag: undefined, balancerTag: undefined, ...target } : rule)
  if (route === 'VPN') {
    updated = updated.map((rule) => {
      const tag = baseRuleTag(rule)
      if (usesSelector(rule) && (routeTags(rules).includes(tag) || tag === RU_IP_TAG)) return { ...rule, outboundTag: undefined, balancerTag: undefined, ...target }
      if (tag.startsWith('device:') && tag.endsWith(':VPN') && usesSelector(rule)) return { ...rule, outboundTag: undefined, balancerTag: undefined, ...target }
      return rule
    })
    const deviceTargets = new Map<string, Pick<RoutingRule, 'outboundTag' | 'balancerTag'>>()
    for (const rule of updated) {
      const match = /^device:([^:]+):VPN$/.exec(baseRuleTag(rule))
      if (match) deviceTargets.set(match[1], destination(rule))
    }
    updated = updated.map((rule) => {
      const match = /^device:([^:]+):(.+)$/.exec(baseRuleTag(rule))
      return match && usesSelector(rule) ? { ...rule, outboundTag: undefined, balancerTag: undefined, ...(deviceTargets.get(match[1]) ?? target) } : rule
    })
    const vpnRule = updated.find((rule) => baseRuleTag(rule) === 'VPN')!
    const otherRules = updated.filter((rule) => baseRuleTag(rule) !== 'VPN')
    if (selection.toLowerCase() === 'csqtt' || selection.toLowerCase() === 'wdtt-plus') {
      // Keep explicit device-wide bypasses and local-network exclusions. The
      // tunnel selector must precede service and RU rules so every other
      // device uses the tunnel regardless of its old per-service choices.
      const bypassIps = new Set(updated.flatMap((rule) => {
        const match = /^device:([^:]+):VPN$/.exec(baseRuleTag(rule))
        return match && isFullBypass(rule) ? [match[1]] : []
      }))
      const exempt = (rule: RoutingRule) => {
        const tag = baseRuleTag(rule)
        const deviceMatch = /^device:([^:]+):/.exec(tag)
        return rule.outboundTag === 'direct' && (
          (!!deviceMatch && bypassIps.has(deviceMatch[1])) || (!tag && Array.isArray(rule.ip) && rule.ip.length > 0)
        )
      }
      return [...otherRules.filter(exempt), vpnRule, ...otherRules.filter((rule) => !exempt(rule))]
    }
    return [...otherRules, vpnRule]
  }
  return updated
}

export function updateDeviceRules(rules: RoutingRule[], ip: string, route: RouteTag | null, outboundTag?: string): RoutingRule[] {
  if (!validDeviceIp(ip)) throw new Error('Введите IPv4 адрес устройства, например 192.168.1.20')
  const devicePrefix = `device:${ip}:`
  if (route === null) return rules.filter((rule) => !rule.ruleTag?.startsWith(devicePrefix))
  if (route === 'VPN' && !readDeviceIps(rules).includes(ip)) {
    let seeded = rules
    for (const category of routeTags(rules).filter((tag) => tag !== 'VPN')) {
      if (rules.some((rule) => baseRuleTag(rule) === category)) seeded = updateDeviceRules(seeded, ip, category, category === 'RU' || category === RU_IP_TAG ? 'direct' : '@selector')
    }
    return updateDeviceRules(seeded, ip, 'VPN', outboundTag)
  }
  const global = rules.find((rule) => baseRuleTag(rule) === route)
  if (!global) throw new Error(`Общее правило ${route} не найдено`)
  const previousDeviceVpn = rules.find((rule) => baseRuleTag(rule) === deviceRuleTag(ip, 'VPN'))
  if (route !== 'VPN' && isFullBypass(previousDeviceVpn) && outboundTag !== 'direct' && outboundTag !== '') {
    throw new Error('Для этого устройства включён «Без VPN». Сначала выберите прокси в его общем Селекторе')
  }
  const tag = deviceRuleTag(ip, route)
  const existingIndex = rules.findIndex((rule) => baseRuleTag(rule) === tag)
  if (route !== 'VPN' && outboundTag === '') return rules.filter((rule) => baseRuleTag(rule) !== tag)
  if (!outboundTag) throw new Error('Выберите подключение')
  const nfqws2 = outboundTag === '@nfqws2'
  if (nfqws2 && (route !== 'VPN' || ip !== '192.168.0.130')) throw new Error('Пробный nfqws2 доступен только для общего маршрута 192.168.0.130')
  const bypass = route === 'VPN' && outboundTag === '@bypass'
  const actualOutbound = nfqws2 || bypass ? 'direct' : outboundTag
  const linked = outboundTag === '@selector'
  const deviceVpn = rules.find((rule) => baseRuleTag(rule) === deviceRuleTag(ip, 'VPN'))
  const selectedRule = route === 'VPN' ? rules.find((rule) => baseRuleTag(rule) === 'VPN') : deviceVpn ?? rules.find((rule) => baseRuleTag(rule) === 'VPN')
  const target = choice(selectedRule, actualOutbound, linked)
  if (!target.outboundTag && !target.balancerTag) throw new Error('Общий Селектор не настроен')
  const nextRule: RoutingRule = {
    type: 'field',
    ruleTag: tag + (linked ? '|selector' : nfqws2 ? '|nfqws2' : bypass ? '|bypass' : route === 'VPN' && outboundTag === 'direct' ? '|split' : ''),
    sourceIP: [ip],
    ...(route === 'VPN' ? { network: 'tcp,udp' } : Array.isArray(global.ip) && !Array.isArray(global.domain) ? { ip: global.ip } : { domain: global.domain }),
    ...target,
  }
  const firstGlobal = rules.findIndex((rule) => routeTags(rules).includes(baseRuleTag(rule)))
  const globalFallback = rules.findIndex((rule) => baseRuleTag(rule) === 'VPN')
  let updated = existingIndex >= 0
    ? rules.map((rule, index) => index === existingIndex ? nextRule : rule)
    : (() => {
      const insertAt = route === 'VPN'
        ? globalFallback >= 0 ? globalFallback : rules.length
        : firstGlobal >= 0 ? firstGlobal : rules.length
      return [...rules.slice(0, insertAt), nextRule, ...rules.slice(insertAt)]
    })()
  if (route !== 'VPN') return updated
  if (bypass || nfqws2) return normalizeDevicePriority(updated)
  updated = updated.map((rule) => usesSelector(rule) && baseRuleTag(rule).startsWith(devicePrefix)
    ? { ...rule, outboundTag: undefined, balancerTag: undefined, ...target } : rule)
  if (outboundTag.toLowerCase() === 'csqtt' || outboundTag.toLowerCase() === 'wdtt-plus') {
    // The device selector must match before both its service rules and the
    // global service rules. Keep explicit device bypasses and LAN exclusions.
    const vpnRule = updated.find((rule) => baseRuleTag(rule) === tag)!
    const remaining = updated.filter((rule) => baseRuleTag(rule) !== tag)
    const bypassIps = new Set(remaining.flatMap((rule) => {
      const match = /^device:([^:]+):VPN$/.exec(baseRuleTag(rule))
      return match && isFullBypass(rule) ? [match[1]] : []
    }))
    const exempt = (rule: RoutingRule) => {
      const name = baseRuleTag(rule)
      const deviceMatch = /^device:([^:]+):/.exec(name)
      return rule.outboundTag === 'direct' && (
        (!!deviceMatch && bypassIps.has(deviceMatch[1])) || (!name && Array.isArray(rule.ip) && rule.ip.length > 0)
      )
    }
    return [...remaining.filter(exempt), vpnRule, ...remaining.filter((rule) => !exempt(rule))]
  }
  // A device fallback follows its service rules and precedes the global fallback.
  const vpnRule = updated.find((rule) => baseRuleTag(rule) === tag)!
  const withoutVpn = updated.filter((rule) => baseRuleTag(rule) !== tag)
  const fallbackIndex = withoutVpn.findIndex((rule) => baseRuleTag(rule) === 'VPN')
  withoutVpn.splice(fallbackIndex < 0 ? withoutVpn.length : fallbackIndex, 0, vpnRule)
  return withoutVpn
}

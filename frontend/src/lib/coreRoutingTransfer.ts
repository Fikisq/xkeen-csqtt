import { parse as parseJsonc, modify, applyEdits } from 'jsonc-parser'
import { addMihomoCustomRoute, defaultMihomoChoices, readMihomoCustomRoutes, readMihomoDevices, updateMihomoDevice } from './mihomoDeviceRouting'
import { readSelections, withSelections } from './mihomoRoutingBackup'
import { addCustomRoute, baseRuleTag, readDeviceIps, routeTags, updateDeviceRules, updateGlobalRules, type RoutingRule } from './xrayDeviceRouting'

export interface TransferResult { content: string; devices: string[]; directDevices: string[]; routes: string[] }
export interface NodeMapping { xrayToMihomo: Record<string, string>; mihomoToXray: Record<string, string> }

function xrayRules(content: string): RoutingRule[] {
  const parsed = parseJsonc(content)
  if (!Array.isArray(parsed?.routing?.rules)) throw new Error('Правила Xray не найдены')
  return parsed.routing.rules as RoutingRule[]
}

function sourceDomains(rule?: RoutingRule): string[] {
  return (rule?.domain ?? []).filter((item): item is string => typeof item === 'string')
    .map((item) => item.toLowerCase())
    .filter((item) => /^(?:domain:|full:|geosite:)[a-z0-9._-]+$/i.test(item))
}

function displayCustom(tag: string): string {
  try { return decodeURIComponent(tag.slice('custom:'.length)) } catch { return tag.slice('custom:'.length) }
}

function mihomoChoice(tag: string | undefined, mapping: NodeMapping): string | undefined {
  if (!tag) return undefined
  if (tag === 'direct') return 'DIRECT'
  if (tag === 'csqtt') return 'CSQTT'
  if (tag === 'wdtt-plus') return 'WDTT Plus'
  return mapping.xrayToMihomo[tag]
}

export function xrayToMihomo(source: string, target: string, mapping: NodeMapping = {xrayToMihomo: {}, mihomoToXray: {}}): TransferResult {
  const rules = xrayRules(source)
  let content = target
  const routes: string[] = []
  for (const tag of routeTags(rules).filter(tag => tag.startsWith('custom:'))) {
    const name = displayCustom(tag)
    const domains = sourceDomains(rules.find(rule => baseRuleTag(rule) === tag))
    if (!domains.length || readMihomoCustomRoutes(content).some(route => route.tag === tag)) continue
    content = addMihomoCustomRoute(content, name, domains)
    routes.push(name)
  }
  const defaults = defaultMihomoChoices(content)
  const supported = new Set([...Object.keys(defaults), ...readMihomoCustomRoutes(content).map((route) => route.tag)])
  const selections = readSelections(content)
  for (const tag of routeTags(rules).filter((tag) => supported.has(tag))) {
    const rule = rules.find(item => baseRuleTag(item) === tag)
    const group = defaults[tag]
    const selected = mihomoChoice(rule?.outboundTag, mapping)
    if (group && selected) selections[group] = selected
  }
  content = withSelections(content, selections)
  const devices = readDeviceIps(rules)
  const directDevices: string[] = []
  for (const ip of devices) {
    const vpn = rules.find(rule => baseRuleTag(rule) === `device:${ip}:VPN`)
    const direct = vpn?.outboundTag === 'direct'
    const fallback = direct ? 'DIRECT' : mihomoChoice(vpn?.outboundTag, mapping) ?? defaults.VPN
    content = updateMihomoDevice(content, ip, 'VPN', fallback)
    if (direct) directDevices.push(ip)
    for (const tag of routeTags(rules).filter(tag => tag !== 'VPN' && supported.has(tag))) {
      const rule = rules.find(item => baseRuleTag(item) === `device:${ip}:${tag}`)
      const selected = mihomoChoice(rule?.outboundTag, mapping)
      if (selected) content = updateMihomoDevice(content, ip, tag, selected)
    }
  }
  return { content, devices, directDevices, routes }
}

export function mihomoToXray(source: string, target: string, mapping: NodeMapping = {xrayToMihomo: {}, mihomoToXray: {}}): TransferResult {
  let rules = xrayRules(target)
  const routes: string[] = []
  for (const route of readMihomoCustomRoutes(source)) {
    if (routeTags(rules).includes(route.tag)) continue
    rules = addCustomRoute(rules, route.name, route.domains)
    routes.push(route.name)
  }
  const outbounds = new Set<string>((parseJsonc(target)?.outbounds ?? []).map((item: {tag?: string}) => item.tag).filter(Boolean))
  const defaults = defaultMihomoChoices(source)
  const selections = readSelections(source)
  const resolve = (initial: string | undefined): string | undefined => {
    let name = initial
    const seen = new Set<string>()
    while (name && !seen.has(name)) {
      if (name === 'DIRECT' || /без\s*(?:vpn|впн)/i.test(name)) return 'direct'
      if (name === 'CSQTT') return 'csqtt'
      if (/^wdtt[ -]plus$/i.test(name)) return 'wdtt-plus'
      const mapped = mapping.mihomoToXray[name]
      if (mapped && outbounds.has(mapped)) return mapped
      if (outbounds.has(name)) return name
      seen.add(name)
      name = selections[name]
    }
    return undefined
  }
  for (const tag of routeTags(rules)) {
    const selected = resolve(defaults[tag])
    if (selected) rules = updateGlobalRules(rules, tag, selected)
  }
  const profiles = readMihomoDevices(source)
  const directDevices: string[] = []
  for (const profile of profiles) {
    const fallback = resolve(profile.choices.VPN) ?? '@selector'
    const direct = fallback === 'direct'
    rules = updateDeviceRules(rules, profile.ip, 'VPN', fallback)
    if (direct) directDevices.push(profile.ip)
    for (const tag of routeTags(rules).filter(tag => tag !== 'VPN')) {
      const choice = profile.choices[tag]
      const selected = resolve(choice)
      if (selected && (!direct || selected === 'direct')) rules = updateDeviceRules(rules, profile.ip, tag, selected)
    }
  }
  const content = applyEdits(target, modify(target, ['routing', 'rules'], rules, { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
  return { content, devices: profiles.map(profile => profile.ip), directDevices, routes }
}

import { parse as parseJsonc, modify, applyEdits } from 'jsonc-parser'
import { addMihomoCustomRoute, defaultMihomoChoices, prepareMihomoRouteGroups, readMihomoCustomRoutes, readMihomoDevices, updateMihomoDevice } from './mihomoDeviceRouting'
import { readSelections, replaceSection, withSelections } from './mihomoRoutingBackup'
import { load as loadYaml, dump as dumpYaml } from 'js-yaml'
import { addCustomRoute, baseRuleTag, readDeviceIps, routeTags, updateDeviceRules, updateGlobalRules, type RoutingRule } from './xrayDeviceRouting'

export interface TransferResult { content: string; devices: string[]; directDevices: string[]; routes: string[] }
export interface NodeMapping { xrayToMihomo: Record<string, string>; mihomoToXray: Record<string, string> }

// Keep working Xray VLESS credentials instead of trusting a stale subscription.
export function syncMihomoVlessNodes(source: string, target: string, mapping: NodeMapping): {content: string; mapping: NodeMapping} {
  const config = loadYaml(target) as Record<string, any>
  const proxies: Array<Record<string, any>> = config.proxies ?? []
  const translated = {xrayToMihomo: {...mapping.xrayToMihomo}, mihomoToXray: {...mapping.mihomoToXray}}
  const replacements = new Map<string, string>()
  for (const outbound of parseJsonc(source)?.outbounds ?? []) {
    const original = mapping.xrayToMihomo[outbound.tag]
    const stream = outbound.streamSettings ?? {}
    const settings = outbound.settings ?? {}
    if (!original || outbound.protocol !== 'vless') continue
    if (!['tcp', 'raw', 'xhttp'].includes(stream.network ?? 'tcp')) continue
    const name = original.endsWith(' · XKeen') ? original : `${original} · XKeen`
    const proxy: Record<string, any> = {name, type: 'vless', server: settings.address, port: Number(settings.port), uuid: settings.id, udp: true, network: stream.network === 'raw' ? 'tcp' : stream.network ?? 'tcp', 'routing-mark': 255}
    if (!proxy.server || !proxy.uuid || !proxy.port) continue
    if (settings.flow) proxy.flow = settings.flow
    const tls = stream.security === 'reality' ? stream.realitySettings : stream.tlsSettings
    if (tls) {
      proxy.tls = true
      proxy.servername = tls.serverName
      if (tls.fingerprint) proxy['client-fingerprint'] = tls.fingerprint
      if (tls.alpn) proxy.alpn = tls.alpn
      if (stream.security === 'reality') {
        proxy['reality-opts'] = {'public-key': tls.publicKey, 'short-id': String(tls.shortId ?? ''), 'support-x25519mlkem768': true}
        proxy['client-fingerprint'] = 'chrome'
      }
    }
    if (proxy.network === 'xhttp') {
      const xhttp = stream.xhttpSettings ?? {}
      proxy['xhttp-opts'] = {path: xhttp.path ?? '/', host: xhttp.host ?? '', mode: xhttp.extra?.mode ?? xhttp.mode ?? 'auto'}
      if (xhttp.extra?.xPaddingBytes) proxy['xhttp-opts']['x-padding-bytes'] = xhttp.extra.xPaddingBytes
    }
    const index = proxies.findIndex(node => node.name === name)
    if (index < 0) proxies.push(proxy); else proxies[index] = proxy
    translated.xrayToMihomo[outbound.tag] = name
    translated.mihomoToXray[name] = outbound.tag
    replacements.set(original, name)
  }
  let content = replaceSection(target, 'proxies', dumpYaml({proxies}, {lineWidth: -1, noRefs: true}))
  content = withSelections(content, Object.fromEntries(Object.entries(readSelections(content)).map(([group, node]) => [group, replacements.get(node) ?? node])))
  return {content, mapping: translated}
}

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
  if (tag.toLowerCase() === 'csqtt') return 'CSQTT'
  if (tag === 'wdtt-plus') return 'WDTT Plus'
  return mapping.xrayToMihomo[tag]
}

export function xrayToMihomo(source: string, target: string, mapping: NodeMapping = {xrayToMihomo: {}, mihomoToXray: {}}): TransferResult {
  const rules = xrayRules(source)
  if (rules.some(rule => rule.outboundTag === 'nfqws-direct')) throw new Error('Перенос nfqws2 в Mihomo пока не поддерживается. Выберите для этих правил другое подключение перед переключением ядра')
  const synced = syncMihomoVlessNodes(source, target, mapping)
  mapping = synced.mapping
  let content = prepareMihomoRouteGroups(synced.content)
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
    if (group && selected && group !== 'DIRECT' && group !== selected) selections[group] = selected
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
  const groups = new Set(((loadYaml(content) as Record<string, any>)['proxy-groups'] ?? []).filter((group: any) => group.type === 'select').map((group: any) => group.name))
  content = withSelections(content, Object.fromEntries(Object.entries(readSelections(content)).filter(([group]) => groups.has(group))))
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

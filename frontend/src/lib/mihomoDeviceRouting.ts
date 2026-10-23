import { ROUTE_TAGS, customRouteName, validDeviceIp, type RouteTag } from './xrayDeviceRouting'
import { load as loadYaml, dump as dumpYaml } from 'js-yaml'

export type DeviceChoices = Record<RouteTag, string>
export type MihomoRouteNetwork = 'tcp,udp' | 'tcp' | 'udp'
export interface DeviceProfile { ip: string; choices: DeviceChoices }

const START = 'xkeen-device-start'
const END = 'xkeen-device-end'
const CUSTOM = 'xkeen-custom-route'

export interface MihomoCustomRoute { tag: string; name: string; domains: string[] }

export function readMihomoCustomRoutes(content: string): MihomoCustomRoute[] {
  let body: string
  try { body = rulesSection(content).body } catch { return [] }
  return [...body.matchAll(/^  # xkeen-custom-route (\S+)\r?$/gm)].flatMap((match) => {
    try {
      const value = JSON.parse(decodeURIComponent(match[1])) as MihomoCustomRoute
      return value.tag?.startsWith('custom:') && typeof value.name === 'string' && Array.isArray(value.domains) ? [value] : []
    } catch { return [] }
  })
}

export function mihomoRouteTags(content: string): RouteTag[] {
  return [...new Set([...ROUTE_TAGS, ...readMihomoCustomRoutes(content).map((route) => route.tag)])]
}

interface OrderedRouteBlock { tag: RouteTag; start: number; end: number; text: string }

interface ParsedRouteRule { matcher: string; target: string; network: MihomoRouteNetwork; disabled: boolean }

function parseRouteRule(line: string): ParsedRouteRule | undefined {
  const rule = line.trimEnd()
  const direct = /^  (- |# xkeen-disabled-rule )((?:RULE-SET|DOMAIN|DOMAIN-SUFFIX|DOMAIN-KEYWORD|GEOSITE|GEOIP|IP-CIDR|IP-CIDR6),[^,\r\n]+),([^,\r\n]+)(?:,no-resolve)?$/.exec(rule)
  if (direct) return { matcher: direct[2], target: direct[3].trim(), network: 'tcp,udp', disabled: direct[1] !== '- ' }
  const conditional = /^  (- |# xkeen-disabled-rule )AND,\(\(((?:RULE-SET|DOMAIN|DOMAIN-SUFFIX|DOMAIN-KEYWORD|GEOSITE|GEOIP|IP-CIDR|IP-CIDR6),[^,)\r\n]+)(?:,no-resolve)?\),\(NETWORK,(TCP|UDP)\)\),([^,\r\n]+)$/.exec(rule)
  if (conditional) return { matcher: conditional[2], target: conditional[4].trim(), network: conditional[3].toLowerCase() as MihomoRouteNetwork, disabled: conditional[1] !== '- ' }
  return undefined
}

function formatRouteRule(matcher: string, target: string, network: MihomoRouteNetwork, disabled = false): string {
  const prefix = disabled ? '  # xkeen-disabled-rule ' : '  - '
  if (network !== 'tcp,udp') return `${prefix}AND,((${matcher}${/^(?:GEOIP|IP-CIDR|IP-CIDR6),/.test(matcher) ? ',no-resolve' : ''}),(NETWORK,${network.toUpperCase()})),${target}\n`
  return `${prefix}${matcher},${target}${/^(?:GEOIP|IP-CIDR|IP-CIDR6),/.test(matcher) ? ',no-resolve' : ''}\n`
}

function orderedRouteBlocks(content: string): OrderedRouteBlock[] {
  const body = rulesSection(content).body
  const choices = defaultMihomoChoices(content)
  const tags = mihomoRouteTags(content).filter((tag) => tag !== 'VPN' && choices[tag] !== choices.VPN)
  const targets = new Map<string, RouteTag>()
  for (const tag of tags) {
    const target = choices[tag]
    if (target !== 'DIRECT' && target !== 'REJECT' && ![...targets.values()].some((other) => choices[other] === target)) targets.set(target, tag)
  }
  const lines = [...body.matchAll(/^.*(?:\r?\n|$)/gm)].filter((match) => match[0].length > 0)
  const blocks: OrderedRouteBlock[] = []
  for (const line of lines) {
    const rule = parseRouteRule(line[0])
    const tag = rule && targets.get(rule.target)
    if (!tag) continue
    const previous = blocks[blocks.length - 1]
    const before = body.slice(0, line.index!)
    const metadata = /  # xkeen-custom-route \S+\r?\n$/.exec(before)
    const start = metadata && !blocks.some(block => block.tag === tag) ? metadata.index : line.index!
    const end = line.index! + line[0].length
    if (previous?.tag === tag && /^\s*$/.test(body.slice(previous.end, start))) {
      previous.end = end
      previous.text = body.slice(previous.start, end)
    } else {
      blocks.push({ tag, start, end, text: body.slice(start, end) })
    }
  }
  return blocks
}

function uniqueRouteBlock(content: string, tag: RouteTag): OrderedRouteBlock | undefined {
  const choices = defaultMihomoChoices(content)
  const target = choices[tag]
  if (!target || target === choices.VPN || target === 'DIRECT' || target === 'REJECT') return undefined
  if (mihomoRouteTags(content).some(other => other !== tag && other !== 'VPN' && choices[other] === target)) return undefined
  const blocks = orderedRouteBlocks(content).filter(block => block.tag === tag)
  if (blocks.length !== 1) return undefined
  if (tag.startsWith('custom:') && !blocks[0].text.startsWith('  # xkeen-custom-route ')) return undefined
  return blocks[0]
}

export function orderedMihomoRouteTags(content: string): RouteTag[] {
  try { return [...new Set([...orderedRouteBlocks(content).map((block) => block.tag), ...readMihomoCustomRoutes(content).map(route => route.tag)])] } catch { return [] }
}

export function reorderMihomoRoutes(content: string, source: RouteTag, target: RouteTag): string {
  const section = rulesSection(content)
  const blocks = orderedRouteBlocks(content)
  const tags = [...new Set(blocks.map(block => block.tag))]
  if (tags.length !== blocks.length || blocks.some((block, index) => index > 0 && /^  (?:- |# xkeen-disabled-rule )/m.test(section.body.slice(blocks[index - 1].end, block.start)))) {
    throw new Error('Правила перемежаются с другими маршрутами. Измените их порядок в конфигурации перед переносом')
  }
  const from = tags.indexOf(source)
  const to = tags.indexOf(target)
  if (from < 0 || to < 0) throw new Error('Маршрут не найден среди отдельных правил Mihomo')
  if (from === to) return content
  const [moved] = tags.splice(from, 1)
  tags.splice(to, 0, moved)
  const reordered = [...blocks].sort((a, b) => tags.indexOf(a.tag) - tags.indexOf(b.tag)).map(block => block.text)
  let cursor = 0
  let body = ''
  blocks.forEach((block, index) => {
    body += section.body.slice(cursor, block.start) + reordered[index]
    cursor = block.end
  })
  body += section.body.slice(cursor)
  const updated = content.slice(0, section.start) + body + content.slice(section.end)
  const profiles = readMihomoDevices(content)
  return profiles.length ? updateMihomoDevice(updated, profiles[0].ip, 'VPN') : updated
}
const GROUP_HINTS: Record<RouteTag, RegExp> = {
  VPN: /vpn/i, Youtube: /youtube/i, Discord: /discord/i,
  Games: /игры|games/i, AI: /\bai\b|gemini/i, Github: /github/i,
  RU: /российск|category-ru|\bru\b/i,
}

function generalSelectorName(names: string[]): string | undefined {
  return names.find((name) => /^(?:VPN|Селектор)$/i.test(name))
    ?? names.find((name) => GROUP_HINTS.VPN.test(name) && !/без\s*(?:vpn|впн)/i.test(name))
}

function rulesSection(content: string): { start: number; end: number; body: string } {
  const match = /^rules:\s*\r?\n/m.exec(content)
  if (!match || match.index === undefined) throw new Error('В Mihomo YAML нет раздела rules')
  const start = match.index + match[0].length
  const next = /^[A-Za-z][\w-]*:/m.exec(content.slice(start))
  const end = next?.index === undefined ? content.length : start + next.index
  return { start, end, body: content.slice(start, end) }
}

function removeManaged(body: string): string {
  return body
    .replace(/^  # xkeen-device-start [^\r\n]+\r?\n[\s\S]*?^  # xkeen-device-end [^\r\n]+\r?\n/gm, '')
    .replace(/^  # xkeen-device-fallback [^\r\n]+\r?\n  - SRC-IP-CIDR,[^\r\n]+\r?\n/gm, '')
}

function removeManagedGroups(content: string): string {
  return content.replace(/^  # xkeen-device-groups-start\r?\n[\s\S]*?^  # xkeen-device-groups-end\r?\n/gm, '')
}

function sectionBody(content: string, key: string): string {
  const match = new RegExp(`^${key}:\\s*\\r?\\n`, 'm').exec(content)
  if (!match) return ''
  const start = match.index + match[0].length
  const next = /^[A-Za-z][\w-]*:/m.exec(content.slice(start))
  return content.slice(start, next ? start + next.index : content.length)
}

function providerNames(content: string): string[] {
  return [...sectionBody(content, 'proxy-providers').matchAll(/^  ([^\s:#][^:]*):\s*$/gm)].map((match) => match[1])
}

function inlineProxyNames(content: string): Set<string> {
  return new Set([...sectionBody(content, 'proxies').matchAll(/^  - name:\s*(.+?)\s*$/gm)].map((match) => match[1].replace(/^['"]|['"]$/g, '')))
}

// CSQTT and WDTT Plus are local services, not nodes supplied by a subscription.
export function ensureMihomoSidecars(content: string): string {
  const header = /^proxies:\s*(?:\[\])?\s*\r?\n/m.exec(content)
  if (!header || header.index === undefined) throw new Error('В Mihomo YAML нет раздела proxies')
  const names = inlineProxyNames(content)
  const additions = [
    !names.has('CSQTT') ? '  - name: CSQTT\n    type: direct\n    interface-name: csqtt0\n    udp: true\n' : '',
    !names.has('WDTT Plus') ? '  - name: WDTT Plus\n    type: socks5\n    server: 127.0.0.1\n    port: 1088\n    udp: true\n' : '',
  ].join('')
  const at = header.index + header[0].length
  return content.slice(0, header.index) + 'proxies:\n' + additions + content.slice(at)
}

function aliasFor(name: string): string {
  let hash = 2166136261
  for (const char of name) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619)
  return `xkeen-device-node-${(hash >>> 0).toString(16)}`
}

function exactFilter(name: string): string { return `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$` }

export function readMihomoDevices(content: string): DeviceProfile[] {
  let body: string
  try { body = rulesSection(content).body } catch { return [] }
  const profiles: DeviceProfile[] = []
  for (const line of body.split(/\r?\n/)) {
    const match = /^  # xkeen-device-start (\S+) (\S+)$/.exec(line)
    if (!match || !validDeviceIp(match[1])) continue
    try {
      const stored = JSON.parse(decodeURIComponent(match[2])) as DeviceChoices
      const choices = {} as DeviceChoices
      for (const route of mihomoRouteTags(content)) if (typeof stored[route] === 'string') choices[route] = stored[route]
      if (typeof choices.VPN === 'string') {
        for (const route of mihomoRouteTags(content)) if (typeof choices[route] !== 'string') choices[route] = choices.VPN
        profiles.push({ ip: match[1], choices })
      }
    } catch { /* Ignore malformed managed marker. */ }
  }
  return profiles
}

function groupNames(content: string): string[] {
  return [...sectionBody(content, 'proxy-groups').matchAll(/^  - name:\s*(.+?)\s*$/gm)].map((match) => match[1].replace(/^['"]|['"]$/g, ''))
}

// Routing cards are manual selectors. Keep policy groups such as Fallback intact.
export function prepareMihomoRouteGroups(content: string): string {
  // XKeen reserves mark 255 to exclude proxy sockets from interception.
  const marked = /^routing-mark:/m.test(content) ? content.replace(/^routing-mark:[^\r\n]*/m, 'routing-mark: 255') : `routing-mark: 255\n${content}`
  const clean = removeManagedGroups(ensureMihomoSidecars(marked))
  const match = /^proxy-groups:\s*\r?\n/m.exec(clean)
  if (!match) throw new Error('В Mihomo нет групп подключений')
  const start = match.index + match[0].length
  const next = /^[A-Za-z][\w-]*:/m.exec(clean.slice(start))
  const end = next ? start + next.index : clean.length
  const body = clean.slice(start, end)
  const blocks = [...body.matchAll(/^  - name:[^\r\n]+\r?\n/gm)]
  const defaults = defaultMihomoChoices(clean)
  const routes = new Set(Object.values(defaults))
  const providers = providerNames(clean)
  const inline = inlineProxyNames(clean)
  let updated = body.slice(0, blocks[0]?.index ?? body.length)
  for (let index = 0; index < blocks.length; index++) {
    const block = body.slice(blocks[index].index!, blocks[index + 1]?.index ?? body.length)
    const group = (loadYaml(block) as Array<Record<string, unknown>>)?.[0]
    if (!group || typeof group.name !== 'string' || !routes.has(group.name)) { updated += block; continue }
    group.type = 'select'
    group.hidden = false
    const options = Array.isArray(group.proxies) ? group.proxies as string[] : []
    group.proxies = [...new Set(['DIRECT', ...(group.name !== defaults.VPN && defaults.VPN !== 'DIRECT' ? [defaults.VPN] : []), ...options, ...[...inline].filter(name => /^(?:CSQTT|WDTT Plus)$/.test(name) || name.endsWith(' · XKeen'))])]
    if (providers.length) group.use = [...new Set([...(Array.isArray(group.use) ? group.use as string[] : []), ...providers])]
    updated += dumpYaml([group], { lineWidth: -1, noRefs: true, indent: 2 }).split('\n').filter(Boolean).map(line => `  ${line}`).join('\n') + '\n'
  }
  return clean.slice(0, start) + updated + clean.slice(end)
}

export function readMihomoFullBypass(content: string): boolean {
  return !/^# xkeen-full-bypass false$/m.test(content)
}
export function withMihomoFullBypass(content: string, enabled: boolean): string {
  return `# xkeen-full-bypass ${enabled}\n` + content.replace(/^# xkeen-full-bypass (?:true|false)\r?\n/gm, '')
}
export function isMihomoFullRoute(target: string): boolean {
  return target === 'DIRECT' || /^(?:CSQTT|WDTT[ -]Plus)$/i.test(target) || /без\s*(?:vpn|впн)/i.test(target)
}

export function defaultMihomoChoices(content: string): DeviceChoices {
  const names = groupNames(content)
  const selector = generalSelectorName(names) ?? 'DIRECT'
  return Object.fromEntries(mihomoRouteTags(content).map((route) => [route, route === 'VPN' ? selector : route.startsWith('custom:') ? customRouteName(route) : names.find((name) => !readMihomoCustomRoutes(content).some(custom => custom.name === name) && GROUP_HINTS[route]?.test(name)) ?? selector])) as unknown as DeviceChoices
}

function matchersForRoute(body: string, route: RouteTag, choices: DeviceChoices): string[] {
  if (route === 'VPN') return []
  const group = choices[route]
  const result: string[] = []
  for (const line of body.split(/\r?\n/)) {
    const match = parseRouteRule(line)
    if (match && !match.disabled && match.target === group) result.push(`(${match.matcher}${/^(?:GEOIP|IP-CIDR|IP-CIDR6),/.test(match.matcher) ? ',no-resolve' : ''})${match.network === 'tcp,udp' ? '' : `,(NETWORK,${match.network.toUpperCase()})`}`)
  }
  return choices[route] === choices.VPN ? [] : [...new Set(result)]
}

export function updateMihomoDevice(content: string, ip: string, route: RouteTag | null, target?: string): string {
  if (!validDeviceIp(ip)) throw new Error('Введите IPv4 адрес устройства')
  const cleanContent = removeManagedGroups(content)
  const section = rulesSection(cleanContent)
  const base = removeManaged(section.body)
  const profiles = readMihomoDevices(content).filter((profile) => profile.ip !== ip)
  const defaults = defaultMihomoChoices(cleanContent)
  if (route !== null) {
    const existing = readMihomoDevices(content).find((profile) => profile.ip === ip)
    const choices = existing?.choices ?? { ...defaults }
    if (target) {
      if (/[\r\n,]/.test(target)) throw new Error('Имя подключения содержит недопустимый символ')
      choices[route] = target
      if (route === 'VPN' && target !== 'DIRECT' && isMihomoFullRoute(target)) for (const tag of mihomoRouteTags(content)) choices[tag] = target
    }
    profiles.push({ ip, choices })
  }
  const existing = new Set([...groupNames(cleanContent), ...inlineProxyNames(cleanContent), 'DIRECT', 'REJECT', 'REJECT-DROP', 'PASS'])
  const providers = providerNames(cleanContent)
  const aliases = new Map<string, string>()
  for (const profile of profiles) for (const name of Object.values(profile.choices)) {
    if (name === '@direct' || existing.has(name) || aliases.has(name)) continue
    if (!providers.length) throw new Error(`Узел ${name} не объявлен в конфигурации Mihomo`)
    aliases.set(name, aliasFor(name))
  }
  const ruleTarget = (name: string) => name === '@direct' ? 'DIRECT' : aliases.get(name) ?? name
  const managed = profiles.map((profile) => {
    const source = `SRC-IP-CIDR,${profile.ip}/32`
    const lines = [`  # ${START} ${profile.ip} ${encodeURIComponent(JSON.stringify(profile.choices))}`]
    if (isMihomoFullRoute(profile.choices.VPN)) {
      lines.push(`  - ${source},${ruleTarget(profile.choices.VPN)}`, `  # ${END} ${profile.ip}`)
      return lines.join('\n') + '\n'
    }
    for (const category of [...orderedMihomoRouteTags(content), ...mihomoRouteTags(content).filter((tag) => tag !== 'VPN' && !orderedMihomoRouteTags(content).includes(tag))]) {
      const target = ruleTarget(profile.choices[category] === defaults.VPN ? profile.choices.VPN : profile.choices[category])
      for (const matcher of matchersForRoute(base, category, defaults)) {
        lines.push(`  - AND,((${source}),${matcher}),${target}`)
      }
    }
    lines.push(`  - ${source},${ruleTarget(profile.choices.VPN)}`)
    lines.push(`  # ${END} ${profile.ip}`)
    return lines.join('\n') + '\n'
  }).join('')
  // Device choices must precede normal rules; otherwise an earlier global match wins.
  // Keep the fixed loopback/LAN exclusions ahead of devices.
  let categoryOffset = -1
  for (const match of base.matchAll(/^  - ([^\r\n]+)$/gm)) {
    const rule = match[1]
    if (/^IP-CIDR,(?:127\.0\.0\.0\/8|10\.0\.0\.0\/8|172\.16\.0\.0\/12|192\.168\.0\.0\/16),DIRECT(?:,no-resolve)?$/.test(rule)) continue
    categoryOffset = match.index
    break
  }
  if (categoryOffset < 0) categoryOffset = base.length
  const withCategories = base.slice(0, categoryOffset) + managed + base.slice(categoryOffset)
  const updatedBody = withCategories
  let updated = cleanContent.slice(0, section.start) + updatedBody + cleanContent.slice(section.end)
  if (aliases.size) {
    const groups = ['  # xkeen-device-groups-start', ...[...aliases].flatMap(([name, alias]) => [
      `  - name: ${JSON.stringify(alias)}`, '    type: select',
      `    use: [${providers.map((provider) => JSON.stringify(provider)).join(', ')}]`,
      `    filter: ${JSON.stringify(exactFilter(name))}`,
    ]), '  # xkeen-device-groups-end', ''].join('\n')
    updated = updated.replace(/^proxy-groups:\s*\r?\n/m, (header) => header + groups)
  }
  return updated
}

export function addMihomoCustomRoute(content: string, name: string, domains: string[], network: MihomoRouteNetwork = 'tcp,udp'): string {
  const title = name.trim()
  if (!title || title.length > 40 || /[,\r\n<>:#]/.test(title)) throw new Error('Название маршрута: от 1 до 40 символов, без запятых, двоеточия и #')
  if (groupNames(content).includes(title)) throw new Error('Группа с таким названием уже есть')
  const validDomain = (domain: string) => /^(?:(?:domain|full):)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(domain)
    || /^geosite:[a-z0-9_-]+$/i.test(domain)
    || /^(?:RULE-SET|DOMAIN|DOMAIN-SUFFIX|DOMAIN-KEYWORD|GEOSITE|GEOIP|IP-CIDR|IP-CIDR6),[^,\r\n]+$/.test(domain)
  if (domains.length < 1 || domains.length > 50 || domains.some((domain) => !validDomain(domain))) throw new Error('Выберите от 1 до 50 ресурсов маршрута')
  const tag = `custom:${encodeURIComponent(title)}`
  if (readMihomoCustomRoutes(content).some((route) => route.tag === tag)) throw new Error('Маршрут уже добавлен')
  const selector = defaultMihomoChoices(content).VPN
  const providers = providerNames(content)
  const group = [
    `  - name: ${JSON.stringify(title)}`, '    type: select',
    `    proxies: [${JSON.stringify(selector)}, DIRECT${inlineProxyNames(content).has('CSQTT') ? ', CSQTT' : ''}${inlineProxyNames(content).has('WDTT Plus') ? ', "WDTT Plus"' : ''}]`,
    ...(providers.length ? [`    use: [${providers.map((provider) => JSON.stringify(provider)).join(', ')}]`] : []),
    '',
  ].join('\n')
  let updated = content.replace(/^proxy-groups:\s*\r?\n/m, (header) => header + group)
  if (updated === content) throw new Error('В config.yaml нет раздела proxy-groups')
  const section = rulesSection(updated)
  const base = section.body
  const metadata: MihomoCustomRoute = { tag, name: title, domains: [...new Set(domains.map((domain) => /^[A-Z0-9-]+,/.test(domain) ? domain : domain.toLowerCase()))] }
  const ruleBlock = `  # ${CUSTOM} ${encodeURIComponent(JSON.stringify(metadata))}\n` + metadata.domains.map((domain) => {
    if (/^[A-Z0-9-]+,/.test(domain)) return formatRouteRule(domain, title, network)
    const [kind, value] = domain.startsWith('geosite:') || domain.startsWith('domain:') || domain.startsWith('full:')
      ? domain.split(/:(.*)/s, 2) : ['domain', domain]
    const ruleKind = kind === 'geosite' ? 'GEOSITE' : kind === 'full' ? 'DOMAIN' : 'DOMAIN-SUFFIX'
    return formatRouteRule(`${ruleKind},${value}`, title, network)
  }).join('')
  const defaults = defaultMihomoChoices(updated)
  const categoryTargets = new Set(ROUTE_TAGS.filter((route) => route !== 'VPN').map((route) => defaults[route]))
  let offset = base.search(/^  - MATCH,/m)
  for (const match of base.matchAll(/^  - [^\r\n]+/gm)) {
    if (categoryTargets.has(parseRouteRule(match[0])?.target ?? '')) { offset = match.index; break }
  }
  if (offset < 0) offset = base.length
  updated = updated.slice(0, section.start) + base.slice(0, offset) + ruleBlock + base.slice(offset) + updated.slice(section.end)
  const profiles = readMihomoDevices(content)
  return profiles.length ? updateMihomoDevice(updated, profiles[0].ip, 'VPN') : updated
}

export function removeMihomoCustomRoute(content: string, tag: string): string {
  const route = readMihomoCustomRoutes(content).find((item) => item.tag === tag)
  if (!route) throw new Error('Маршрут не найден')
  const rules = rulesSection(content)
  const block = uniqueRouteBlock(content, tag)
  if (!block) throw new Error('У маршрута нет отдельного непрерывного блока правил')
  const withoutRules = content.slice(0, rules.start + block.start) + content.slice(rules.start + block.end)
  const groupsHeader = /^proxy-groups:\s*\r?\n/m.exec(content)
  if (!groupsHeader || groupsHeader.index === undefined) throw new Error('Группы Mihomo не найдены')
  const start = groupsHeader.index + groupsHeader[0].length
  const nextSection = /^[A-Za-z][\w-]*:/m.exec(content.slice(start))
  const end = nextSection ? start + nextSection.index : content.length
  const body = content.slice(start, end)
  const groups = [...body.matchAll(/^  - name:\s*(.+?)\s*$/gm)]
  const index = groups.findIndex((match) => match[1].replace(/^['"]|['"]$/g, '') === route.name)
  if (index < 0) throw new Error('Группа маршрута не найдена')
  const from = groups[index].index!
  const to = index + 1 < groups.length ? groups[index + 1].index! : body.length
  let updated = withoutRules.slice(0, start + from) + withoutRules.slice(start + to)
  const profiles = readMihomoDevices(content)
  return profiles.length ? updateMihomoDevice(updated, profiles[0].ip, 'VPN') : updated
}

export function renameMihomoCustomRoute(content: string, tag: string, name: string): string {
  const route = readMihomoCustomRoutes(content).find((item) => item.tag === tag)
  if (!route) throw new Error('Маршрут не найден')
  const title = name.trim()
  if (!title || title.length > 40 || /[,\r\n<>:#]/.test(title)) throw new Error('Название маршрута: от 1 до 40 символов, без запятых, двоеточия и #')
  if (title === route.name) return content
  if (groupNames(content).includes(title)) throw new Error('Группа с таким названием уже есть')
  const nextTag = `custom:${encodeURIComponent(title)}`
  const previousGroup = `  - name: ${JSON.stringify(route.name)}\n`
  if (!content.includes(previousGroup)) throw new Error('Группа маршрута не найдена')
  const section = rulesSection(content)
  const block = uniqueRouteBlock(content, tag)
  if (!block) throw new Error('У маршрута нет отдельного непрерывного блока правил')
  const renamed = block.text.split('\n').map(line => {
    const rule = parseRouteRule(line)
    return rule?.target === route.name ? formatRouteRule(rule.matcher, title, rule.network, rule.disabled).trimEnd() : line
  }).join('\n')
  let updated = content.slice(0, section.start + block.start) + renamed + content.slice(section.start + block.end)
  updated = updated.replace(previousGroup, `  - name: ${JSON.stringify(title)}\n`)
  const metadata = `  # ${CUSTOM} ${encodeURIComponent(JSON.stringify(route))}`
  if (!updated.includes(metadata)) throw new Error('Описание маршрута не найдено')
  updated = updated.replace(metadata, `  # ${CUSTOM} ${encodeURIComponent(JSON.stringify({ ...route, tag: nextTag, name: title }))}`)
  updated = updated.replace(/^(  # xkeen-device-start [^\s]+ )(\S+)(\r?)$/gm, (_line, prefix: string, encoded: string, end: string) => {
    try {
      const choices = JSON.parse(decodeURIComponent(encoded)) as DeviceChoices
      if (Object.prototype.hasOwnProperty.call(choices, tag)) {
        choices[nextTag] = choices[tag] === route.name ? title : choices[tag]
        delete choices[tag]
      }
      for (const key of Object.keys(choices)) if (choices[key] === route.name) choices[key] = title
      return `${prefix}${encodeURIComponent(JSON.stringify(choices))}${end}`
    } catch { return `${prefix}${encoded}${end}` }
  })
  const profiles = readMihomoDevices(updated)
  return profiles.length ? updateMihomoDevice(updated, profiles[0].ip, 'VPN') : updated
}

// Resources are native Mihomo matchers, preserving provider references and IP flags.
export function readMihomoRouteResources(content: string, tag: RouteTag): string[] {
  const block = uniqueRouteBlock(content, tag)
  if (!block) return []
  return [...new Set(block.text.split(/\r?\n/).map(parseRouteRule).filter((rule): rule is ParsedRouteRule => !!rule).map(rule => rule.matcher))]
}

export function readMihomoRouteNetwork(content: string, tag: RouteTag): MihomoRouteNetwork | 'mixed' {
  const block = uniqueRouteBlock(content, tag)
  if (!block) return 'tcp,udp'
  const networks = new Set(block.text.split(/\r?\n/).map(parseRouteRule).filter((rule): rule is ParsedRouteRule => !!rule).map(rule => rule.network))
  return networks.size === 1 ? [...networks][0] : networks.size === 0 ? 'tcp,udp' : 'mixed'
}

export function isMihomoRouteEnabled(content: string, tag: RouteTag): boolean {
  if (tag === 'VPN') return true
  const block = uniqueRouteBlock(content, tag)
  if (!block) return true
  return !/^  # xkeen-disabled-rule /m.test(block.text)
}

export function withMihomoRouteEnabled(content: string, tag: RouteTag, enabled: boolean): string {
  if (tag === 'VPN') throw new Error('Маршрут по умолчанию нельзя отключить')
  const block = uniqueRouteBlock(content, tag)
  if (!block) throw new Error('У маршрута нет отдельного непрерывного блока правил')
  const section = rulesSection(content)
  const toggled = block.text.split(/(?<=\n)/).map(line => {
    const rule = parseRouteRule(line)
    return rule ? formatRouteRule(rule.matcher, rule.target, rule.network, !enabled) : line
  }).join('')
  const body = section.body.slice(0, block.start) + toggled + section.body.slice(block.end)
  const updated = content.slice(0, section.start) + body + content.slice(section.end)
  const profiles = readMihomoDevices(content)
  return profiles.length ? updateMihomoDevice(updated, profiles[0].ip, 'VPN') : updated
}

export function editMihomoRouteResources(content: string, tag: RouteTag, resources: string[], allowEmpty = false, network?: MihomoRouteNetwork): string {
  if (tag === 'VPN') throw new Error('У маршрута по умолчанию нет отдельных ресурсов')
  const target = defaultMihomoChoices(content)[tag]
  if (!target || target === defaultMihomoChoices(content).VPN) throw new Error('Отдельная группа маршрута не найдена')
  const values = [...new Set(resources.map(value => value.trim()).filter(Boolean))]
  if (!values.length && !allowEmpty) throw new Error('Добавьте хотя бы один домен или IP')
  if (values.some(value => !/^(?:RULE-SET|DOMAIN|DOMAIN-SUFFIX|DOMAIN-KEYWORD|GEOSITE|GEOIP|IP-CIDR|IP-CIDR6),[^,\r\n]+$/.test(value))) throw new Error('Неверный ресурс Mihomo')
  const section = rulesSection(content)
  const block = uniqueRouteBlock(content, tag)
  if (!block) throw new Error('У маршрута нет отдельного непрерывного блока правил')
  const nextNetwork = network ?? readMihomoRouteNetwork(content, tag)
  if (nextNetwork === 'mixed') throw new Error('В маршруте смешаны TCP и UDP. Выберите сеть перед изменением ресурсов')
  const marker = /^  # xkeen-custom-route \S+\r?\n/.exec(block.text)?.[0] ?? ''
  const replacement = marker + values.map(value => formatRouteRule(value, target, nextNetwork, !isMihomoRouteEnabled(content, tag))).join('')
  const body = section.body.slice(0, block.start) + replacement + section.body.slice(block.end)
  let updated = content.slice(0, section.start) + body + content.slice(section.end)
  const route = readMihomoCustomRoutes(content).find(item => item.tag === tag)
  if (route) updated = updated.replace(`  # ${CUSTOM} ${encodeURIComponent(JSON.stringify(route))}`, `  # ${CUSTOM} ${encodeURIComponent(JSON.stringify({ ...route, domains: values }))}`)
  const profiles = readMihomoDevices(content)
  return profiles.length ? updateMihomoDevice(updated, profiles[0].ip, 'VPN') : updated
}

export function removeMihomoRoute(content: string, tag: RouteTag): string {
  if (tag.startsWith('custom:')) return removeMihomoCustomRoute(content, tag)
  return editMihomoRouteResources(content, tag, [], true)
}

type XrayOutbound = { tag: string; protocol: string; [key: string]: unknown }
type XrayConfig = {
  inbounds?: unknown[]
  outbounds?: XrayOutbound[]
  routing?: { rules?: unknown[]; balancers?: unknown[]; [key: string]: unknown }
  [key: string]: unknown
}

const MAX_NODES = 64
const MANAGED_PREFIX = 'sub-'

function subscriptionTag(id: string, index: number): string {
  return id === 'legacy' ? `sub-${String(index + 1).padStart(2, '0')}` : `sub-${id}-${String(index + 1).padStart(2, '0')}`
}

function belongsToSubscription(tag: string, id: string): boolean {
  return id === 'legacy' ? /^sub-\d+$/.test(tag) : tag.startsWith(`sub-${id}-`)
}

export function countXraySubscriptionNodes(content: string, id: string): number {
  try {
    const config = JSON.parse(content) as XrayConfig
    return (config.outbounds ?? []).filter((outbound) => belongsToSubscription(outbound.tag ?? '', id)).length
  } catch { return 0 }
}

function repairOutboundReferences(config: XrayConfig, removed: Set<string>, preferred: string): void {
  if (!Array.isArray(config.routing?.rules)) return
  for (const rule of config.routing.rules as Array<{ outboundTag?: string }>) {
    if (rule.outboundTag && removed.has(rule.outboundTag)) rule.outboundTag = preferred
  }
}

export function removeXraySubscription(content: string, id: string): string {
  const config = JSON.parse(content) as XrayConfig
  if (!Array.isArray(config.outbounds)) throw new Error('В текущем JSON отсутствует массив outbounds')
  const removed = new Set(config.outbounds.filter((outbound) => belongsToSubscription(outbound.tag ?? '', id)).map((outbound) => outbound.tag))
  config.outbounds = config.outbounds.filter((outbound) => !removed.has(outbound.tag))
  const next = config.outbounds.find((outbound) => outbound.tag?.startsWith(MANAGED_PREFIX))?.tag ?? 'direct'
  repairOutboundReferences(config, removed, next)
  return JSON.stringify(config, null, 2)
}

const ROUTE_DOMAINS: Array<[string, string[]]> = [
  ['Youtube', ['domain:youtube.com', 'domain:youtu.be', 'domain:googlevideo.com', 'domain:ytimg.com']],
  ['Discord', ['domain:discord.com', 'domain:discord.gg', 'domain:discordapp.com']],
  ['Games', ['domain:steampowered.com', 'domain:steamcommunity.com', 'domain:epicgames.com', 'domain:riotgames.com']],
  ['AI', ['domain:gemini.google.com', 'domain:openai.com', 'domain:chatgpt.com']],
  ['Github', ['domain:github.com', 'domain:githubusercontent.com']],
]

export function enableXrayRoutingCards(content: string): string {
  const config = JSON.parse(content) as XrayConfig
  const rules = config.routing?.rules as Array<Record<string, unknown>> | undefined
  if (!Array.isArray(rules)) throw new Error('В Xray JSON нет правил маршрутизации')
  const hadVpn = rules.some((rule) => rule.ruleTag === 'VPN')
  if (!hadVpn) {
    const index = rules.findIndex((rule) => rule.type === 'field' && rule.network === 'tcp,udp' && (typeof rule.outboundTag === 'string' || typeof rule.balancerTag === 'string'))
    if (index < 0) throw new Error('В Xray JSON не найдено общее правило TCP/UDP')
    const fallback = rules[index]
    const target = fallback.balancerTag ? { balancerTag: fallback.balancerTag } : { outboundTag: fallback.outboundTag }
    const categories = ROUTE_DOMAINS.filter(([tag]) => !rules.some((rule) => rule.ruleTag === tag || rule.ruleTag === `${tag}|selector`))
      .map(([tag, domain]) => ({ type: 'field', ruleTag: `${tag}|selector`, domain, ...target }))
    rules.splice(index, 1, ...categories, { ...fallback, ruleTag: 'VPN' })
  }
  if (!hadVpn && config.outbounds?.some((outbound) => outbound.tag === 'direct') && !rules.some((rule) => rule.ruleTag === 'RU')) {
    const fallbackIndex = rules.findIndex((rule) => rule.ruleTag === 'VPN')
    if (fallbackIndex >= 0) rules.splice(fallbackIndex, 0, { type: 'field', ruleTag: 'RU', domain: ['geosite:category-ru'], outboundTag: 'direct' })
  }
  return JSON.stringify(config, null, 2)
}

export function subscriptionUris(content: string): string[] {
  let text = content.trim()
  if (!text.includes('://')) {
    try {
      const bytes = Uint8Array.from(atob(text.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0))
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new Error('Не удалось декодировать подписку base64')
    }
  }
  const uris = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^(vless|vmess|trojan|ss|hysteria2|hy2):\/\//i.test(line))
  if (uris.length === 0) throw new Error('В подписке не найдены поддерживаемые узлы')
  if (uris.length > MAX_NODES) throw new Error(`В подписке больше ${MAX_NODES} узлов`)
  return uris
}

function starterConfig(outbounds: XrayOutbound[]): XrayConfig {
  return {
    log: { loglevel: 'warning' },
    api: { tag: 'xkeen-routing-api', listen: '127.0.0.1:18085', services: ['RoutingService'] },
    observatory: { subjectSelector: [MANAGED_PREFIX], probeUrl: 'https://cp.cloudflare.com', probeInterval: '2m', enableConcurrency: false },
    inbounds: [
      { tag: 'redirect', port: 61219, protocol: 'dokodemo-door', settings: { network: 'tcp', followRedirect: true }, sniffing: { enabled: true, routeOnly: true, destOverride: ['http', 'tls', 'quic'] } },
      { tag: 'tproxy', port: 61219, protocol: 'dokodemo-door', settings: { network: 'udp', followRedirect: true }, sniffing: { enabled: true, routeOnly: true, destOverride: ['http', 'tls', 'quic'] }, streamSettings: { sockopt: { tproxy: 'tproxy' } } },
    ],
    outbounds: [...outbounds, { tag: 'direct', protocol: 'freedom' }, { tag: 'CSQTT', protocol: 'freedom', streamSettings: { sockopt: { interface: 'csqtt0' } } }, { tag: 'block', protocol: 'blackhole' }],
    routing: {
      domainStrategy: 'AsIs',
      balancers: [{ tag: 'auto-vpn', selector: [MANAGED_PREFIX], fallbackTag: 'direct', strategy: { type: 'roundRobin' } }],
      rules: [
        { type: 'field', ip: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '169.254.0.0/16', 'fc00::/7', 'fe80::/10'], outboundTag: 'direct' },
        { type: 'field', protocol: ['bittorrent'], outboundTag: 'direct' },
        { type: 'field', ruleTag: 'Youtube|selector', domain: ['domain:youtube.com', 'domain:youtu.be', 'domain:googlevideo.com', 'domain:ytimg.com'], balancerTag: 'auto-vpn' },
        { type: 'field', ruleTag: 'Discord|selector', domain: ['domain:discord.com', 'domain:discord.gg', 'domain:discordapp.com'], balancerTag: 'auto-vpn' },
        { type: 'field', ruleTag: 'Games|selector', domain: ['domain:steampowered.com', 'domain:steamcommunity.com', 'domain:epicgames.com', 'domain:riotgames.com'], balancerTag: 'auto-vpn' },
        { type: 'field', ruleTag: 'AI|selector', domain: ['domain:openai.com', 'domain:chatgpt.com'], balancerTag: 'auto-vpn' },
        { type: 'field', ruleTag: 'Github|selector', domain: ['domain:github.com', 'domain:githubusercontent.com'], balancerTag: 'auto-vpn' },
        { type: 'field', ruleTag: 'RU', domain: ['geosite:category-ru'], outboundTag: 'direct' },
        { type: 'field', ruleTag: 'VPN', network: 'tcp,udp', balancerTag: 'auto-vpn' },
      ],
    },
  }
}

export function xrayConfigFromSubscription(content: string, existingContent = '', id = 'legacy'): { json: string; count: number } {
  const parser = (window as any).generateConfigForCore as ((uri: string, core: string, existing: string) => { content: string; type: string }) | undefined
  if (!parser) throw new Error('Парсер подключений не загружен')
  const uris = subscriptionUris(content)
  const outbounds: XrayOutbound[] = uris.map((uri, index) => {
    const parsed = parser(uri, 'xray', '')
    if (parsed.type !== 'outbound') throw new Error(`Узел ${index + 1} не является Xray outbound`)
    const outbound = JSON.parse(parsed.content) as XrayOutbound
    outbound.tag = subscriptionTag(id, index)
    const fragment = uri.split('#', 2)[1]
    if (fragment) {
      try {
        const name = decodeURIComponent(fragment.replace(/\+/g, '%20')).trim().replace(/[\u0000-\u001f]/g, '')
        if (name) outbound.xkeenDisplayName = name.slice(0, 100)
      } catch { /* An invalid fragment does not invalidate the connection. */ }
    }
    return outbound
  })
  let config: XrayConfig
  if (existingContent.trim()) {
    config = JSON.parse(existingContent) as XrayConfig
    if (!Array.isArray(config.outbounds)) throw new Error('В текущем JSON отсутствует массив outbounds')
    const removed = new Set(config.outbounds.filter((outbound) => belongsToSubscription(outbound.tag ?? '', id)).map((outbound) => outbound.tag))
    const retained = config.outbounds.filter((outbound) => !removed.has(outbound.tag))
    if (outbounds.length + retained.filter((outbound) => outbound.tag?.startsWith(MANAGED_PREFIX)).length > MAX_NODES) throw new Error(`Всего можно хранить не более ${MAX_NODES} узлов`)
    config.outbounds = [...outbounds, ...retained]
    const currentTags = new Set(config.outbounds.map((outbound) => outbound.tag))
    const replacement = outbounds[0]?.tag ?? config.outbounds.find((outbound) => outbound.tag?.startsWith(MANAGED_PREFIX))?.tag ?? 'direct'
    if (Array.isArray(config.routing?.rules)) {
      for (const rule of config.routing.rules as Array<{ outboundTag?: string; ruleTag?: string }>) {
        if ((rule.ruleTag?.endsWith('|selector') || retained.every((outbound) => ['freedom', 'blackhole'].includes(outbound.protocol)))
          && rule.outboundTag === 'block' && ['VPN', 'Youtube', 'Discord', 'Games', 'AI', 'Github'].includes((rule.ruleTag ?? '').replace(/\|selector$/, ''))) {
          rule.outboundTag = outbounds[0].tag
        }
        if (rule.outboundTag?.startsWith(MANAGED_PREFIX) && !currentTags.has(rule.outboundTag)) rule.outboundTag = replacement
      }
    }
  } else {
    config = starterConfig(outbounds)
  }
  return { json: enableXrayRoutingCards(JSON.stringify(config)), count: outbounds.length }
}

import { load as loadYaml, dump as dumpYaml } from 'js-yaml'
import { defaultMihomoChoices, readMihomoCustomRoutes } from './mihomoDeviceRouting'

const STARTER_ROUTES = [
  { tag: 'Discord', name: 'Discord', matchers: ['GEOSITE,discord'] },
  { tag: 'Games', name: 'Игры', matchers: ['GEOSITE,category-games'] },
  { tag: 'Github', name: 'GitHub', matchers: ['GEOSITE,github'] },
  { tag: 'custom:Реклама', name: 'Реклама', matchers: ['GEOSITE,category-ads-all'] },
  { tag: 'Youtube', name: 'YouTube', matchers: ['GEOSITE,youtube'] },
  { tag: 'AI', name: 'AI', matchers: ['GEOSITE,openai', 'GEOSITE,anthropic', 'GEOSITE,google-gemini', 'GEOSITE,perplexity'] },
  { tag: 'RU', name: 'RU', matchers: ['GEOSITE,category-ru', 'GEOIP,ru'] },
]

function insertSection(content: string, key: string, addition: string, beforeCatchall = false): string {
  if (!addition) return content
  const header = new RegExp(`^${key}:[ \\t]*(?:\\[\\])?[ \\t]*\\r?\\n`, 'm').exec(content)
  if (!header) throw new Error(`В Mihomo YAML нет блочного раздела ${key}`)
  const start = header.index + header[0].length
  const next = /^[A-Za-z][\w-]*:/m.exec(content.slice(start))
  const end = next ? start + next.index : content.length
  const catchall = beforeCatchall ? /^  - (?:MATCH|FINAL),/m.exec(content.slice(start, end)) : null
  const at = catchall ? start + catchall.index : end
  return content.slice(0, header.index) + `${key}:\n` + content.slice(start, at) + (at > start && content[at - 1] !== '\n' ? '\n' : '') + addition + content.slice(at)
}

/** Explicitly add missing starter routes; updates must never call this implicitly. */
export function addMissingMihomoStarterRoutes(content: string): string {
  const config = loadYaml(content) as Record<string, unknown>
  if (!config || !Array.isArray(config['proxy-groups']) || !Array.isArray(config.rules)) throw new Error('В Mihomo YAML нет групп или правил маршрутизации')
  const groups = config['proxy-groups'] as Array<Record<string, unknown>>
  const names = groups.flatMap(group => typeof group.name === 'string' ? [group.name] : [])
  const nodes = Array.isArray(config.proxies) ? config.proxies.flatMap(node => node && typeof node === 'object' && typeof node.name === 'string' ? [node.name] : []) : []
  const providers = config['proxy-providers'] && typeof config['proxy-providers'] === 'object' ? Object.keys(config['proxy-providers']) : []
  const choices = defaultMihomoChoices(content)
  const customs = readMihomoCustomRoutes(content)
  const addedGroups: Array<Record<string, unknown>> = []
  let additions = ''
  for (const route of STARTER_ROUTES) {
    const existing = route.tag.startsWith('custom:') ? customs.find(custom => custom.tag === route.tag)?.name
      : choices[route.tag] !== choices.VPN ? choices[route.tag] : undefined
    const target = existing ?? route.name
    // An existing route may deliberately use custom resources or be disabled.
    // Keep its complete matcher list, selection and enabled state intact.
    if (existing && new RegExp(`^  (?:- |# xkeen-disabled-rule ).*,${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:,no-resolve)?$`, 'm').test(content)) continue
    if (!names.includes(target)) {
      addedGroups.push({ name: target, type: 'select', proxies: [...new Set([...(route.tag === 'custom:Реклама' ? ['REJECT', 'DIRECT'] : ['DIRECT']), ...nodes].filter(name => name !== target))], ...(providers.length ? { use: providers } : {}) })
      names.push(target)
    }
    if (route.tag.startsWith('custom:') && !customs.some(custom => custom.tag === route.tag)) {
      additions += `  # xkeen-custom-route ${encodeURIComponent(JSON.stringify({tag: route.tag, name: target, domains: route.matchers.map(matcher => matcher.replace('GEOSITE,', 'geosite:'))}))}\n`
    }
    additions += route.matchers.map(matcher => `  - ${matcher},${target}${matcher.startsWith('GEOIP,') ? ',no-resolve' : ''}\n`).join('')
  }
  let updated = insertSection(content, 'proxy-groups', addedGroups.length ? dumpYaml(addedGroups, { lineWidth: -1, noRefs: true }).split('\n').filter(Boolean).map(line => `  ${line}`).join('\n') + '\n' : '')
  updated = insertSection(updated, 'rules', additions, true)
  if (additions && !/^geodata-mode:/m.test(updated)) updated = `geodata-mode: true\n${updated}`
  else if (additions) updated = updated.replace(/^geodata-mode:[^\r\n]*/m, 'geodata-mode: true')
  return updated
}

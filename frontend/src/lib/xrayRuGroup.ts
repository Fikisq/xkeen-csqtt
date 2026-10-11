import { baseRuleTag, type RoutingRule } from './xrayDeviceRouting'

export const isRuGroup = (rule: RoutingRule) => rule.xkeenRouteGroup === 'roscomvpn-ru'
const scope = (rule: RoutingRule) => baseRuleTag(rule).replace(/^disabled:/, '').match(/^device:([^:]+):/)?.[1] ?? ''
export const sameRuGroup = (a: RoutingRule, b: RoutingRule) => isRuGroup(a) && isRuGroup(b) && scope(a) === scope(b)

export function groupRuRows(entries: Array<{ rule: RoutingRule; index: number }>) {
  const result: typeof entries = []
  for (const entry of entries) {
    const existing = result.find(item => sameRuGroup(item.rule, entry.rule))
    if (!existing) result.push({ ...entry, rule: { ...entry.rule } })
    else {
      existing.rule.domain = [...(existing.rule.domain ?? []), ...(entry.rule.domain ?? [])]
      existing.rule.ip = [...(existing.rule.ip ?? []), ...(entry.rule.ip ?? [])]
    }
  }
  return result
}

// A combined row means domain OR IP. Persist two native Xray rules, never an
// AND condition, and preserve the resource kind when editing either branch.
export function ruBranchResources(rule: RoutingRule, domain: string[], ip: string[]) {
  return isRuGroup(rule)
    ? { domain: rule.domain ? domain : undefined, ip: rule.ip ? ip : undefined }
    : { domain: domain.length ? domain : undefined, ip: ip.length ? ip : undefined }
}

export function reorderRuGroups(current: RoutingRule[], include: (rule: RoutingRule) => boolean, from: number, to: number) {
  const positions = current.flatMap((rule, index) => include(rule) ? [index] : [])
  const groups: RoutingRule[][] = []
  for (const position of positions) {
    const rule = current[position]
    const group = groups.find(items => sameRuGroup(items[0], rule))
    if (group) group.push(rule)
    else groups.push([rule])
  }
  if (!groups[from] || !groups[to] || /(?:^|:)VPN$/.test(baseRuleTag(groups[from][0])) || /(?:^|:)VPN$/.test(baseRuleTag(groups[to][0]))) return current
  const [moved] = groups.splice(from, 1)
  groups.splice(to, 0, moved)
  const reordered = groups.flat()
  const result = [...current]
  positions.forEach((position, index) => { result[position] = reordered[index] })
  return result
}

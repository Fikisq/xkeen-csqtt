import { baseRuleTag, routeTags, validDeviceIp, type RoutingRule } from './xrayDeviceRouting'
import { sameRuGroup } from './xrayRuGroup'

// Change destinations only: keep conditions, disabled state and rule ordering.
export function updateSelectedOutbounds(rules: RoutingRule[], ids: string[], outbound: string, deviceIp = ''): RoutingRule[] {
  if (!ids.length) throw new Error('Выберите правила')
  if (!outbound || outbound === '@bypass' || outbound.startsWith('@') && (!outbound.startsWith('@balancer:') || !outbound.slice(10))) throw new Error('Выберите исходящее подключение')
  if (deviceIp && !validDeviceIp(deviceIp)) throw new Error('Неверный IP устройства')
  const name = (rule: RoutingRule) => baseRuleTag(rule).replace(/^disabled:/, '')
  const globalTags = new Set(routeTags(rules))
  const inScope = (rule: RoutingRule) => deviceIp
    ? name(rule).startsWith(`device:${deviceIp}:`)
    : globalTags.has(baseRuleTag(rule))
  const selected = [...new Set(ids)].map(id => {
    const rule = rules.find(rule => inScope(rule) && name(rule) === id)
    if (!rule) throw new Error('Выбранное правило изменилось. Выберите его заново')
    return rule
  })
  const destination = outbound.startsWith('@balancer:') ? { balancerTag: outbound.slice(10) } : { outboundTag: outbound }
  return rules.map(rule => {
    if (!inScope(rule) || !selected.some(item => item === rule || sameRuGroup(item, rule))) return rule
    const fallback = name(rule) === (deviceIp ? `device:${deviceIp}:VPN` : 'VPN')
    return {
      ...rule,
      ruleTag: baseRuleTag(rule) + (fallback && outbound === 'direct' ? '|split' : ''),
      outboundTag: undefined, balancerTag: undefined, ...destination,
    }
  })
}

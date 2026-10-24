import { parse } from 'jsonc-parser'
import { baseRuleTag, isFullBypass, validDeviceIp, type RoutingRule } from './xrayDeviceRouting'
import { updateMihomoDevice, withMihomoRouteEnabled } from './mihomoDeviceRouting'

// Transfer only explicit whole-device direct exceptions. Destination routing is
// owned by Mihomo; split-direct rules and ordinary proxy choices stay untouched.
export function transferXrayFullBypass(source: string, target: string): { content: string; devices: string[] } {
  const rules = parse(source)?.routing?.rules as RoutingRule[] | undefined
  if (!Array.isArray(rules)) throw new Error('Правила Xray не найдены')
  let content = target
  const devices: string[] = []
  for (const rule of rules) {
    const match = /^device:([^:]+):VPN$/.exec(baseRuleTag(rule).replace(/^disabled:/, ''))
    if (!match || !isFullBypass(rule)) continue
    const ip = match[1]
    if (!validDeviceIp(ip) || devices.includes(ip)) throw new Error('Некорректное или повторяющееся правило полного обхода Xray')
    if (rule.domain?.length || rule.ip?.length || rule.port || rule.sourcePort || rule.protocol || rule.inboundTag || rule.network && rule.network !== 'tcp,udp') throw new Error(`Правило ${ip} содержит дополнительные условия и не может быть перенесено как полный обход`)
    const disabled = baseRuleTag(rule).startsWith('disabled:') || rule.sourceIP?.[0] === '192.0.2.255'
    if (rule.sourceIP?.length !== 1 || rule.sourceIP[0] !== (disabled ? '192.0.2.255' : ip)) throw new Error(`IP источника правила ${ip} не соответствует полному обходу`)
    content = updateMihomoDevice(content, ip, 'VPN', 'DIRECT')
    content = withMihomoRouteEnabled(content, 'VPN', !disabled, ip)
    devices.push(ip)
  }
  return { content, devices }
}

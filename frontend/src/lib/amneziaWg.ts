import { dump, load } from 'js-yaml'
import { replaceSection, section } from './mihomoRoutingBackup.ts'

export function isAwgInput(input: string): boolean {
  return /^vpn:\/\//i.test(input.trim()) || /^\s*\[Interface\]/im.test(input)
}

// Import declarative tunnel settings only. Shell hooks are never accepted.
export function importAwg(input: string): { content: string; type: string } {
  let text = input.trim()
  if (text.length > 65536) throw new Error('Конфигурация AWG слишком большая')
  if (/^vpn:\/\//i.test(text)) {
    try {
      const encoded = text.slice(6).replace(/-/g, '+').replace(/_/g, '/')
      text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(encoded), c => c.charCodeAt(0)))
    } catch { throw new Error('Нужна текстовая vpn:// ссылка 3x-ui или файл AWG .conf') }
  }
  const fields: Record<string, Record<string, string>> = { Interface: {}, Peer: {} }
  let section = ''
  const seen = new Set<string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s*[#;].*$/, '').trim()
    if (!line) continue
    const header = /^\[(Interface|Peer)\]$/.exec(line)
    if (header) {
      section = header[1]
      if (seen.has(section)) throw new Error('Поддерживается один Interface и один Peer')
      seen.add(section)
      continue
    }
    const pair = /^([A-Za-z][A-Za-z0-9]*)\s*=\s*(.*)$/.exec(line)
    if (!pair || !section) throw new Error('Неверный формат AWG .conf')
    if (Object.hasOwn(fields[section], pair[1])) throw new Error(`Повтор параметра ${pair[1]}`)
    fields[section][pair[1]] = pair[2].trim()
  }
  const iface = fields.Interface, peer = fields.Peer
  const key = (value: string | undefined, name: string) => {
    if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error(`Некорректный ключ ${name}`)
    return value
  }
  const endpoint = /^(?:\[([^\]]+)\]|([^:\s]+)):(\d+)$/.exec(peer.Endpoint ?? '')
  if (!endpoint || Number(endpoint[3]) < 1 || Number(endpoint[3]) > 65535) throw new Error('Некорректный Endpoint AWG')
  const addresses = (iface.Address ?? '').split(',').map(x => x.trim().split('/')[0]).filter(Boolean)
  if (!addresses.length) throw new Error('В AWG отсутствует Address')
  const proxy: Record<string, unknown> = {
    name: `AWG · ${endpoint[1] || endpoint[2]}`, type: 'wireguard',
    server: endpoint[1] || endpoint[2], port: Number(endpoint[3]),
    'private-key': key(iface.PrivateKey, 'PrivateKey'), 'public-key': key(peer.PublicKey, 'PublicKey'),
    'allowed-ips': (peer.AllowedIPs ?? '0.0.0.0/0').split(',').map(x => x.trim()),
    udp: true, 'routing-mark': 255,
  }
  for (const address of addresses) {
    const family = address.includes(':') ? 'ipv6' : 'ip'
    if (proxy[family]) throw new Error('Поддерживается один адрес каждого семейства')
    proxy[family] = address
  }
  if (peer.PresharedKey) proxy['pre-shared-key'] = key(peer.PresharedKey, 'PresharedKey')
  if (iface.MTU) {
    if (!/^\d+$/.test(iface.MTU) || +iface.MTU < 576 || +iface.MTU > 9000) throw new Error('Некорректный MTU')
    proxy.mtu = +iface.MTU
  }
  if (iface.DNS) { proxy.dns = iface.DNS.split(',').map(x => x.trim()); proxy['remote-dns-resolve'] = true }
  if (peer.PersistentKeepalive) {
    if (!/^\d+$/.test(peer.PersistentKeepalive)) throw new Error('PersistentKeepalive должен быть целым числом')
    proxy['persistent-keepalive'] = +peer.PersistentKeepalive
  }
  const mapping: Record<string, string> = {
    Jc: 'jc', Jmin: 'jmin', Jmax: 'jmax', S1: 's1', S2: 's2', S3: 's3', S4: 's4',
    H1: 'h1', H2: 'h2', H3: 'h3', H4: 'h4', I1: 'i1', I2: 'i2', I3: 'i3', I4: 'i4', I5: 'i5',
    HeaderProtectionKey: 'header-protection-key', ContentPaddingAddition: 'content-padding-addition',
    RekeyAfterTime: 'rekey-after-time', RekeyTimeout: 'rekey-timeout', RejectAfterTime: 'reject-after-time',
    KeepaliveTimeout: 'keepalive-timeout', MaxHandshakeAttempts: 'max-handshake-attempts',
    RandomTrailers: 'random-trailers', DisableCookies: 'disable-cookies',
  }
  const options: Record<string, unknown> = { version: 3 }
  if (!iface.HeaderProtectionKey) throw new Error('Для импорта AWG 3.1 нужен HeaderProtectionKey')
  for (const [name, target] of Object.entries(mapping)) {
    const value = iface[name]
    if (value === undefined) continue
    if (name === 'HeaderProtectionKey') options[target] = key(value, name)
    else if (name === 'RandomTrailers' || name === 'DisableCookies') {
      if (!/^(on|off|true|false|0|1)$/i.test(value)) throw new Error(`Некорректный ${name}`)
      options[target] = /^(on|true|1)$/i.test(value)
    } else if (/^I[1-5]$/.test(name)) options[target] = value
    else if (/^H[1-4]$/.test(name) || name === 'ContentPaddingAddition') {
      if (!/^\d+(?:-\d+)?$/.test(value)) throw new Error(`Некорректный ${name}`)
      options[target] = value
    } else {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`Некорректный ${name}`)
      options[target] = Number(value)
    }
  }
  const accepted = new Set(['PrivateKey', 'Address', 'DNS', 'MTU', ...Object.keys(mapping)])
  for (const name of Object.keys(iface)) if (!accepted.has(name)) throw new Error(`Параметр Interface ${name} не поддерживается; импорт отменён`)
  for (const name of Object.keys(peer)) if (!['PublicKey', 'PresharedKey', 'Endpoint', 'AllowedIPs', 'PersistentKeepalive'].includes(name)) throw new Error(`Параметр Peer ${name} не поддерживается`)
  proxy['amnezia-wg-option'] = options
  return { content: dump([proxy], { lineWidth: -1, noRefs: true }), type: 'awg-proxy' }
}

export function addAwgProxy(content: string, generated: string): string {
  const config = load(content) as Record<string, any>
  const [node] = load(generated) as Array<Record<string, any>>
  const proxies = config.proxies ?? []
  const groups = config['proxy-groups'] ?? []
  const base = node.name
  let suffix = 2
  while ([...proxies, ...groups].some((p: any) => p.name === node.name)) node.name = `${base} (${suffix++})`
  proxies.push(node)
  let linked = false
  const original = section(content, 'proxy-groups')
  const starts = [...original.matchAll(/^  - name:.*(?:\r?\n|$)/gm)]
  if (starts.length !== groups.length) throw new Error('Для импорта AWG нужны группы YAML в формате панели: «  - name: …»')
  let updated = original
  for (let index = starts.length - 1; index >= 0; index--) {
    const group = groups[index]
    if (group.type !== 'select' || group.hidden || /^xkeen-device-|без\s*(vpn|впн)|block|блок/i.test(group.name)) continue
    group.proxies = [...new Set([...(group.proxies ?? []), node.name])]
    const start = starts[index].index!
    const end = starts[index + 1]?.index ?? original.length
    const block = original.slice(start, end)
    // Keep device-management boundaries in their original position.
    const marker = /^  # xkeen-/m.exec(block)
    const replaceEnd = marker ? start + marker.index : end
    const replacement = dump({ 'proxy-groups': [group] }, { lineWidth: -1, noRefs: true }).replace(/^proxy-groups:\n/, '')
    updated = updated.slice(0, start) + replacement + updated.slice(replaceEnd)
    linked = true
  }
  if (!linked) throw new Error('В конфигурации нет группы select для выбора AWG')
  return replaceSection(replaceSection(content, 'proxies', dump({ proxies }, { lineWidth: -1, noRefs: true })), 'proxy-groups', updated)
}

function isNoVpn(name: string): boolean { return /без\s*(?:vpn|впн)/i.test(name) }

export interface MihomoProvider { name: string; url: string }

function providerSection(content: string): { start: number; end: number; body: string } {
  const header = /^proxy-providers:\s*\r?\n/m.exec(content)
  if (!header || header.index === undefined) throw new Error('В config.yaml нет раздела proxy-providers')
  const start = header.index + header[0].length
  const next = /^[A-Za-z][\w-]*:/m.exec(content.slice(start))
  const end = next ? start + next.index : content.length
  return { start, end, body: content.slice(start, end) }
}

export function listMihomoProviders(content: string): MihomoProvider[] {
  const { body } = providerSection(content)
  const matches = [...body.matchAll(/^  ([\w-]+):\s*\r?\n/gm)]
  return matches.flatMap((match, index) => {
    const block = body.slice(match.index!, index + 1 < matches.length ? matches[index + 1].index : body.length)
    if (!/^    type:\s*http\s*$/m.test(block)) return []
    const raw = /^    url:\s*(.+?)\s*$/m.exec(block)?.[1]
    if (!raw) return []
    let url = raw
    try { url = JSON.parse(raw) as string } catch { url = raw.replace(/^['"]|['"]$/g, '') }
    return [{ name: match[1], url }]
  })
}

export function addMihomoProvider(content: string, name: string, url: string): string {
  if (!/^[a-z][a-z0-9_-]{0,31}$/i.test(name)) throw new Error('Имя подписки: латинские буквы, цифры, _ или -')
  if (listMihomoProviders(content).some((entry) => entry.name === name)) throw new Error('Подписка с таким именем уже есть')
  const section = providerSection(content)
  const block = `  ${name}:\n    type: http\n    url: ${JSON.stringify(url)}\n    path: ./proxy_providers/${name}.yaml\n    interval: 3600\n    health-check:\n      enable: true\n      url: https://www.gstatic.com/generate_204\n      interval: 300\n`
  const inserted = content.slice(0, section.end) + (section.body.endsWith('\n') ? '' : '\n') + block + content.slice(section.end)
  return linkProviderToVpn(inserted, `  ${name}:\n`)
}

export function removeMihomoProvider(content: string, name: string): string {
  const section = providerSection(content)
  const matches = [...section.body.matchAll(/^  ([\w-]+):\s*\r?\n/gm)]
  const at = matches.findIndex((match) => match[1] === name)
  if (at < 0) throw new Error('Подписка не найдена')
  const from = matches[at].index!
  const to = at + 1 < matches.length ? matches[at + 1].index! : section.body.length
  const removed = content.slice(0, section.start + from) + content.slice(section.start + to)
  const withoutReferences = removed.replace(new RegExp(`^      - ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\r?\\n`, 'gm'), '')
  const groupsHeader = /^proxy-groups:\s*\r?\n/m.exec(withoutReferences)
  if (!groupsHeader || groupsHeader.index === undefined) return withoutReferences
  const start = groupsHeader.index + groupsHeader[0].length
  const next = /^[A-Za-z][\w-]*:/m.exec(withoutReferences.slice(start))
  const end = next ? start + next.index : withoutReferences.length
  const body = withoutReferences.slice(start, end)
  const starts = [...body.matchAll(/^  - name:[^\r\n]+\r?\n/gm)]
  let groups = body.slice(0, starts[0]?.index ?? body.length)
  for (let index = 0; index < starts.length; index++) {
    let block = body.slice(starts[index].index!, index + 1 < starts.length ? starts[index + 1].index : body.length)
    if (/^    use:[ \t]*\r?\n/m.test(block) && !/^    use:[ \t]*\r?\n      - /m.test(block)) {
      block = /^    proxies:/m.test(block) ? block.replace(/^    use:[ \t]*\r?\n/m, '') : block.replace(/^    use:[ \t]*\r?\n/m, '    proxies: [DIRECT]\n')
    }
    groups += block
  }
  return withoutReferences.slice(0, start) + groups + withoutReferences.slice(end)
}

export function linkProviderToVpn(content: string, providerYaml: string): string {
  const provider = providerYaml.match(/^\s{2}([^:\n]+):\s*$/m)?.[1]?.trim()
  if (!provider || !/^[\w-]+$/.test(provider)) return content
  const marker = /^proxy-groups:\s*$/m.exec(content)
  if (!marker || marker.index === undefined) return content
  const start = marker.index + marker[0].length
  const next = /^[A-Za-z][\w-]*:/m.exec(content.slice(start))
  const end = next?.index === undefined ? content.length : start + next.index
  const section = content.slice(start, end)
  const starts = [...section.matchAll(/^  - name:\s*(.+?)\s*$/gm)]
  if (starts.length === 0) return content
  const hasCsqtt = /^  - name:\s*['"]?CSQTT['"]?\s*$/m.test(content)
  let updated = ''
  let offset = 0
  for (let index = 0; index < starts.length; index++) {
    const groupStart = starts[index].index ?? 0
    const groupEnd = index + 1 < starts.length ? starts[index + 1].index ?? section.length : section.length
    updated += section.slice(offset, groupStart)
    let block = section.slice(groupStart, groupEnd)
    const name = starts[index][1].trim().replace(/^['"]|['"]$/g, '')
    const isSelectable = (/^    type:\s*select\s*$/m.test(block) || (/fallback\s*vless/i.test(name) && /^    type:\s*fallback\s*$/m.test(block))) && !isNoVpn(name) && !/блок|block/i.test(name)
    if (isSelectable) {
      if (!new RegExp(`^      - ${provider}$`, 'm').test(block)) {
        if (/^    use:\s*$/m.test(block)) block = block.replace(/^    use:\s*$/m, `    use:\n      - ${provider}`)
        else block = block.replace(/^(  - name:[^\r\n]*\r?\n)/, `$1    use:\n      - ${provider}\n`)
      }
      if (hasCsqtt && name !== 'VPN' && name !== 'Селектор' && !/^      - CSQTT\s*$/m.test(block)) {
        block = block.replace(/^(    proxies:\s*\r?\n)/m, '$1      - CSQTT\n')
      }
    }
    updated += block
    offset = groupEnd
  }
  updated += section.slice(offset)
  return content.slice(0, start) + updated + content.slice(end)
}

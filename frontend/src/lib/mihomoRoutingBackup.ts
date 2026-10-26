import * as yaml from 'js-yaml'

const keys = ['rules', 'proxy-groups', 'rule-providers', 'sub-rules'] as const
export function section(content: string, key: string): string {
  const match = new RegExp(`^${key}:[^\\n]*(?:\\n|$)`, 'm').exec(content)
  if (!match) return ''
  const tail = content.slice(match.index + match[0].length)
  const next = /^[A-Za-z][\w-]*:/m.exec(tail)
  return content.slice(match.index, next ? match.index + match[0].length + next.index : content.length)
}
export function replaceSection(content: string, key: string, value: string): string {
  const old = section(content, key)
  return old ? content.replace(old, value) : `${content.trimEnd()}\n${value}`
}
export function readSelections(content: string): Record<string, string> {
  try {
    const value = JSON.parse(decodeURIComponent(/^# xkeen-ui-selections (\S+)$/m.exec(content)?.[1] ?? '%7B%7D'))
    return value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}
  } catch { return {} }
}

/** Restore surviving selections without treating removed groups/nodes as a failed core start. */
export function resolveSelections(saved: Record<string, string>, live: Record<string, {all?: string[]}>, aliases: Record<string, string>) {
  const selections: Record<string, string> = {}
  const skipped: string[] = []
  for (const [oldGroup, oldNode] of Object.entries(saved)) {
    const candidates = Object.keys(live).filter(name => name.toLowerCase() === oldGroup.toLowerCase())
    const group = live[oldGroup]?.all ? oldGroup : live[aliases[oldGroup]]?.all ? aliases[oldGroup] : candidates.length === 1 ? candidates[0] : ''
    const choices = live[group]?.all ?? []
    const nodes = choices.filter(name => name.trim() === oldNode.trim())
    const node = choices.includes(oldNode) ? oldNode : nodes.length === 1 ? nodes[0] : ''
    if (!group || !node) { skipped.push(oldGroup); continue }
    // An explicit entry for the current name takes precedence over an old alias.
    if (!(group in selections) || group === oldGroup) selections[group] = node
  }
  return { selections, skipped }
}
export function withSelections(content: string, choices: Record<string, string>): string {
  const clean = content.replace(/^# xkeen-ui-selections [^\n]*\n?/gm, '')
  return `# xkeen-ui-selections ${encodeURIComponent(JSON.stringify(choices))}\n${clean}`
}
export function exportMihomoRouting(content: string, selections: Record<string, string>) {
  return { format: 'xkeen-mihomo-routing', version: 1, sections: Object.fromEntries(keys.map(key => [key, section(content, key)])), selections }
}
export function importMihomoRouting(content: string, value: any): string {
  if (value?.format !== 'xkeen-mihomo-routing' || value.version !== 1 || !value.sections || typeof value.sections.rules !== 'string' || typeof value.sections['proxy-groups'] !== 'string') throw new Error('Нужен файл маршрутов Mihomo')
  let result = content
  for (const key of keys) {
    const part = value.sections[key] ?? ''
    if (typeof part !== 'string') throw new Error('Некорректный раздел маршрутов')
    if (part) {
      const parsed = yaml.load(part) as Record<string, unknown>
      if (!parsed || Object.keys(parsed).some(name => name !== key)) throw new Error('В файле есть посторонние разделы')
    }
    result = replaceSection(result, key, part)
  }
  const choices = value.selections ?? {}
  if (typeof choices !== 'object' || Array.isArray(choices) || Object.values(choices).some(v => typeof v !== 'string')) throw new Error('Некорректный выбор подключений')
  return withSelections(result, choices)
}

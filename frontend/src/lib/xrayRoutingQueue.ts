import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser'
import { baseRuleTag, normalizeDevicePriority, type RoutingRule } from './xrayDeviceRouting'

export function rebaseXrayRouting(previous: string, desired: string, latest: string): string {
  const before: RoutingRule[] = parseJsonc(previous)?.routing?.rules
  const after: RoutingRule[] = parseJsonc(desired)?.routing?.rules
  const current: RoutingRule[] = parseJsonc(latest)?.routing?.rules
  if (![before, after, current].every(Array.isArray)) throw new Error('Не удалось обновить правила маршрутизации')
  const key = (rule: RoutingRule, index: number) => rule.ruleTag ? baseRuleTag(rule).replace(/^disabled:/, '') : `unmanaged:${index}`
  const map = (rules: RoutingRule[]) => new Map(rules.map((rule, index) => [key(rule, index), rule]))
  const oldMap = map(before), nextMap = map(after), liveMap = map(current)
  if (oldMap.size !== before.length || nextMap.size !== after.length || liveMap.size !== current.length) throw new Error('Обновите правила: повторяются теги')
  const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  for (const name of new Set([...oldMap.keys(), ...nextMap.keys()])) {
    const old = oldMap.get(name), wanted = nextMap.get(name), live = liveMap.get(name)
    if (equal(old, wanted)) continue
    if (!equal(live, old) && !equal(live, wanted)) throw new Error('Это правило изменено в другом окне. Актуальная конфигурация загружена; повторите изменение')
    if (wanted) liveMap.set(name, wanted)
    else liveMap.delete(name)
  }
  return applyEdits(latest, modify(latest, ['routing', 'rules'], normalizeDevicePriority([...liveMap.values()]), { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
}

// Keep edits visible immediately, but send full configurations in order. Edits
// made during one request are combined into the next snapshot.
export function createXrayRoutingQueue(options: {
  initial: string
  send: (previous: string, content: string) => Promise<string | void>
  rebase?: (previous: string, content: string, latest: string) => string
  onState: (content: string, pending: boolean) => void
  onCommit: (content: string) => void
  onError: (error: unknown) => void
}) {
  let confirmed = options.initial
  let projected = confirmed
  let running = false
  let waiters: Array<(success: boolean) => void> = []

  async function drain() {
    if (running) return
    running = true
    try {
      while (waiters.length) {
        const content = projected
        const batch = waiters
        waiters = []
        try {
          if (content !== confirmed) {
            const applied = await options.send(confirmed, content) || content
            confirmed = applied
            options.onCommit(applied)
            projected = projected === content ? applied : options.rebase ? options.rebase(content, projected, applied) : projected
          }
          batch.forEach(resolve => resolve(true))
        } catch (error) {
          batch.forEach(resolve => resolve(false))
          waiters.forEach(resolve => resolve(false))
          waiters = []
          projected = confirmed
          options.onState(confirmed, false)
          options.onError(error)
          return
        }
      }
    } finally {
      running = false
      options.onState(projected, false)
    }
  }

  return {
    isPending: () => running || waiters.length > 0,
    edit(transform: (content: string) => string): Promise<boolean> {
      // A throwing transform must leave both the queue and its preview intact.
      const content = transform(projected)
      projected = content
      options.onState(projected, true)
      const result = new Promise<boolean>(resolve => waiters.push(resolve))
      queueMicrotask(() => void drain())
      return result
    },
  }
}

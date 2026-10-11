// Keep edits visible immediately, but send full configurations in order. Edits
// made during one request are combined into the next snapshot.
export function createXrayRoutingQueue(options: {
  initial: string
  send: (previous: string, content: string) => Promise<void>
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
            await options.send(confirmed, content)
            confirmed = content
            options.onCommit(content)
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

import { useRef, useState } from 'react'
import { apiCall } from '@/lib/api'

export function useOutboundLatency() {
  const [latencies, setLatencies] = useState<Record<string, { ms?: number; error?: string }>>({})
  const [pingPending, setPingPending] = useState<string | null>(null)
  const queue = useRef<Promise<void>>(Promise.resolve())

  async function perform(tag: string) {
    setPingPending(tag)
    try {
      const result = await apiCall<{ success: boolean; latencyMs?: number; error?: string }>('POST', 'xray/latency', { tag })
      setLatencies(current => ({ ...current, [tag]: result.success && result.latencyMs !== undefined ? { ms: result.latencyMs } : { error: result.error || 'Нет ответа' } }))
    } catch (error) {
      setLatencies(current => ({ ...current, [tag]: { error: error instanceof Error ? error.message : 'Нет ответа' } }))
    } finally {
      setPingPending(null)
    }
  }

  function ping(tag: string): Promise<void> {
    const task = queue.current.then(() => perform(tag))
    queue.current = task.catch(() => {})
    return task
  }
  return { latencies, pingPending, ping }
}

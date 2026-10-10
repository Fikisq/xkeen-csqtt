import { useState } from 'react'
import { apiCall } from '@/lib/api'

export function useOutboundLatency() {
  const [latencies, setLatencies] = useState<Record<string, { ms?: number; error?: string }>>({})
  const [pingPending, setPingPending] = useState<string | null>(null)

  async function ping(tag: string) {
    if (pingPending) return
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

  return { latencies, pingPending, ping }
}

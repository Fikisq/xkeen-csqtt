interface CoreStatus {
  success: boolean
  currentCore: string
  running: boolean
  cores: string[]
}

/** Observe the service independently of the long-running switch request. */
export function monitorCoreSwitch(
  target: string,
  readStatus: () => Promise<CoreStatus>,
  publish: (status: CoreStatus) => Promise<void>,
  intervalMs = 1000,
) {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let published = false
  const tick = async () => {
    try {
      const status = await readStatus()
      if (!stopped && !published && status.success && status.currentCore === target && status.running) {
        await publish(status)
        published = true
      }
    } catch { /* A dropped connection during firewall changes is retried. */ }
    if (!stopped && !published) timer = setTimeout(() => void tick(), intervalMs)
  }
  void tick()
  return () => { stopped = true; clearTimeout(timer) }
}

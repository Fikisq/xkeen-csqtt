import type { ComponentType, ReactNode } from 'react'
import { Component, lazy, useEffect, useState } from 'react'
import { showToast } from './store'

export function lazyLoad<T extends ComponentType<any>>(factory: () => Promise<Record<string, T>>, name: string) {
  return lazy(() => factory().then((m) => ({ default: m[name] })).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (/dynamically imported module|failed to fetch|loading chunk|importing a module script/i.test(message)) {
      try {
        const key = 'xkeen-ui-chunk-reload'
        const lastReload = Number(sessionStorage.getItem(key) || 0)
        if (Date.now() - lastReload > 60 * 60 * 1000) {
          sessionStorage.setItem(key, String(Date.now()))
          window.location.reload()
        }
      } catch {
        // The error boundary below still offers a manual reload.
      }
    }
    throw error
  }))
}

class ChunkErrorBoundary extends Component<{ children: ReactNode }, { message: string | null }> {
  state: { message: string | null } = { message: null }
  static getDerivedStateFromError(error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    return { message: /dynamically imported module|failed to fetch|loading chunk|importing a module script/i.test(detail)
      ? 'Не удалось загрузить модуль. Обновите страницу.'
      : 'Ошибка интерфейса. Обновите страницу.' }
  }
  componentDidCatch(error: unknown) {
    console.error('XKeen UI component error:', error)
    showToast(this.state.message ?? 'Ошибка интерфейса', 'error')
  }
  render() {
    return this.state.message
      ? <div role="alert" className="flex items-center gap-3 text-sm"><span>{this.state.message}</span><button type="button" onClick={() => window.location.reload()}>Обновить страницу</button></div>
      : this.props.children
  }
}

export function LazyBoundary({ children }: { children: ReactNode }) {
  return <ChunkErrorBoundary>{children}</ChunkErrorBoundary>
}

export function useLazyMount(open: boolean, delay = 200) {
  const [mounted, setMounted] = useState(open)
  if (open && !mounted) setMounted(true)
  useEffect(() => {
    if (open) return
    const timer = setTimeout(() => setMounted(false), delay)
    return () => clearTimeout(timer)
  }, [open, delay])
  return mounted
}

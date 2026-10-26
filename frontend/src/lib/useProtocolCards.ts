import { useEffect, useRef, useState } from 'react'

export function useProtocolCards(names: string[], active: string | undefined, storageKey: string) {
  const gridRef = useRef<HTMLDivElement>(null)
  const [columns, setColumns] = useState(2)
  const [pinned, setPinned] = useState<string[] | null>(() => {
    try { const value = JSON.parse(localStorage.getItem(storageKey) ?? 'null'); return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : null } catch { return null }
  })
  useEffect(() => {
    const grid = gridRef.current
    if (!grid) return
    const update = () => setColumns(Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length))
    update(); const observer = new ResizeObserver(update); observer.observe(grid)
    return () => observer.disconnect()
  }, [names.length])
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(pinned)) } catch { /* Optional browser preference. */ } }, [pinned, storageKey])
  const limit = columns * 3
  const visible = (pinned === null ? names : names.filter(name => pinned.includes(name))).slice(0, limit)
  if (active && names.includes(active) && !visible.includes(active)) visible.splice(Math.max(0, limit - 1), 1, active)
  return { gridRef, limit, visible, toggle: (name: string) => setPinned(visible.includes(name) ? visible.filter(item => item !== name) : [...visible, name].slice(0, limit)) }
}

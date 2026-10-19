import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { IconTerminal2, IconRefresh, IconEraser, IconPlayerStop } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ConsoleManagement } from './ConsoleManagement'

export function EntwareTerminal({ onClose }: { onClose: () => void }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const terminal = useRef<Terminal | null>(null)
  const socket = useRef<WebSocket | null>(null)
  const [phase, setPhase] = useState<'connecting' | 'connected' | 'closed' | 'error'>('connecting')
  const [attempt, setAttempt] = useState(0)
  const [message, setMessage] = useState('Подключение…')

  useEffect(() => {
    // Dialog portals can mount after this component's first effect.
    // A callback ref starts the connection as soon as its real host appears.
    if (!host) return
    let active = true
    let failed = false
    let frame = 0
    let lastSize = ''
    setPhase('connecting'); setMessage('Подключение…')
    const term = new Terminal({
      cursorBlink: true, cursorStyle: 'bar', fontSize: 13, scrollback: 1500,
      fontFamily: "'JetBrains Mono Variable', Consolas, monospace",
      theme: {
        background: '#080f1e', foreground: '#dbe4f3', cursor: '#60a5fa', selectionBackground: '#31568a80',
        black: '#1e293b', red: '#f87171', green: '#4ade80', yellow: '#facc15', blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#cbd5e1',
        brightBlack: '#64748b', brightRed: '#fca5a5', brightGreen: '#86efac', brightYellow: '#fde68a', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#67e8f9', brightWhite: '#f8fafc',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    terminal.current = term
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/terminal/ws`)
    ws.binaryType = 'arraybuffer'
    socket.current = ws
    const send = (value: object) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)) }
    const resize = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (!active || host.clientWidth < 40 || host.clientHeight < 40) return
        fit.fit()
        const size = `${term.cols}:${term.rows}`
        if (size !== lastSize && ws.readyState === WebSocket.OPEN) {
          lastSize = size; send({ type: 'resize', rows: term.rows, cols: term.cols })
        }
      })
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    resize()
    const input = term.onData(data => send({ type: 'input', data }))
    ws.onopen = () => { if (!active) return; setPhase('connected'); setMessage('Entware · root · /opt'); resize(); term.focus() }
    ws.onmessage = event => {
      if (!active) return
      if (typeof event.data === 'string' && event.data === '{"type":"clear"}') { term.reset(); return }
      term.write(event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : String(event.data))
    }
    ws.onerror = () => { if (active) { failed = true; setPhase('error'); setMessage('Не удалось подключиться. Проверьте вход в панель и закройте консоль в другой вкладке.') } }
    ws.onclose = () => { if (active) { if (!failed) { setPhase('closed'); setMessage('Соединение закрыто — можно подключиться к сохранённому сеансу') }; term.write('\r\n\x1b[90m[Соединение закрыто]\x1b[0m\r\n') } }
    return () => {
      active = false; cancelAnimationFrame(frame); observer.disconnect(); input.dispose()
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
      ws.close(); if (socket.current === ws) socket.current = null
      terminal.current = null; term.dispose()
    }
  }, [host, attempt])

  const connected = phase === 'connected'
  function input(data: string) {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: 'input', data }))
    terminal.current?.focus()
  }
  function manage(action: string, component: string) {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: 'manage', action, component }))
    terminal.current?.focus()
  }
  function clear() {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: 'clear' }))
    terminal.current?.focus()
  }

  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent className="flex! h-[94dvh] max-w-[min(98vw,1440px)]! max-h-[94dvh] flex-col gap-3 overflow-hidden p-4">
      <DialogHeader className="shrink-0 pr-8">
        <DialogTitle className="flex items-center gap-2"><IconTerminal2 className="size-5 text-chart-2" />Консоль Entware</DialogTitle>
        <DialogDescription>Entware от root. Сеанс и вывод сохраняются после закрытия окна.</DialogDescription>
      </DialogHeader>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 text-xs">
        <span role="status" className="text-muted-foreground flex items-center gap-2"><span className={`size-1.5 shrink-0 rounded-full ${connected ? 'bg-green-400' : phase === 'connecting' ? 'animate-pulse bg-amber-400' : 'bg-red-400'}`} />{message}</span>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" disabled={!connected} onClick={() => input('\x03')}><IconPlayerStop className="size-3.5" />Прервать</Button>
          <Button size="sm" variant="ghost" disabled={!connected} onClick={clear}><IconEraser className="size-3.5" />Очистить терминал</Button>
          {(phase === 'closed' || phase === 'error') && <Button size="sm" variant="outline" onClick={() => setAttempt(value => value + 1)}><IconRefresh className="size-3.5" />Переподключиться</Button>}
        </div>
      </div>
      <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_260px] lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden">
        <div ref={setHost} className="h-[52dvh] min-h-56 min-w-0 overflow-hidden rounded-lg border bg-[#080f1e] p-2 lg:h-full lg:min-h-0" />
        <ConsoleManagement connected={connected} onAction={manage} />
      </div>
    </DialogContent>
  </Dialog>
}

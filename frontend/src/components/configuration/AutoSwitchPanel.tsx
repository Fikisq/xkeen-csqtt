import { useEffect, useState } from 'react'
import {
  IconShieldCheck,
  IconWorld,
  IconRefresh,
  IconCheck,
  IconX,
  IconArrowBackUp,
  IconPlus,
  IconTrash,
  IconPower,
} from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { apiCall } from '@/lib/api'
import { useAppActions } from '@/lib/store'
import { cn } from '@/lib/utils'

type Settings = { enabled: boolean; target: 'csqtt' | 'wdtt-plus'; intervalSeconds: number; foreignUrls: string[]; whitelistUrls: string[] }
type Probe = { url: string; ok: boolean; code: number; ms: number }
type Data = {
  success: boolean
  error?: string
  settings: Settings
  core: string
  fallbackActive: boolean
  snapshotError?: string
  status: {
    phase?: string
    lastChecked?: number
    failures?: number
    recoveries?: number
    error?: string
    foreign?: Probe[]
    whitelist?: Probe[]
    reserve?: Probe[]
    dryRun?: boolean
  }
}
const phases: Record<string, string> = {
  waiting: 'Ожидание',
  disabled: 'Выключено',
  monitoring: 'Обычный доступ',
  suspected: 'Возможен режим белых списков',
  fallback: 'Резерв активен',
  uncertain: 'Доступ нестабилен',
  error: 'Нужна проверка',
}
const host = (url: string) => {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}
const time = (value?: number) =>
  value
    ? new Date(value * 1000)
        .toLocaleString('ru-RU', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
        .replace(',', '')
    : 'Ещё не проверяли'

function ProbeRows({ urls, rows }: { urls: string[]; rows?: Probe[] }) {
  return (
    <div className="space-y-1.5">
      {urls.map((url) => {
        const result = rows?.find((row) => row.url === url)
        return (
          <div key={url} className="bg-background/60 border-border/60 flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              {result && <span
                className={cn(
                  'flex size-6 shrink-0 items-center justify-center rounded-full',
                  result.ok
                      ? 'bg-emerald-500/10 text-emerald-500'
                      : 'bg-destructive/10 text-destructive',
                )}
              >
                {result.ok ? <IconCheck size={15} /> : <IconX size={15} />}
              </span>}
              <span className="truncate text-base font-medium" title={url}>
                {host(url)}
              </span>
            </div>
            <span
              className={cn(
                'shrink-0 text-ui tabular-nums',
                !result ? 'text-muted-foreground' : result.ok ? 'text-emerald-500' : 'text-destructive',
              )}
            >
              {!result ? 'Ожидание' : result.ok ? `${result.ms} мс` : result.code ? `HTTP ${result.code}` : 'Нет ответа'}
            </span>
          </div>
        )
      })}
    </div>
  )
}

export function AutoSwitchPanel() {
  const { showToast } = useAppActions()
  const [data, setData] = useState<Data | null>(null)
  const [draft, setDraft] = useState<Settings | null>(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState('')
  const [showDomains, setShowDomains] = useState(false)
  const [customInterval, setCustomInterval] = useState(false)
  const [customHours, setCustomHours] = useState('1')
  const [loadError, setLoadError] = useState('')
  const refresh = async (reset = false) => {
    const result = await apiCall<Data>('GET', 'autoswitch', undefined, { timeoutMs: 6000 })
    if (!result.success) throw new Error(result.error || 'Не удалось прочитать настройки')
    setData(result)
    setLoadError('')
    if (reset) {
      setDraft(result.settings)
      setDirty(false)
    }
  }
  useEffect(() => {
    let live = true
    const poll = async (initial = false) => {
      try {
        const result = await apiCall<Data>('GET', 'autoswitch', undefined, { timeoutMs: 6000 })
        if (!live) return
        if (!result.success) throw new Error(result.error || 'Не удалось получить состояние')
        setData(result)
        setLoadError('')
        if (initial) {
          setDraft(result.settings)
        }
      } catch (e) {
        if (live) setLoadError(e instanceof Error ? e.message : 'Нет связи с панелью')
      }
    }
    void poll(true)
    const timer = setInterval(() => void poll(), 5000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [])
  const edit = (patch: Partial<Settings>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current))
    setDirty(true)
  }
  const act = async (action: 'save' | 'check' | 'restore', enabled?: boolean) => {
    if (!draft) return
    if (action === 'save' && customInterval && (!Number.isInteger(Number(customHours)) || Number(customHours) < 1 || Number(customHours) > 744)) { showToast('Введите целое число часов от 1 до 744', 'error'); return }
    setBusy(action)
    try {
      const result = await apiCall<{ success: boolean; error?: string }>(
        action === 'save' ? 'PUT' : 'POST',
        action === 'save' ? 'autoswitch' : `autoswitch/${action}`,
        action === 'save' ? { ...draft, enabled: enabled ?? draft.enabled } : {},
        { timeoutMs: action === 'save' ? 120000 : 90000 },
      )
      if (!result.success) throw new Error(result.error || 'Не удалось выполнить действие')
      await refresh(action === 'save')
      showToast(
        action === 'save'
          ? 'Настройки автопереключения сохранены'
          : action === 'restore'
            ? 'Прежние маршруты восстановлены'
            : 'Проверка завершена. Маршруты не изменялись',
      )
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Ошибка автопереключения', 'error')
    } finally {
      setBusy('')
    }
  }
  if (!draft || !data) return <div className="text-muted-foreground px-1 py-5 text-sm">{loadError || 'Загрузка автопереключения…'}</div>
  const active = data.fallbackActive
  const phase =
    !data.settings.enabled && !active
      ? 'disabled'
      : loadError || data.status.error || data.snapshotError
        ? 'error'
        : active
          ? 'fallback'
          : !data.status.lastChecked
            ? 'waiting'
            : data.status.phase || 'monitoring'
  const statusTone =
    phase === 'disabled'
      ? 'bg-muted text-muted-foreground'
      : phase === 'monitoring'
        ? 'bg-emerald-500/10 text-emerald-500'
        : phase === 'error'
          ? 'bg-destructive/10 text-destructive'
          : 'bg-amber-500/10 text-amber-500'
  const card = 'bg-background/40 border-border/70 rounded-xl border p-4'
  const input =
    'bg-input-background border-input h-ui-control min-w-0 w-full rounded-lg border px-3 text-ui font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50'
  const intervals = [60, 300, 900, 1800]
  const custom = customInterval || (!intervals.includes(draft.intervalSeconds) && draft.intervalSeconds % 3600 === 0)
  return <div className="space-y-4 pt-2 text-ui">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-ui-title font-semibold">Автопереключение</h2>
      {(data.settings.enabled || active || phase==='error') && <span className={cn('inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-ui', statusTone)}><span className="size-1.5 rounded-full bg-current" />{phases[phase]}</span>}
    </header>
    {(loadError || data.status.error || data.snapshotError) && <p role="alert" className="text-destructive rounded-lg border border-destructive/25 p-3">{loadError || data.snapshotError || data.status.error}</p>}
    <section className={cn(card, 'grid grid-cols-1 items-end gap-x-6 gap-y-4 md:grid-cols-[minmax(0,1fr)_200px_minmax(0,1fr)]')}>
      <label className="w-full space-y-1.5 md:max-w-[520px] md:justify-self-center md:col-start-1 md:row-start-1"><span className="font-medium">Резерв</span><select className={input} value={draft.target} disabled={!!busy || active} onChange={e => edit({target:e.target.value as Settings['target']})}><option value="csqtt">CSQTT</option><option value="wdtt-plus">WDTT Plus</option></select></label>
      <label className="w-full space-y-1.5 md:max-w-[520px] md:justify-self-center md:col-start-1 md:row-start-2"><span className="font-medium">Интервал</span><span className="flex items-center gap-2"><select className={input} value={custom ? 'custom' : draft.intervalSeconds} disabled={!!busy} onChange={e => {const own=e.target.value==='custom';setCustomInterval(own);if(own){const hours=draft.intervalSeconds%3600===0?draft.intervalSeconds/3600:1;setCustomHours(String(hours));edit({intervalSeconds:hours*3600})}else edit({intervalSeconds:Number(e.target.value)})}}>{!custom && !intervals.includes(draft.intervalSeconds) && <option value={draft.intervalSeconds}>Текущий: {draft.intervalSeconds} сек.</option>}{intervals.map(value => <option key={value} value={value}>{value/60} мин.</option>)}<option value="custom">Свой</option></select>{custom && <><input type="number" min={1} max={744} step={1} aria-label="Интервал в целых часах" className={cn(input,'max-w-24')} value={customInterval?customHours:draft.intervalSeconds/3600} disabled={!!busy} onChange={e => {setCustomInterval(true);setCustomHours(e.target.value);const hours=Number(e.target.value);if(Number.isInteger(hours)&&hours>=1&&hours<=744)edit({intervalSeconds:hours*3600})}} /><span>ч</span></>}</span></label>
      <div className="order-first flex items-center justify-center py-3 md:order-none md:col-start-2 md:row-span-2 md:row-start-1 md:self-center">
        <button type="button" className={cn('flex size-40 flex-col items-center justify-center gap-3 rounded-full border-2 text-base font-medium transition-colors disabled:opacity-50',data.settings.enabled?'border-emerald-500/70 bg-emerald-500/10 text-emerald-400':'border-primary/70 bg-primary/15 text-blue-300')} disabled={!!busy} aria-label={data.settings.enabled?'Выключить автопереключение':'Включить автопереключение'} aria-pressed={data.settings.enabled} onClick={() => void act('save',!data.settings.enabled)}><IconPower size={42} />{busy==='save'?'Применяем…':data.settings.enabled?'Выключить':'Включить'}</button>
      </div>
      <Button className="w-full md:max-w-[520px] md:justify-self-center md:col-start-3 md:row-start-1" disabled={!!busy || dirty} title="Проверить WAN без изменения маршрутов" onClick={() => void act('check')}><IconRefresh size={16} className={cn(busy==='check'&&'animate-spin')} />{busy==='check'?'Проверяем…':'Проверить'}</Button>
      <Button variant="outline" className="w-full md:max-w-[520px] md:justify-self-center md:col-start-3 md:row-start-2" aria-expanded={showDomains} aria-controls="autoswitch-domains" onClick={() => setShowDomains(value=>!value)}><IconWorld size={16} />Домены проверки</Button>
    </section>
    {dirty && <div className="flex items-center gap-2"><Button disabled={!!busy} onClick={() => void act('save')}>Сохранить</Button><Button variant="ghost" disabled={!!busy} onClick={() => {setCustomInterval(false);void refresh(true)}}>Отменить</Button></div>}
    <section id="autoswitch-domains" hidden={!showDomains} className={card}>
            <div className="grid gap-4 sm:grid-cols-2">
              {(['foreignUrls', 'whitelistUrls'] as const).map((key) => (
                <fieldset key={key} className="min-w-0">
                  <legend className="mb-2 text-ui font-semibold">{key === 'foreignUrls' ? 'EU' : 'WHITELIST'}</legend>
                  <div className="space-y-2">
                    {draft[key].map((url, index) => (
                      <div key={index} className="flex items-center gap-1.5">
                        <input
                          aria-label={`${key === 'foreignUrls' ? 'EU' : 'WHITELIST'} ${index + 1}`}
                          className={cn(input,'h-11 text-base')}
                          value={url}
                          placeholder="https://example.com/"
                          spellCheck={false}
                          autoCapitalize="none"
                          disabled={!!busy}
                          onChange={(e) => edit({ [key]: draft[key].map((value, i) => (i === index ? e.target.value : value)) })}
                        />
                        {key === 'whitelistUrls' && draft[key].length > 1 && (
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`Удалить WHITELIST ${index + 1}`}
                            disabled={!!busy}
                            onClick={() => edit({ whitelistUrls: draft.whitelistUrls.filter((_, i) => i !== index) })}
                          >
                            <IconTrash size={17} />
                          </Button>
                        )}
                      </div>
                    ))}
                    {key === 'whitelistUrls' && draft.whitelistUrls.length < 6 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!!busy}
                        onClick={() => edit({ whitelistUrls: [...draft.whitelistUrls, ''] })}
                      >
                        <IconPlus size={16} /> Добавить домен
                      </Button>
                    )}
                  </div>
                </fieldset>
              ))}
            </div>

    </section>
    <div className="grid gap-4 lg:grid-cols-2">
      {(['foreignUrls','whitelistUrls'] as const).map((key) => <section key={key} className={card}><div className="mb-3 flex items-center justify-between"><h3 className="flex items-center gap-2 text-ui-section font-medium">{key==='foreignUrls'?<IconWorld size={17}/>:<IconShieldCheck size={17}/>}{key==='foreignUrls'?'EU':'WHITELIST'}</h3><span className="text-muted-foreground">{(key==='foreignUrls'?data.status.foreign:data.status.whitelist)?.filter(row=>row.ok).length??0} / {data.settings[key].length}</span></div><ProbeRows urls={data.settings[key]} rows={key==='foreignUrls'?data.status.foreign:data.status.whitelist}/></section>)}
    </div>
    <section className={card}><div className="mb-3 flex items-center justify-between gap-3"><h3 className="text-ui-section font-medium">Маршруты</h3>{active&&<Button size="sm" variant="outline" disabled={!!busy} onClick={()=>void act('restore')}><IconArrowBackUp size={16}/>Вернуть маршруты</Button>}</div><table className="w-full text-left"><thead className="text-muted-foreground"><tr>{['Правило','Обычно','При БС','Выход'].map(label=><th key={label} className="pb-2 font-normal">{label}</th>)}</tr></thead><tbody>{[['RU',true],['WHITELIST',false]].map(([name,enabled])=><tr key={String(name)} className="border-border border-t"><td className="py-3 font-medium">{name}</td><td className={enabled?'text-emerald-400':'text-rose-400'}>{enabled?'Вкл.':'Выкл.'}</td><td className={enabled?'text-rose-400':'text-emerald-400'}>{enabled?'Выкл.':'Вкл.'}</td><td>direct</td></tr>)}</tbody></table></section>
    <footer className="text-muted-foreground flex flex-wrap justify-between gap-2 text-xs"><span>{data.core==='xray'?'Xray':'Mihomo'} · {active?'резервный режим':'обычные маршруты'}</span><span>Последняя проверка: {time(data.status.lastChecked)}</span></footer>
  </div>
}

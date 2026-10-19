import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { SettingInfo } from '@/components/ui/setting-info'
import { apiCall } from '@/lib/api'

export interface ResourceConfiguration {
  success: boolean
  error?: string
  config: { selected: string[]; autoEnabled: boolean; intervalHours: number; custom: {id: string; name: string; url: string}[] }
  sites: { id: string; name: string; url: string }[]
  automatic?: { checkedAt?: string; message?: string; running?: boolean }
}
interface Probe { url: string; protocol: string; ok: boolean; status?: number; error?: string; errorStage?: string }
interface DnsRow { id: string; status: string; local: string[]; encrypted: string[]; localError?: string; encryptedError?: string }

function status(item?: Probe) {
  if (!item) return <span className="text-muted-foreground">—</span>
  return <span className={item.ok ? 'text-green-400' : 'text-red-400'} title={item.error}>
    {item.ok ? '✓' : '✕'} {item.status ? `HTTP ${item.status}` : item.errorStage === 'dns' ? 'Ошибка DNS' : /timeout|deadline/i.test(item.error || '') ? 'Тайм-аут' : 'Нет ответа'}
  </span>
}

export function NfqwsResources({ active, disabled, report, onSaved, onCheck }: {
  active: boolean; disabled: boolean; report?: { checkedAt?: string; results?: Probe[] } | null
  onSaved: (value: ResourceConfiguration) => void; onCheck: () => void
}) {
  const [value, setValue] = useState<ResourceConfiguration | null>(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dns, setDns] = useState<DnsRow[]>([])
  const [stamp, setStamp] = useState('')
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  useEffect(() => {
    if (!active || dirty) return
    let alive = true
    apiCall<ResourceConfiguration>('GET','nfqws2/resources').then(result => {
      if (!result.success) throw new Error(result.error || 'Не удалось загрузить ресурсы')
      if (alive) setValue(result)
    }).catch(cause => { if (alive) setError(String(cause)) })
    return () => { alive = false }
  }, [active, dirty, disabled])

  const update = (config: ResourceConfiguration['config']) => {
    if (value) setValue({ ...value, config, sites: [...value.sites.filter(site => ['youtube','discord','instagram'].includes(site.id)),...config.custom] })
    setDirty(true); setError('')
  }
  function addResource() {
    if (!value || !name.trim() || !address.trim()) return
    try {
      const url = new URL(address.includes('://') ? address.trim() : `https://${address.trim()}`)
      if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) throw new Error('Укажите домен или HTTPS-ссылку без порта и пароля')
      if (value.sites.some(site => site.id !== editing && site.url === url.href)) throw new Error('Этот адрес уже есть в таблице')
      const id = editing || `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`
      const resource = {id,name:name.trim(),url:url.href}
      const custom = editing ? value.config.custom.map(site => site.id === editing ? resource : site) : [...value.config.custom,resource]
      update({...value.config,custom,selected:value.config.selected.includes(id) ? value.config.selected : [...value.config.selected,id]})
      setEditing(null); setName(''); setAddress('')
    } catch (cause) { setError(String(cause)) }
  }
  async function save() {
    if (!value) return
    setBusy(true); setError('')
    try {
      const result = await apiCall<ResourceConfiguration>('POST','nfqws2/resources',value.config)
      if (!result.success) throw new Error(result.error || 'Не удалось сохранить ресурсы')
      setValue(result); setDirty(false); onSaved(result)
    } catch (cause) { setError(String(cause)) } finally { setBusy(false) }
  }
  async function diagnose() {
    setBusy(true); setError('')
    try {
      const result = await apiCall<{success: boolean; error?: string; checkedAt: string; results: DnsRow[]}>('POST','nfqws2/resources/dns')
      if (!result.success) throw new Error(result.error || 'Проверка DNS не завершилась')
      setDns(result.results); setStamp(result.checkedAt)
    } catch (cause) { setError(String(cause)) } finally { setBusy(false) }
  }
  if (!value) return <p className="text-muted-foreground text-sm">{error || 'Загрузка ресурсов…'}</p>
  return <div className="space-y-3">
    <div className="overflow-x-auto rounded-lg border bg-background/30">
      <table className="w-full min-w-[500px] text-left text-sm">
        <thead className="bg-input-background"><tr>
          <th className="px-3 py-2 font-medium">Ресурс<SettingInfo label="Выбор ресурсов">Переключатели задают сайты для проверки и подбора. TCP должен работать у всех выбранных сайтов; для TCP + QUIC нужен хотя бы один ответ HTTP/3. Сохранение выбора не меняет работающую стратегию.</SettingInfo></th>
          <th className="px-3 py-2 font-medium">DNS<SettingInfo label="Диагностика DNS">Сравниваются IPv4-ответы системного DNS роутера и Cloudflare DoH. Разные адреса возможны из-за CDN и не доказывают подмену. Эта диагностика идёт по маршруту роутера, отдельно от проверки стратегии через WAN. Настройки DNS не меняются.</SettingInfo></th>
          <th className="px-3 py-2 font-medium">TCP / TLS</th><th className="px-3 py-2 font-medium">QUIC</th><th aria-label="Действия" />
        </tr></thead>
        <tbody>{value.sites.map(site => {
          const row = dns.find(item => item.id === site.id)
          const tcp = report?.results?.find(item => item.url === site.url && item.protocol === 'tcp')
          const quic = report?.results?.find(item => item.url === site.url && item.protocol === 'h3')
          return <tr key={site.id} className="border-t">
            <th className="px-3 py-2 font-medium"><label className="flex items-center gap-3" title={site.url}><Switch aria-label={`Проверять ${site.name}`} checked={value.config.selected.includes(site.id)} disabled={disabled || busy} onCheckedChange={checked => update({ ...value.config, selected: checked ? [...value.config.selected,site.id] : value.config.selected.filter(id => id !== site.id) })} />{site.name}</label></th>
            <td className="px-3 py-2">
              {row ? <details><summary className={`cursor-pointer ${row.status === 'resolved' ? 'text-green-400' : 'text-yellow-400'}`}>
                {row.status === 'resolved' ? '✓ Ответ есть' : row.status === 'different' ? 'Адреса различаются' : row.status === 'local-failure' ? 'Нет локального ответа' : 'Не подтверждён'}
              </summary><div className="mt-1 max-w-64 break-words text-xs text-muted-foreground">Роутер: {row.local.join(', ') || row.localError || 'Нет IPv4'}<br />DoH: {row.encrypted.join(', ') || row.encryptedError || 'Нет IPv4'}</div></details> : <span className="text-muted-foreground">{tcp?.errorStage === 'dns' ? '✕ Ошибка DNS' : '—'}</span>}
            </td>
            <td className="px-3 py-2">{status(tcp)}</td><td className="px-3 py-2">{status(quic)}</td>
            <td className="px-2 py-2">{value.config.custom.some(item => item.id === site.id) && <div className="flex gap-1">
              <Button size="sm" variant="ghost" disabled={disabled || busy} onClick={() => {setEditing(site.id);setName(site.name);setAddress(site.url)}}>Изменить</Button>
              <Button size="sm" variant="ghost" disabled={disabled || busy} onClick={() => {update({...value.config,custom:value.config.custom.filter(item => item.id !== site.id),selected:value.config.selected.filter(id => id !== site.id)});if (editing === site.id) {setEditing(null);setName('');setAddress('')}}}>Удалить</Button>
            </div>}</td>
          </tr>
        })}</tbody>
      </table>
    </div>
    <form className="flex flex-wrap items-center gap-2" onSubmit={event => {event.preventDefault();addResource()}}>
      <input aria-label="Название ресурса" placeholder="Название ресурса" maxLength={60} className="h-8 min-w-32 flex-1 rounded-md border bg-input-background px-2 text-sm" disabled={disabled || busy} value={name} onChange={event => setName(event.target.value)} />
      <input aria-label="Адрес ресурса" placeholder="Домен или https://…" maxLength={2048} className="h-8 min-w-48 flex-[2] rounded-md border bg-input-background px-2 text-sm" disabled={disabled || busy} value={address} onChange={event => setAddress(event.target.value)} />
      <Button type="submit" size="sm" variant="outline" disabled={disabled || busy || !name.trim() || !address.trim() || (!editing && value.config.custom.length >= 5)}>{editing ? 'Изменить ресурс' : 'Добавить ресурс'}</Button>
      {editing && <Button type="button" size="sm" variant="ghost" onClick={() => {setEditing(null);setName('');setAddress('')}}>Отмена</Button>}
      <SettingInfo label="Свои ресурсы">Можно добавить до пяти HTTPS-ресурсов, изменить адрес или удалить строку. Они участвуют в проверке после «Сохранить ресурсы». Тайм-аут не доказывает блокировку, а отсутствие HTTP/3 не мешает работе сайта по TCP.</SettingInfo>
    </form>
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" disabled={busy || disabled} onClick={() => void diagnose()}>{busy ? 'Подождите…' : 'Проверить DNS'}</Button>
      <Button size="sm" variant="outline" disabled={busy || disabled || dirty} onClick={onCheck}>Проверить стратегию</Button>
      {stamp && <span className="text-muted-foreground text-xs">DNS: {new Date(stamp).toLocaleString('ru-RU')}</span>}
      {report?.checkedAt && <span className="text-muted-foreground text-xs">TCP/QUIC: {new Date(report.checkedAt).toLocaleString('ru-RU')}</span>}
    </div>
    <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-background/30 p-3 text-sm">
      <label className="flex items-center gap-2"><Switch aria-label="Автопроверка стратегии" checked={value.config.autoEnabled} disabled={disabled || busy} onCheckedChange={checked => update({ ...value.config,autoEnabled: checked })} />Автопроверка<SettingInfo label="Автопроверка">Проверяется текущая стратегия. После двух неудач запускается подбор по включённым спискам. Замена — только на подтверждённый результат лучше текущего, с сохранением транспорта и игровых правил. Работает при закрытой панели; остановленное ядро не запускается.</SettingInfo></label>
      <label className="flex items-center gap-2">Каждые <input aria-label="Интервал автопроверки в часах" type="number" min={1} max={168} className="h-8 w-20 rounded-md border bg-input-background px-2" disabled={disabled || busy} value={value.config.intervalHours} onChange={event => update({ ...value.config, intervalHours: Number(event.target.value) })} /> ч</label>
      {value.automatic?.message && <span className="text-muted-foreground text-xs">{value.automatic.message}</span>}
    </div>
    {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
    <div className="flex items-center justify-end gap-3 border-t pt-2">
      {dirty && <span className="text-yellow-400 text-xs">Есть несохранённые изменения</span>}
      <Button size="sm" disabled={disabled || busy || !dirty || !value.config.selected.length || value.config.intervalHours < 1 || value.config.intervalHours > 168} onClick={() => void save()}>Сохранить ресурсы</Button>
    </div>
  </div>
}

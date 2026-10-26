import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { UtilityPanel } from '@/components/configuration/UtilityPanel'
import { MihomoGeoFiles, MihomoGeodata } from '@/components/configuration/MihomoGeoFiles'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { IconSearch, IconServer, IconWorld, IconPlus, IconRefresh } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { useAppContext, useModalContext } from '../../lib/store'
import { copyText } from '../../lib/utils'
import { Input } from '@/components/ui/input'
import { GeoFilePreview } from '@/components/configuration/GeoFilePreview'

type GeoType = 'domain' | 'ip'
type FileStatus = {
  categories: string[]
  status: 'idle' | 'scanning' | 'found' | 'not-found' | 'error'
}

export function GeoScanModal({ embedded = false }: { embedded?: boolean } = {}) {
  const { modals, dispatch } = useModalContext()
  const [core, setCore] = useState('xray')
  const [mihomoView, setMihomoView] = useState('geodata')
  const [geodataRefresh, setGeodataRefresh] = useState(0)
  const content = <><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="flex items-center gap-2 text-ui-title font-semibold"><IconSearch size={20}/>Геофайлы</h2><Tabs value={core} onValueChange={setCore}><TabsList><TabsTrigger value="xray">Xray</TabsTrigger><TabsTrigger value="mihomo">Mihomo</TabsTrigger></TabsList></Tabs></div>{core === 'xray' ? <DatGeoFiles key="xray" core="xray" embedded /> : <><Tabs value={mihomoView} onValueChange={setMihomoView}><TabsList><TabsTrigger value="geodata">Геобазы</TabsTrigger><TabsTrigger value="rulesets">Rule-set’ы</TabsTrigger></TabsList></Tabs>{mihomoView === 'geodata' ? <><details className="text-ui"><summary className="text-muted-foreground cursor-pointer">Сведения о геобазах</summary><MihomoGeodata refresh={geodataRefresh} /></details><DatGeoFiles key="mihomo" core="mihomo" embedded onUploaded={() => setGeodataRefresh(value => value + 1)} /></> : <section className="p-4"><MihomoGeoFiles /></section>}</>}</>
  if (embedded) return <div className="space-y-3 p-4">{content}</div>
  return <UtilityPanel open={modals.showGeoScanModal} onOpenChange={open => dispatch({type:'SHOW_MODAL', modal:'showGeoScanModal',show:open})} title="Геофайлы" description="Базы доменов и IP для Xray и Mihomo.">{content}</UtilityPanel>
}

function DatGeoFiles({ embedded = false, core = 'xray', onUploaded }: { embedded?: boolean; core?: 'xray' | 'mihomo'; onUploaded?: () => void } = {}) {
  const { showToast } = useAppContext()
  const { modals, dispatch } = useModalContext()
  const [geoType, setGeoType] = useState<GeoType>('domain')
  const [input, setInput] = useState('')
  const [geoFiles, setGeoFiles] = useState<{ domain: string[]; ip: string[] }>({
    domain: [],
    ip: [],
  })
  const [selectedFiles, setSelectedFiles] = useState<string[]>([])
  const [fileStatuses, setFileStatuses] = useState<Record<string, FileStatus>>({})
  const [scanning, setScanning] = useState(false)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [previewFile, setPreviewFile] = useState<string | null>(null)
  const uploadInput = useRef<HTMLInputElement>(null)

  const close = () => dispatch({ type: 'SHOW_MODAL', modal: 'showGeoScanModal', show: false })

  function initStatuses(files: string[]) {
    setFileStatuses(Object.fromEntries(files.map((f) => [f, { categories: [], status: 'idle' as const }])))
  }

  async function loadGeoFiles() {
    setLoading(true)
    try {
      const res = await fetch(`/api/geo?core=${core}`)
      const data = await res.json()
      if (data.success) {
        const files = {
          domain: data.site_files || [],
          ip: data.ip_files || [],
        }
        setGeoFiles(files)
        setSelectedFiles(files[geoType])
        initStatuses(files[geoType])
      }
    } catch {
      /* ignore */
    }
    setLoading(false)
  }

  useEffect(() => {
    loadGeoFiles()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function switchType(type: GeoType) {
    setGeoType(type)
    setInput('')
    setSelectedFiles(geoFiles[type])
    initStatuses(geoFiles[type])
  }

  async function upload(file: File) {
    if (core === 'mihomo' && file.name !== (geoType === 'ip' ? 'geoip.dat' : 'geosite.dat')) {
      showToast(`Для Mihomo нужен файл ${geoType === 'ip' ? 'geoip.dat' : 'geosite.dat'}`, 'error'); return
    }
    if (!file.name.endsWith('.dat') || file.size > 32 * 1024 * 1024 || file.size === 0) {
      showToast('Нужна база .dat размером до 32 МБ', 'error'); return
    }
    setUploading(true)
    try {
      const response = await fetch(`/api/geo/upload?file=${encodeURIComponent(file.name)}&kind=${geoType}&core=${core}`, {method: 'POST', headers: {'Content-Type': 'application/octet-stream'}, body: file})
      if (response.status === 413) throw new Error('База превышает ограничение 32 МБ')
      const result = await response.json()
      if (!response.ok || !result.success) throw new Error(result.error || 'Не удалось загрузить базу')
      await loadGeoFiles()
      onUploaded?.()
      showToast('База добавлена. Для маршрутизации выберите её категорию в правиле.')
    } catch (error) { showToast(error instanceof Error ? error.message : 'Не удалось загрузить базу', 'error') }
    finally { setUploading(false); if (uploadInput.current) uploadInput.current.value = '' }
  }

  function toggleFile(filename: string) {
    setSelectedFiles((prev) => (prev.includes(filename) ? prev.filter((f) => f !== filename) : [...prev, filename]))
  }

  async function scan() {
    if (!input.trim() || selectedFiles.length === 0) return
    setScanning(true)
    const endpoint = geoType === 'ip' ? '/api/geo/ip' : '/api/geo/site'
    const paramName = geoType === 'ip' ? 'ip' : 'domain'

    for (const file of selectedFiles) {
      setFileStatuses((prev) => ({
        ...prev,
        [file]: { status: 'scanning', categories: [] },
      }))
      try {
        const res = await fetch(`${endpoint}?file=${encodeURIComponent(file)}&${paramName}=${encodeURIComponent(input.trim())}&core=${core}`)
        const data = await res.json()
        if (!data.success && data.error) {
          showToast(data.error, 'error')
          setFileStatuses((prev) => ({
            ...prev,
            [file]: { status: 'error', categories: [] },
          }))
        } else {
          setFileStatuses((prev) => ({
            ...prev,
            [file]:
              data.success && data.categories?.length
                ? { status: 'found', categories: data.categories }
                : { status: 'not-found', categories: [] },
          }))
        }
      } catch {
        setFileStatuses((prev) => ({
          ...prev,
          [file]: { status: 'error', categories: [] },
        }))
      }
    }
    setScanning(false)
  }

  const currentFiles = geoFiles[geoType]
  const allSelected = currentFiles.length > 0 && currentFiles.every((f) => selectedFiles.includes(f))

  const content = <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Tabs value={geoType} onValueChange={value=>switchType(value as GeoType)}><TabsList><TabsTrigger value="domain" disabled={uploading||scanning}><IconWorld size={16}/>GeoSite</TabsTrigger><TabsTrigger value="ip" disabled={uploading||scanning}><IconServer size={16}/>GeoIP</TabsTrigger></TabsList></Tabs>
      <div className="flex gap-2"><Button size="sm" variant="outline" disabled={uploading||scanning||loading} onClick={()=>uploadInput.current?.click()}><IconPlus size={15}/>{uploading?'Загрузка…':'Добавить базу'}</Button><Button size="sm" variant="outline" disabled={loading||scanning||uploading} onClick={()=>void loadGeoFiles()}><IconRefresh size={15}/>Обновить список</Button></div>
      <input ref={uploadInput} type="file" accept=".dat" className="hidden" aria-label="Загрузить геобазу" onChange={event=>{const file=event.target.files?.[0];if(file)void upload(file)}}/>
    </div>
    <div className="flex gap-2"><Input value={input} aria-label="Домен или IP для проверки" onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!scanning)void scan()}} placeholder={geoType==='ip'?'IP-адрес':'Домен'}/><Button onClick={()=>void scan()} disabled={uploading||scanning||!input.trim()||!selectedFiles.length}><IconSearch size={16}/>{scanning?'Проверяем…':'Проверить'}</Button></div>
    <div className="border-border bg-input-background overflow-hidden rounded-xl border">
      <table className="w-full table-fixed text-left text-ui"><thead className="bg-card text-muted-foreground"><tr><th className="w-10 p-3"><Checkbox aria-label="Выбрать все базы" checked={allSelected} onCheckedChange={()=>setSelectedFiles(allSelected?[]:[...currentFiles])}/></th><th className="p-3 font-medium">База</th><th className="hidden w-36 p-3 font-medium sm:table-cell">Состояние</th><th className="w-28 p-3"/></tr></thead><tbody>
      {currentFiles.map(file=><tr key={file} className="border-border border-t"><td className="px-4 py-5"><Checkbox aria-label={`Выбрать ${file}`} checked={selectedFiles.includes(file)} onCheckedChange={()=>toggleFile(file)}/></td><td className="break-all px-4 py-5 text-lg font-medium">{file}</td><td className="hidden px-4 py-5 sm:table-cell"><Badge variant="emerald">Загружена</Badge></td><td className="px-4 py-5"><Button size="sm" variant="outline" disabled={scanning||uploading} onClick={()=>setPreviewFile(file)}>Просмотр</Button></td></tr>)}
      {!currentFiles.length&&<tr><td colSpan={4} className="text-muted-foreground p-5">{loading?'Загрузка…':'Геобазы не найдены'}</td></tr>}
      </tbody></table>
    </div>
    {Object.keys(fileStatuses).some(file=>fileStatuses[file].status!=='idle')&&<section className="border-border rounded-xl border p-4"><h3 className="mb-3 text-ui-section font-medium">Результаты</h3>{Object.entries(fileStatuses).filter(([,value])=>value.status!=='idle').map(([file,status])=><div key={file} className="border-border space-y-2 border-t py-3"><div className="flex items-center justify-between gap-3"><span className="break-all font-medium">{file}</span><span className={status.status==='found'?'text-emerald-400':status.status==='error'?'text-destructive':'text-muted-foreground'}>{status.status==='scanning'?'Проверяем…':status.status==='found'?`${status.categories.length} категорий`:status.status==='error'?'Ошибка':'Совпадений нет'}</span></div><div className="flex flex-wrap gap-2">{status.categories.map(category=><button type="button" key={category} className="bg-primary/10 text-primary rounded px-2 py-1 text-xs" onClick={()=>void copyText(core==='mihomo'?`${geoType==='ip'?'geoip':'geosite'}:${category.toLowerCase()}`:`ext:${file}:${category.toLowerCase()}`).then(ok=>showToast(ok?'Категория скопирована':'Не удалось скопировать',ok?'success':'error'))}>{category}</button>)}</div></div>)}</section>}
    <GeoFilePreview file={previewFile} kind={geoType} core={core} onClose={()=>setPreviewFile(null)}/>
  </div>
  if (embedded) return content
  return <UtilityPanel open={modals.showGeoScanModal} onOpenChange={open=>{if(!open)close()}} title="Геофайлы" description="Базы доменов и IP">{content}</UtilityPanel>
}

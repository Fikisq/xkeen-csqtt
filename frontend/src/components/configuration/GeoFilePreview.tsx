import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { apiCall } from '@/lib/api'

export function GeoFilePreview({ file, kind, core, onClose }: { file: string | null; kind: 'domain' | 'ip'; core: string; onClose: () => void }) {
  const [categories, setCategories] = useState<Array<{ name: string; count: number }>>([])
  const [category, setCategory] = useState(''), [filter, setFilter] = useState(''), [page, setPage] = useState(0)
  const [records, setRecords] = useState<Array<{ kind: string; value: string }>>([]), [total, setTotal] = useState(0)
  const [matches, setMatches] = useState<string[] | null>(null)
  const [loading, setLoading] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    let live = true; setCategories([]); setCategory(''); setMatches(null); setRecords([]); setPage(0); setFilter(''); setError('')
    if (!file) return
    setLoading(true)
    void apiCall<{success: boolean; error?: string; categories?: Array<{name: string; count: number}>}>('GET', `geo/categories?${new URLSearchParams({file,kind,core})}`).then(result => {
      if (!result.success) throw new Error(result.error || 'Не удалось открыть базу')
      if (live) setCategories(result.categories ?? [])
    }).catch(e => { if (live) setError(String(e)) }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [file, kind, core])
  useEffect(() => {
    let live = true
    setMatches(null); setRecords([]); setTotal(0)
    if (!file || (!category && !filter.trim())) {setLoading(false);return}
    setLoading(true); setError('')
    const timer = setTimeout(() => {
      const search=filter.trim()
      const endpoint=search?`geo/${kind==='ip'?'ip':'site'}?${new URLSearchParams({file,core,[kind==='ip'?'ip':'domain']:search})}`:`geo/records?${new URLSearchParams({file,kind,core,category,offset:String(page*100)})}`
      void apiCall<{success: boolean; error?: string; categories?: string[]; entries?: Array<{kind: string; value: string}>; total?: number}>('GET', endpoint).then(result => {
        if (!result.success) throw new Error(result.error || 'Не удалось прочитать записи')
        if (live) { if(search){setMatches(result.categories??[]);setTotal(result.categories?.length??0)}else{setRecords(result.entries??[]);setTotal(result.total??0)} }
      }).catch(e => { if (live) setError(String(e)) }).finally(() => { if (live) setLoading(false) })
    }, 150)
    return () => { live = false; clearTimeout(timer) }
  }, [file, category, filter, page, kind, core])
  return <Dialog open={file !== null} onOpenChange={open => { if (!open) onClose() }}><DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-3xl"><DialogHeader><DialogTitle>{file}</DialogTitle></DialogHeader>
    <Input autoFocus placeholder={kind==='ip'?'Введите IP для поиска по всей базе…':'Введите домен для поиска по всей базе…'} aria-label="Поиск адреса по всей геобазе" value={filter} onChange={e=>{setFilter(e.target.value);setCategory('');setPage(0)}} />
    <select aria-label="Просмотр категории геобазы" className="bg-input-background border-input h-9 min-w-0 rounded-md border px-2 text-ui" value={category} onChange={e=>{setCategory(e.target.value);setFilter('');setPage(0)}}><option value="">Просмотр категории — необязательно</option>{categories.map(item=><option key={item.name} value={item.name}>{item.name} ({item.count})</option>)}</select>
    {error&&<p role="alert" className="text-destructive text-ui">{error}</p>}
    <pre aria-label="Записи геобазы" className="bg-input-background max-h-[50dvh] min-h-24 overflow-auto rounded-lg border p-3 text-xs">{loading?'Поиск…':filter.trim()?matches===null?'Поиск…':matches.length?matches.map(name=>`${kind==='ip'?'GEOIP':'GEOSITE'}: ${name}`).join('\n'):'Адрес не найден в базе':category?records.map(row=>`${row.kind}: ${row.value}`).join('\n')||'Записей нет':'Введите адрес — проверим все категории базы.'}</pre>
    <div className="flex items-center justify-between gap-2 text-ui"><span>{filter.trim()?'Категорий':'Записей'}: {total}</span><div className="flex gap-2"><Button size="sm" variant="outline" disabled={!!filter.trim()||loading||page===0} onClick={()=>setPage(value=>value-1)}>Назад</Button><Button size="sm" variant="outline" disabled={!!filter.trim()||loading||(page+1)*100>=total} onClick={()=>setPage(value=>value+1)}>Далее</Button></div></div>
  </DialogContent></Dialog>
}

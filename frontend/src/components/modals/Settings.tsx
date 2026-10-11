import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { IconSettings } from '@tabler/icons-react'
import { useCallback, useState } from 'react'
import { apiCall } from '@/lib/api'
import { useAppContext, useModalContext } from '@/lib/store'
import type { ThemeMode } from '@/lib/types'
import { AccessJournal } from './AccessJournal'
function AuthSettingsField({
  authEnabled,
  onToggle,
  showToast,
}: {
  authEnabled: boolean
  onToggle: (value: boolean) => Promise<void>
  showToast: (msg: string, type?: 'success' | 'error') => void
}) {
  const [resetOpen, setResetOpen] = useState(false)

  const resetPassword = useCallback(async () => {
    const res = await fetch('/api/auth/reset', { method: 'POST' })
    const data = await res.json()
    if (data.success) window.location.reload()
    else showToast(data.error ?? 'Ошибка', 'error')
  }, [showToast])

  return (
    <FieldGroup className="gap-0!">
      <Field orientation="horizontal" className="px-0 py-3">
        <FieldContent>
          <FieldLabel>Авторизация</FieldLabel>
          <FieldDescription className="text-[13px]">Защита панели с помощью пароля при входе</FieldDescription>
        </FieldContent>
        <Switch checked={authEnabled} onCheckedChange={onToggle} aria-label="Авторизация" />
      </Field>

      {authEnabled && (
        <>
          <Separator className="my-0" />
          <Field orientation="horizontal" className="px-0 py-3">
            <FieldContent>
              <FieldLabel>Сбросить пароль</FieldLabel>
              <FieldDescription className="text-[13px]">Сбросить старый пароль и установить новый</FieldDescription>
            </FieldContent>
            <Popover open={resetOpen} onOpenChange={setResetOpen}>
              <PopoverTrigger render={<Button variant="destructive" size="sm">Сбросить</Button>} />
              <PopoverContent>
                <PopoverHeader>
                  <PopoverTitle>Вас перекинет на страницу установки пароля. Продолжить?</PopoverTitle>
                </PopoverHeader>
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="outline" onClick={() => setResetOpen(false)}>
                    Нет
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => void resetPassword()}>
                    Да
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          </Field>
        </>
      )}
    </FieldGroup>
  )
}

export function SettingsModal() {
  const { state, dispatch, showToast } = useAppContext({ includeSettings: true })
  const { modals } = useModalContext()
  const { settings } = state
  async function save(section: 'auth' | 'log', field: string, value: boolean | number) {
    try {
      const result = await apiCall<{ success: boolean; error?: string }>('PATCH', 'settings', { [section]: { [field]: value } })
      if (!result.success) throw new Error(result.error || 'Не удалось сохранить настройки')
      return true
    } catch (error) { showToast(error instanceof Error ? error.message : 'Ошибка сохранения', 'error'); return false }
  }
  const toggleAuth = async (value: boolean) => {
    if (await save('auth', 'enabled', value)) dispatch({ type: 'SET_SETTINGS', settings: { authEnabled: value } })
  }
  return <Dialog open={modals.showSettingsModal} onOpenChange={show => dispatch({ type: 'SHOW_MODAL', modal: 'showSettingsModal', show })}>
    <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-[560px]">
      <DialogHeader><DialogTitle className="flex items-center gap-2"><IconSettings className="text-chart-2" />Настройки</DialogTitle></DialogHeader>
      <Tabs defaultValue="general" className="flex min-h-0 flex-1 flex-col">
        <TabsList variant="line" className="justify-start"><TabsTrigger value="general">Общие</TabsTrigger><TabsTrigger value="access">Входы</TabsTrigger></TabsList>
        <div className="min-h-0 overflow-y-auto pr-2">
          <TabsContent value="general"><FieldGroup className="gap-0!">
            <Field orientation="horizontal" className="px-0 py-3"><FieldContent><FieldLabel htmlFor="theme">Тема приложения</FieldLabel><FieldDescription>Ручной режим или синхронизация с системой</FieldDescription></FieldContent>
              <select id="theme" value={settings.theme} className="bg-input-background border-input rounded-md border px-3 py-2 text-sm" onChange={event => dispatch({ type: 'SET_SETTINGS', settings: { theme: event.target.value as ThemeMode } })}><option value="auto">Авто</option><option value="light">Светлая</option><option value="dark">Тёмная</option></select>
            </Field><Separator />
            <AuthSettingsField authEnabled={settings.authEnabled} onToggle={toggleAuth} showToast={showToast} /><Separator />
            <Field orientation="horizontal" className="px-0 py-3"><FieldContent><FieldLabel htmlFor="timezone">Часовой пояс</FieldLabel><FieldDescription>Сдвиг времени для записей в журнале</FieldDescription></FieldContent>
              <select id="timezone" value={settings.timezone} className="bg-input-background border-input rounded-md border px-3 py-2 text-sm" onChange={async event => { const timezone = Number(event.target.value); if (await save('log', 'timezone', timezone)) dispatch({ type: 'SET_SETTINGS', settings: { timezone } }) }}>{Array.from({ length: 27 }, (_, i) => i - 12).map(value => <option key={value} value={value}>UTC{value >= 0 ? '+' : ''}{value}</option>)}</select>
            </Field>
          </FieldGroup></TabsContent>
          <TabsContent value="access"><AccessJournal /></TabsContent>
        </div>
      </Tabs>
    </DialogContent>
  </Dialog>}

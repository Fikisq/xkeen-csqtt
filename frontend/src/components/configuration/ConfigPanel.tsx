import { LogPanel } from '@/components/log/LogPanel'
import { readSelections, withSelections } from '@/lib/mihomoRoutingBackup'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  IconBox,
  IconBolt,
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconCode,
  IconDeviceFloppy,
  IconDotsFilled,
  IconExternalLinkFilled,
  IconFilePlus,
  IconFileText,
  IconListDetails,
  IconPencil,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconX,
} from '@tabler/icons-react'
import * as jsyaml from 'js-yaml'
import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react'
import { apiCall, capitalize, clashFetch, getFileLanguage } from '../../lib/api'
import { LazyBoundary, lazyLoad, useLazyMount } from '../../lib/loader'
import { fetchClashProxies, useProxiesStore, syncClashApiPort, useAppContext, useConnectionsSync, useModalContext } from '../../lib/store'
import type { Config } from '../../lib/types'
import { cn } from '../../lib/utils'
import { normalizeDevicePriority, baseRuleTag, type RouteTag, type RoutingRule } from '../../lib/xrayDeviceRouting'
import { addMihomoCustomRoute, defaultMihomoChoices, readMihomoFullBypass, withMihomoFullBypass, isMihomoFullRoute, mihomoRouteTags, readMihomoDevices, removeMihomoRoute as removeMihomoRouteDefinition, editMihomoRouteResources, renameMihomoCustomRoute, reorderMihomoRoutes, updateMihomoDevice } from '../../lib/mihomoDeviceRouting'
import { enableXrayRoutingCards } from '../../lib/xraySubscription'
import { createXrayRoutingQueue, rebaseXrayRouting } from '../../lib/xrayRoutingQueue'
import { linkProviderToVpn } from '../../lib/mihomoSubscription'
import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '../ui/context-menu'
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '../ui/input-group'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import type { CodeMirrorRef } from './CodeMirror'

const ConnectionsPanel = lazyLoad(() => import('./mihomo/Connections'), 'ConnectionsPanel')
const ProvidersModal = lazyLoad(() => import('../modals/Providers'), 'ProvidersModal')
const BackupsModal = lazyLoad(() => import('../modals/Backups'), 'BackupsModal')
const SelectorsPanel = lazyLoad(() => import('./mihomo/Selectors'), 'SelectorsPanel')
const XrayGlobalRoutingTable = lazyLoad(() => import('./xray/XrayGlobalRoutingTable'), 'XrayGlobalRoutingTable')
const CodeMirrorEditorLazy = lazyLoad(() => import('./CodeMirror'), 'CodeMirrorEditor')

const BackupsModalContainer = memo(function BackupsModalContainer({
  onRefreshConfigs,
}: {
  onRefreshConfigs: () => Promise<unknown>
}) {
  const { modals, dispatch } = useModalContext()
  const mounted = useLazyMount(modals.showBackupsModal)
  const handleOpenChange = useCallback(
    (open: boolean) => dispatch({ type: 'SHOW_MODAL', modal: 'showBackupsModal', show: open }),
    [dispatch]
  )
  if (!mounted) return null
  return (
    <LazyBoundary>
      <BackupsModal open={modals.showBackupsModal} onOpenChange={handleOpenChange} onRefreshConfigs={onRefreshConfigs} />
    </LazyBoundary>
  )
})

type ClashMode = 'rule' | 'global' | 'direct'
type ProvidersModalKind = 'rules' | 'proxies'

const TOGGLE_ALL_SELECTORS_EVENT = 'mihomo:toggle-all-selectors'

interface Props {
  onOpenImport: () => void
  onOpenTemplate: () => void
  onOpenGeoScan: () => void
  onOpenBackups: () => void
  onRefreshConfigs: () => Promise<Config[]>
  editorRef: React.RefObject<CodeMirrorRef | null>
  configActionsRef: React.RefObject<{ switchTab: (index: number) => void; getActiveIndex: () => number }>
}

interface ConfigTabProps {
  config: Config
  currentCore: string
  showToast: (msg: string, type?: 'success' | 'error') => void
  onRefreshConfigs: () => Promise<Config[]>
  withContextMenu?: boolean
}

type DialogState =
  | { type: 'create'; dir: string; isLst: boolean; anchorFile: string }
  | { type: 'rename'; file: string }
  | { type: 'delete'; file: string }
  | null

function ConfigTab({ config, currentCore, showToast, onRefreshConfigs, withContextMenu = false }: ConfigTabProps) {
  const [dialogData, setDialogData] = useState<DialogState>(null)
  const [popoverOpen, setPopoverOpen] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const pendingInputFocusRef = useRef(false)
  const [inputValue, setInputValue] = useState('')

  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768

  const openDialog = (value: NonNullable<DialogState>) => {
    pendingInputFocusRef.current = value.type !== 'delete'
    setDialogData(value)
    setPopoverOpen(true)
  }

  const closeDialog = () => setPopoverOpen(false)

  const fileExt = useMemo(() => {
    if (!dialogData || dialogData.type === 'delete') return ''
    if (dialogData.type === 'rename') return dialogData.file.match(/(\.[^.]+)$/)?.[1] ?? ''
    return dialogData.isLst ? '.lst' : currentCore === 'mihomo' ? '.yaml' : '.json'
  }, [dialogData, currentCore])

  async function commitDialog() {
    if (!dialogData) return
    const val = inputValue.trim()
    const ext = fileExt

    let req: { method: 'POST' | 'PATCH' | 'DELETE'; body: Record<string, any>; msg: string }

    if (dialogData.type === 'create') {
      if (!val) return
      req = { method: 'POST', body: { file: `${dialogData.dir}/${val}${ext}`, content: '' }, msg: `Файл "${val}${ext}" создан` }
    } else if (dialogData.type === 'rename') {
      if (!val) return
      const dir = dialogData.file.substring(0, dialogData.file.lastIndexOf('/'))
      req = { method: 'PATCH', body: { file: dialogData.file, new_file: `${dir}/${val}${ext}` }, msg: `Файл переименован в "${val}${ext}"` }
    } else {
      req = { method: 'DELETE', body: { file: dialogData.file }, msg: `Файл "${dialogData.file.split('/').pop()}" удалён` }
    }

    const result = await apiCall<{ success: boolean; error?: string }>(req.method, 'configs', req.body)

    if (result.success) {
      showToast(req.msg)
      await onRefreshConfigs()
      closeDialog()
    } else {
      showToast(`Ошибка: ${result.error}`, 'error')
    }
  }

  const isProtected = config.file.endsWith('/config.yaml') || config.file === 'config.yaml'

  const fileName = config.file.split('/').pop() ?? config.file
  const fileLabel = ({ '00_config.json': 'Конфигурация Xray', 'client_bypass_macs.lst': 'Без VPN', 'device_capture_xray.lst': 'Устройства Xray' } as Record<string, string>)[fileName] ?? fileName.replace(/\.[^.]+$/, '')
  const tabsTrigger = (
    <TabsTrigger value={config.file} className="dark:data-[state=active]:bg-input-background! relative data-[state=active]:bg-white!">
      {fileLabel}
      {config.isDirty && <span className="absolute top-0.75 right-0.75 h-1.5 w-1.5 rounded-full bg-amber-400" />}
    </TabsTrigger>
  )

  if (!withContextMenu)
    return (
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex">{tabsTrigger}</span>} />
        <TooltipContent className="text-[13px]">{config.file}</TooltipContent>
      </Tooltip>
    )

  return (
    <Popover open={popoverOpen} onOpenChange={(open) => { if (!open) setPopoverOpen(false) }}>
      <ContextMenu>
        <ContextMenuTrigger className="contents">
          <Tooltip>
            <PopoverTrigger render={<TooltipTrigger render={<span className="inline-flex">{tabsTrigger}</span>} />} />
            <TooltipContent className="text-[13px]">{config.file}</TooltipContent>
          </Tooltip>
        </ContextMenuTrigger>
        <ContextMenuContent
          onCloseAutoFocus={(e) => {
            if (pendingInputFocusRef.current) {
              e.preventDefault()
              pendingInputFocusRef.current = false
              requestAnimationFrame(() => inputRef.current?.focus())
            }
          }}
        >
          <ContextMenuItem
            onSelect={() => {
              const dir = config.file.substring(0, config.file.lastIndexOf('/'))
              setInputValue('')
              openDialog({ type: 'create', dir, isLst: config.file.endsWith('.lst'), anchorFile: config.file })
            }}
          >
            <IconFilePlus /> Создать файл
          </ContextMenuItem>
          <ContextMenuItem
            disabled={isProtected}
            onSelect={() => {
              const name =
                config.file
                  .split('/')
                  .pop()
                  ?.replace(/\.[^.]+$/, '') ?? ''
              setInputValue(name)
              openDialog({ type: 'rename', file: config.file })
            }}
          >
            <IconPencil /> Переименовать
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={isProtected} variant="destructive" onSelect={() => openDialog({ type: 'delete', file: config.file })}>
            <IconTrash /> Удалить
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <PopoverContent
        align="start"
        className="w-auto min-w-64"
        avoidCollisions={!isMobile}
      >
        {dialogData?.type === 'delete' ? (
          <>
            <p className="text-sm font-medium">Удалить «{config.file.split('/').pop()}»?</p>
            <div className="flex justify-end gap-2 pt-1">
              <Button size="sm" variant="outline" onClick={closeDialog}>
                Отмена
              </Button>
              <Button size="sm" variant="destructive" onClick={commitDialog}>
                Удалить
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm font-medium">{dialogData?.type === 'create' ? 'Создать файл' : 'Переименовать файл'}</p>
            <InputGroup>
              <InputGroupInput
                ref={inputRef}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && commitDialog()}
                placeholder="Имя файла"
              />
              {fileExt && (
                <InputGroupAddon align="inline-end">
                  <InputGroupText>{fileExt}</InputGroupText>
                </InputGroupAddon>
              )}
            </InputGroup>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={closeDialog}>
                Отмена
              </Button>
              <Button size="sm" onClick={commitDialog}>
                {dialogData?.type === 'create' ? 'Создать' : 'Переименовать'}
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

export function ConfigPanel({ onOpenImport, onOpenTemplate, onOpenGeoScan, onOpenBackups, onRefreshConfigs, editorRef, configActionsRef }: Props) {
  const { state, dispatch, showToast } = useAppContext({ includeConfigs: true })
  const { configs, isConfigsLoading, currentCore, serviceStatus, clashApiPort, clashApiSecret, clashApiUnix } = state

  const isRunning = serviceStatus === 'running'
  const isPending = serviceStatus === 'pending'
  const activeClashApiPort = isRunning ? clashApiPort : null
  const activeClashApiUnix = isRunning ? clashApiUnix : null

  useConnectionsSync(currentCore === 'mihomo' ? activeClashApiPort : null, clashApiSecret, serviceStatus, activeClashApiUnix)

  const [activeConfigFile, setActiveConfigFile] = useState<string>(() => localStorage.getItem('lastSelectedTab') ?? '')
  const activeConfigIndex = useMemo(() => {
    if (!configs.length) return 0
    const idx = configs.findIndex((c) => c.file === activeConfigFile)
    return idx >= 0 ? idx : 0
  }, [configs, activeConfigFile])
  const [validationState, setValidationState] = useState<{ isValid: boolean; error?: string } | null>(null)

  const [, setIsEditorMounted] = useState(false)

  const [activePanel, setActivePanel] = useState<'selectors' | 'connections' | 'config'>('selectors')
  const [mountedPanels, setMountedPanels] = useState<Set<string>>(() => new Set(['selectors']))
  const [mode, setMode] = useState<ClashMode>('rule')
  const [routingDraft, setRoutingDraft] = useState<{ file: string; base: string; content: string; preserveOrder?: boolean } | null>(null)
  const [routingSaving, setRoutingSaving] = useState(false)
  const [routingAutoSaving, setRoutingAutoSaving] = useState(false)
  const [routingAutoPreview, setRoutingAutoPreview] = useState<{ file: string; content: string } | null>(null)
  const routingQueueRef = useRef<{ file: string; confirmed: string; queue: ReturnType<typeof createXrayRoutingQueue> } | null>(null)
  const routingRecoveryRef = useRef(false)
  useEffect(() => {
    if (!routingDraft && !routingAutoSaving) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [routingDraft, routingAutoSaving])
  const [allSelectorsCollapsed, setAllSelectorsCollapsed] = useState(false)
  const [providersModalKind, setProvidersModalKind] = useState<ProvidersModalKind | null>(null)
  const [isProvidersModalOpen, setIsProvidersModalOpen] = useState(false)
  const mountProvidersModal = useLazyMount(isProvidersModalOpen)
  const currentPanel = isRunning ? currentCore === 'xray' && activePanel === 'connections' ? 'selectors' : activePanel : 'config'

  useEffect(() => {
    setActivePanel('selectors')
    setMountedPanels(new Set(['selectors']))
    setAllSelectorsCollapsed(false)
  }, [currentCore])

  const configsRef = useRef(configs)
  const activeIndexRef = useRef(activeConfigIndex)
  const viewStatesRef = useRef<Record<string, any>>({})

  useEffect(() => {
    configsRef.current = configs
  }, [configs])
  useEffect(() => {
    activeIndexRef.current = activeConfigIndex
  }, [activeConfigIndex])

  const saveViewState = useCallback(
    (file: string, isDirty?: boolean) => {
      if (!editorRef.current) return
      const state = editorRef.current.saveViewState()
      if (state) {
        viewStatesRef.current[file] = state
        if (!isDirty) {
          try {
            localStorage.setItem(`editor-folds:${file}`, JSON.stringify(state.folds ?? []))
          } catch {
            /* */
          }
        }
      }
    },
    [editorRef]
  )

  useEffect(() => {
    function onBeforeUnload() {
      const currentCfg = configsRef.current[activeIndexRef.current]
      if (currentCfg) saveViewState(currentCfg.file, currentCfg.isDirty)
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [saveViewState])

  const configFilenamesKey = configs.map((c) => c.file).join(',')

  useEffect(() => {
    if (currentCore !== 'mihomo' || (!activeClashApiPort && !activeClashApiUnix)) return
    let cancelled = false
    const timer = setTimeout(() => {
      if (cancelled) return
      clashFetch<{ mode?: ClashMode }>(activeClashApiPort ?? '', 'configs', { secret: clashApiSecret, unix: activeClashApiUnix })
        .then((data) => {
          if (data.mode) setMode(data.mode)
        })
        .catch(() => { })
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [currentCore, activeClashApiPort, clashApiSecret, activeClashApiUnix])

  const changeMode = useCallback(
    async (newMode: ClashMode) => {
      if (newMode === mode || (!activeClashApiPort && !activeClashApiUnix)) return
      setMode(newMode)
      await clashFetch(activeClashApiPort ?? '', 'configs', {
        method: 'PATCH',
        secret: clashApiSecret,
        unix: activeClashApiUnix,
        body: { mode: newMode },
      })
      await clashFetch(activeClashApiPort ?? '', 'connections', { method: 'DELETE', secret: clashApiSecret, unix: activeClashApiUnix })
    },
    [activeClashApiPort, clashApiSecret, activeClashApiUnix, mode]
  )

  const activeConfig = configs[activeConfigIndex]
  const fileLanguage = activeConfig ? getFileLanguage(activeConfig.file) : null
  const isJsonOrYaml = fileLanguage === 'json' || fileLanguage === 'yaml'
  const canSave = !!(activeConfig?.isDirty && validationState?.isValid)
  const canApply = canSave && isRunning && !isPending
  const canFormat = !!(isJsonOrYaml && validationState?.isValid)

  const loadConfigIntoEditor = useCallback(
    (config: Config) => {
      if (!editorRef.current) return
      editorRef.current.setSavedContent(config.savedContent)
      const inMemory = viewStatesRef.current[config.file]
      editorRef.current.setValue(config.content, config.savedContent, inMemory?.history)
      editorRef.current.setLanguage(getFileLanguage(config.file))
      editorRef.current.validate(config.file)
      if (inMemory) {
        editorRef.current.restoreViewState(inMemory)
      } else {
        const folds = (() => {
          try {
            return JSON.parse(localStorage.getItem(`editor-folds:${config.file}`) ?? 'null')
          } catch {
            return null
          }
        })()
        if (folds) editorRef.current.restoreViewState({ anchor: 0, head: 0, scrollTop: 0, scrollLeft: 0, folds })
      }
    },
    [editorRef]
  )

  useEffect(() => {
    const config = configsRef.current[activeConfigIndex]
    if (editorRef.current && config) {
      loadConfigIntoEditor(config)
    }
  }, [activeConfigIndex, configFilenamesKey, loadConfigIntoEditor, editorRef])

  const handleEditorReady = useCallback(() => {
    setIsEditorMounted(true)
    const config = configsRef.current[activeIndexRef.current]
    if (config && editorRef.current) loadConfigIntoEditor(config)
  }, [loadConfigIntoEditor, editorRef])

  const handleContentChange = useCallback(
    (content: string, isDirty: boolean) => {
      const index = activeIndexRef.current
      if (index < 0) return
      const current = configsRef.current[index]
      if (!current) return
      if (current.content === content && current.isDirty === isDirty) return
      dispatch({ type: 'UPDATE_CONFIG_DIRTY', index, isDirty, content })
    },
    [dispatch]
  )

  const handleValidationChange = useCallback((isValid: boolean, error?: string) => {
    setValidationState((prev) => (prev?.isValid === isValid && prev?.error === error ? prev : { isValid, error }))
  }, [])

  const openProvidersModal = useCallback((kind: ProvidersModalKind) => {
    setProvidersModalKind(kind)
    setIsProvidersModalOpen(true)
  }, [])

  const handleProvidersModalOpenChange = useCallback((open: boolean) => setIsProvidersModalOpen(open), [])

  const refreshConfigsAndEditor = useCallback(async () => {
    const currentCfg = configsRef.current[activeIndexRef.current]
    if (currentCfg) saveViewState(currentCfg.file, currentCfg.isDirty)

    const targetFile = currentCfg?.file ?? activeConfigFile
    const nextConfigs = await onRefreshConfigs()
    const nextConfig = nextConfigs.find((config) => config.file === targetFile) ?? nextConfigs[0]

    if (nextConfig) {
      if (nextConfig.file !== activeConfigFile) {
        setActiveConfigFile(nextConfig.file)
        localStorage.setItem('lastSelectedTab', nextConfig.file)
      }
      loadConfigIntoEditor(nextConfig)
    }

    return nextConfigs
  }, [activeConfigFile, loadConfigIntoEditor, onRefreshConfigs, saveViewState])

  const switchTab = useCallback(
    (index: number) => {
      if (index === activeIndexRef.current) return
      const currentCfg = configsRef.current[activeIndexRef.current]
      if (currentCfg) saveViewState(currentCfg.file, currentCfg.isDirty)

      const file = configsRef.current[index]?.file ?? ''
      setActiveConfigFile(file)
      localStorage.setItem('lastSelectedTab', file)
    },
    [saveViewState]
  )

  useEffect(() => {
    configActionsRef.current = { switchTab, getActiveIndex: () => activeIndexRef.current }
  }, [configActionsRef, switchTab])

  async function saveCurrentConfig(_force = false) {
    const cfg = configsRef.current[activeIndexRef.current]
    if (!cfg || !editorRef.current) return
    const content = editorRef.current.getValue()
    if (!content.trim()) return showToast('Конфигурация пустая', 'error')
    if (!editorRef.current.isValid(cfg.file)) return showToast('Файл содержит ошибки', 'error')

    const result = await apiCall<{ success: boolean; error?: string }>('PUT', 'configs', { file: cfg.file, content })
    if (result.success) {
      editorRef.current.setSavedContent(content)
      dispatch({ type: 'SAVE_CONFIG', index: activeIndexRef.current, content })
      saveViewState(cfg.file, false)
      showToast(`Файл "${cfg.file.split('/').pop()}" сохранен`)
    } else {
      showToast(`Ошибка сохранения: ${result.error}`, 'error')
    }
  }

  async function saveAndApply(_force = false) {
    const cfg = configsRef.current[activeIndexRef.current]
    if (!cfg || !editorRef.current) return
    const content = editorRef.current.getValue()
    if (!content.trim()) return showToast('Файл пустой', 'error')
    if (!editorRef.current.isValid(cfg.file)) return showToast('Файл содержит ошибки', 'error')


    dispatch({ type: 'SET_SERVICE_STATUS', status: 'pending', pendingText: 'Применение...' })

    let url = 'configs'
    if (!cfg.file.startsWith('/opt/etc/xkeen')) {
      if (currentCore === 'mihomo') {
        url += '?validate=mihomo'
      } else if (currentCore === 'xray') {
        url += '?validate=xray'
      }
    }

    const saveResult = await apiCall<{ success: boolean; error?: string }>('PUT', url, { file: cfg.file, content })
    if (!saveResult.success) {
      dispatch({ type: 'SET_SERVICE_STATUS', status: isRunning ? 'running' : 'stopped' })
      return showToast(
        saveResult.error === 'Validation failed'
          ? `Ошибка валидации ${capitalize(currentCore)}: проверьте журнал`
          : `Ошибка сохранения: ${saveResult.error}`,
        'error'
      )
    }

    editorRef.current.setSavedContent(content)
    dispatch({ type: 'SAVE_CONFIG', index: activeIndexRef.current, content })
    saveViewState(cfg.file, false)
    dispatch({ type: 'SET_SERVICE_STATUS', status: 'pending', pendingText: 'Перезапуск...' })
    const lang = getFileLanguage(cfg.file)
    const r = await apiCall<{ success: boolean; error?: string }>('POST', 'control', {
      action:
        !xkeenConfigs.some((c) => c.file === cfg.file) &&
          (lang === 'json' || lang === 'yaml') &&
          !hasCriticalChanges(cfg.savedContent, content, lang)
          ? 'softRestart'
          : 'hardRestart',
      core: currentCore,
    })
    showToast(r?.success ? 'Изменения применены' : `Ошибка: ${r?.error}`, r?.success ? 'success' : 'error')
    dispatch({ type: 'SET_SERVICE_STATUS', status: r?.success ? 'running' : 'stopped' })
    if (r?.success) {
      syncClashApiPort(200)
    }
  }

  const coreConfigs = configs.filter((c) => !c.file.startsWith('/opt/etc/xkeen'))
  const xkeenConfigs = configs.filter((c) => c.file.startsWith('/opt/etc/xkeen'))

  const xraySelectorsConfig = currentCore === 'xray' ? coreConfigs.find((config) => {
    try {
      const parsed = parseJsonc(config.savedContent)
      return Array.isArray(parsed?.routing?.rules) && parsed.routing.rules.some((rule: any) => rule.ruleTag === 'VPN')
    } catch { return false }
  }) : undefined
  const hasXraySelectors = !!xraySelectorsConfig
  const xrayMigrationConfig = currentCore === 'xray' && !hasXraySelectors ? coreConfigs.find((config) => {
    try { return Array.isArray(parseJsonc(config.savedContent)?.routing?.rules) } catch { return false }
  }) : undefined

  async function applyXrayRoutingEdit(file: string, edit: (content: string) => string, successMessage: string, commit = false, preserveOrder = false): Promise<boolean> {
    if (routingAutoSaving || routingRecoveryRef.current) return false
    if (routingSaving) return false
    if (configs.some((config) => config.isDirty)) { showToast('Сначала сохраните изменения в редакторе', 'error'); return false }
    const config = configs.find((item) => item.file === file)
    if (!config) return false
    let saved = false
    try {
      if (routingDraft && (routingDraft.file !== file || routingDraft.base !== config.savedContent)) throw new Error('Конфигурация изменилась. Скачайте черновик и отмените его перед повторным применением')
      const edited = edit(routingDraft?.content ?? config.savedContent)
      const parsed = parseJsonc(edited)
      const keepOrder = preserveOrder || !!routingDraft?.preserveOrder
      const content = keepOrder ? edited : applyEdits(edited, modify(edited, ['routing', 'rules'], normalizeDevicePriority(parsed.routing.rules), { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
      if (!commit) {
        setRoutingDraft(content === config.savedContent ? null : { file, base: config.savedContent, content, preserveOrder: keepOrder })
        return true
      }
      if (content === config.savedContent) return true
      setRoutingSaving(true)
      const current = parseJsonc(config.savedContent)
      const liveRouting = current?.api?.listen === '127.0.0.1:18085' && current.api.services?.includes('RoutingService')
      if (liveRouting) {
        const applied = await apiCall<{ success: boolean; error?: string; warning?: string }>('POST', 'xray/routes', {
          file, previous_content: config.savedContent, content,
        })
        if (!applied.success) throw new Error(applied.error || 'Xray не принял правила')
        setRoutingDraft(null)
        await onRefreshConfigs()
        showToast(applied.warning || successMessage)
        return true
      }
      dispatch({ type: 'SET_SERVICE_STATUS', status: 'pending', pendingText: 'Переключение Xray...' })
      const put = await apiCall<{ success: boolean; error?: string }>('PUT', 'configs?validate=xray', { file, content })
      if (!put.success) throw new Error(put.error || 'Проверка Xray не пройдена')
      saved = true
      const restart = await apiCall<{ success: boolean; error?: string }>('POST', 'control', { action: 'hardRestart', core: 'xray' })
      if (!restart.success) throw new Error(restart.error || 'Xray не перезапустился')
      const status = await apiCall<{ success: boolean; running: boolean }>('GET', 'control')
      if (!status.success || !status.running) throw new Error('Xray не запустился после переключения')
      await onRefreshConfigs()
      setRoutingDraft(null)
      showToast(successMessage)
      dispatch({ type: 'SET_SERVICE_STATUS', status: 'running' })
      return true
    } catch (error) {
      if (saved) {
        const rollback = await apiCall<{ success: boolean }>('PUT', 'configs?validate=xray', { file, content: config.savedContent }).catch(() => null)
        if (rollback?.success) await apiCall('POST', 'control', { action: 'hardRestart', core: 'xray' }).catch(() => null)
      }
      const status = await apiCall<{ success: boolean; running: boolean }>('GET', 'control').catch(() => null)
      dispatch({ type: 'SET_SERVICE_STATUS', status: status?.running ? 'running' : 'stopped' })
      showToast(error instanceof Error ? error.message : 'Не удалось переключить Xray', 'error')
      return false
    } finally { setRoutingSaving(false) }
  }

  function enqueueXrayRoutingEdit(file: string, edit: (content: string) => string, message: string): Promise<boolean> {
    const config = configsRef.current.find(item => item.file === file)
    if (!config || routingRecoveryRef.current) return Promise.resolve(false)
    const current = parseJsonc(config.savedContent)
    const liveRouting = current?.api?.listen === '127.0.0.1:18085' && current.api.services?.includes('RoutingService')
    if (routingDraft || !liveRouting) return applyXrayRoutingEdit(file, edit, message, !routingDraft, true)
    if (routingSaving || configsRef.current.some(item => item.isDirty && (getFileLanguage(item.file) !== 'json' || JSON.stringify(parseJsonc(item.content)) !== JSON.stringify(parseJsonc(item.savedContent))))) {
      showToast('Сначала сохраните изменения в редакторе', 'error')
      return Promise.resolve(false)
    }
    let session = routingQueueRef.current
    if (!session || session.file !== file || session.confirmed !== config.savedContent && !session.queue.isPending()) {
      const next = { file, confirmed: config.savedContent, queue: null as unknown as ReturnType<typeof createXrayRoutingQueue> }
      next.queue = createXrayRoutingQueue({
        initial: config.savedContent,
        rebase: rebaseXrayRouting,
        send: async (previous, content) => {
          let applied = await apiCall<{ success: boolean; error?: string; warning?: string }>('POST', 'xray/routes', {
            file, previous_content: previous, content,
          })
          if (!applied.success && applied.error?.includes('Конфигурация уже изменилась')) {
            const latest = (await onRefreshConfigs()).find(item => item.file === file)?.savedContent
            if (!latest) throw new Error('Не удалось загрузить актуальную конфигурацию')
            content = rebaseXrayRouting(previous, content, latest)
            applied = await apiCall('POST', 'xray/routes', { file, previous_content: latest, content })
          }
          if (!applied.success) throw new Error(applied.error || 'Xray не принял правила')
          if (applied.warning) showToast(applied.warning)
          return content
        },
        onState: (content, pending) => {
          setRoutingAutoPreview(pending ? { file, content } : null)
          setRoutingAutoSaving(pending)
        },
        onCommit: content => {
          next.confirmed = content
          const index = configsRef.current.findIndex(item => item.file === file)
          if (index >= 0) {
            const existing = configsRef.current[index]
            const keepDraft = existing.isDirty && JSON.stringify(parseJsonc(existing.content)) !== JSON.stringify(parseJsonc(existing.savedContent))
            configsRef.current = configsRef.current.map((item, i) => i === index ? { ...item, content: keepDraft ? existing.content : content, savedContent: content, isDirty: keepDraft } : item)
            dispatch({ type: 'SAVE_CONFIG', index, content })
            if (keepDraft) dispatch({ type: 'UPDATE_CONFIG_DIRTY', index, content: existing.content, isDirty: true })
            if (activeIndexRef.current === index && editorRef.current) {
              if (keepDraft) editorRef.current.setSavedContent(content)
              else editorRef.current.setValue(content, content)
              editorRef.current.validate(file)
            }
          }
        },
        onError: error => {
          routingRecoveryRef.current = true
          routingQueueRef.current = null
          showToast(error instanceof Error ? error.message : 'Не удалось применить маршрутизацию', 'error')
          void refreshConfigsAndEditor().catch(() => {}).finally(() => { routingRecoveryRef.current = false })
        },
      })
      session = next
      routingQueueRef.current = next
    }
    try { return session.queue.edit(edit) }
    catch (error) {
      showToast(error instanceof Error ? error.message : 'Не удалось изменить правило', 'error')
      return Promise.resolve(false)
    }
  }

  async function editGlobalRouting(change: (rules: RoutingRule[]) => RoutingRule[]): Promise<boolean> {
    if (!xraySelectorsConfig) return false
    return enqueueXrayRoutingEdit(xraySelectorsConfig.file, content => {
      const parsed = parseJsonc(content)
      const before: RoutingRule[] = parsed?.routing?.rules
      if (!Array.isArray(before)) throw new Error('Правила Xray не найдены')
      const after = change(before)
      if (!Array.isArray(after)) throw new Error('Не удалось изменить общие правила')
      return applyEdits(content, modify(content, ['routing', 'rules'], normalizeDevicePriority(after), { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
    }, 'Общая маршрутизация применена')
  }

  async function editDeviceRouting(ip: string, change: (rules: RoutingRule[]) => RoutingRule[]): Promise<boolean> {
    if (!xraySelectorsConfig) return false
    return enqueueXrayRoutingEdit(xraySelectorsConfig.file, content => {
      const parsed = parseJsonc(content)
      const before: RoutingRule[] = parsed?.routing?.rules
      if (!Array.isArray(before)) throw new Error('Правила Xray не найдены')
      const own = (rule: RoutingRule) => baseRuleTag(rule).replace(/^disabled:/, '').startsWith(`device:${ip}:`)
      const after = change(before)
      if (!Array.isArray(after)) throw new Error('Не удалось изменить правила устройства')
      if (JSON.stringify(before.filter(rule => !own(rule))) !== JSON.stringify(after.filter(rule => !own(rule)))) throw new Error('Правила других устройств и общие маршруты изменять нельзя')
      if (after.some(rule => own(rule) && (rule.type !== 'field' || JSON.stringify(rule.sourceIP) !== (baseRuleTag(rule).startsWith('disabled:') ? '["192.0.2.255"]' : JSON.stringify([ip]))))) throw new Error(`Правило должно относиться только к ${ip}`)
      return applyEdits(content, modify(content, ['routing', 'rules'], normalizeDevicePriority(after), { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
    }, `Маршрут ${ip} применён`)
  }

  const mihomoConfig = configs.find((item) => item.file.endsWith('/config.yaml') || item.file === 'config.yaml')
  const liveMihomoSelections = () => Object.fromEntries(Object.values(useProxiesStore.getState().proxies).filter((p: any) => p.now && p.name !== 'GLOBAL').map((p: any) => [p.name, p.now])) as Record<string, string>

  async function editMihomoCustomRoute(transform: (content: string) => string, _message: string): Promise<boolean> {
    if (!mihomoConfig || routingSaving) return false
    if (configs.some(config => config.isDirty)) { showToast('Сначала сохраните изменения в редакторе', 'error'); return false }
    try {
      if (routingDraft && (routingDraft.file !== mihomoConfig.file || routingDraft.base !== mihomoConfig.savedContent)) throw new Error('Конфигурация изменилась. Скачайте черновик и отмените его перед повторным применением')
      const content = transform(routingDraft?.content ?? withSelections(mihomoConfig.savedContent, liveMihomoSelections()))
      setRoutingDraft({ file: mihomoConfig.file, base: mihomoConfig.savedContent, content })
      return true
    } catch (error) { showToast(error instanceof Error ? error.message : 'Не удалось изменить маршрут', 'error'); return false }
  }
  async function selectMihomoDevice(ip: string, route: RouteTag | null, target?: string): Promise<boolean> {
    return editMihomoCustomRoute(content => updateMihomoDevice(content, ip, route, target), '')
  }
  async function selectMihomoDraft(name: string, target: string): Promise<boolean> {
    return editMihomoCustomRoute(content => {
      const actualTarget = target === '@bypass' ? 'DIRECT' : target
      const selections = { ...readSelections(content), [name]: actualTarget }
      const defaults = defaultMihomoChoices(content)
      if (name === defaults.VPN && (target === '@bypass' || (target !== 'DIRECT' && isMihomoFullRoute(target)))) for (const group of Object.values(defaults)) {
        if (group !== 'DIRECT' && group !== target) selections[group] = actualTarget
      }
      return withSelections(name === defaults.VPN ? withMihomoFullBypass(content, target === '@bypass') : content, selections)
    }, '')
  }
  async function commitMihomoRouting() {
    if (!mihomoConfig || !routingDraft || routingSaving || routingDraft.file !== mihomoConfig.file) return
    setRoutingSaving(true)
    const previousChoices = liveMihomoSelections()
    let saved = false
    const applyRuntime = async (content: string, choices: Record<string, string>) => {
      await clashFetch(activeClashApiPort ?? '', 'configs?force=true', { method: 'PUT', secret: clashApiSecret, unix: activeClashApiUnix, body: { path: mihomoConfig.file, payload: '' }, retry: false })
      await fetchClashProxies(activeClashApiPort ?? '', clashApiSecret, true, activeClashApiUnix)
      for (const [name, target] of Object.entries(choices)) {
        const proxy = useProxiesStore.getState().proxies[name] as any
        if (!proxy) continue
        if (!proxy.all?.includes(target)) throw new Error(`Узел «${target}» отсутствует в группе «${name}»`)
        await clashFetch(activeClashApiPort ?? '', `proxies/${encodeURIComponent(name)}`, {method: 'PUT', secret: clashApiSecret, unix: activeClashApiUnix, body: {name: target}, retry: false})
      }
      const defaults = defaultMihomoChoices(content)
      const routes = mihomoRouteTags(content).filter(route => route !== 'VPN')
      const proxies = useProxiesStore.getState().proxies as Record<string, any>
      const direct = (initial: string): boolean => {
        let name = initial
        const seen = new Set<string>()
        while (name && !seen.has(name)) {
          if (name === 'DIRECT' || /без\s*(?:vpn|впн)/i.test(name)) return true
          seen.add(name)
          name = choices[name] ?? proxies[name]?.now
        }
        return false
      }
      const profiles = readMihomoDevices(content)
      const ips = profiles.filter(p => p.choices.VPN !== '@direct' && direct(p.choices.VPN)).map(p => p.ip)
      const bypass = await apiCall<{success: boolean; error?: string; warning?: string}>('POST', 'mihomo/device-direct', {ips})
      if (!bypass.success) throw new Error(bypass.error || 'Не удалось применить обход устройств')
      let name: string | undefined = proxies.VPN ? 'VPN' : 'Селектор'
      const seen = new Set<string>()
      while (name && !seen.has(name) && name !== 'DIRECT' && !/без\s*(?:vpn|впн)/i.test(name)) { seen.add(name); name = choices[name] ?? proxies[name]?.now }
      const selective = profiles.some(p => !direct(p.choices.VPN) || routes.some(route => !direct(p.choices[route] === defaults[route] ? defaults[route] : p.choices[route])))
      const global = await apiCall<{success: boolean; error?: string}>('POST', 'mihomo/global-direct', {enabled: readMihomoFullBypass(content) && !!name && direct(name) && !selective && routes.every(route => direct(defaults[route]))})
      if (!global.success) throw new Error(global.error || 'Не удалось применить общий режим')
      await fetchClashProxies(activeClashApiPort ?? '', clashApiSecret, true, activeClashApiUnix)
      return bypass.warning
    }
    try {
      const fresh = await apiCall<{configs: Array<{file: string; content: string}>}>('GET', 'configs?core=mihomo')
      if (fresh.configs.find(c => c.file === mihomoConfig.file)?.content !== routingDraft.base) throw new Error('Конфигурация уже изменилась. Сохраните черновик в файл и загрузите актуальные настройки')
      const put = await apiCall<{success: boolean; error?: string}>('PUT', 'configs?core=mihomo&validate=mihomo', {file: mihomoConfig.file, content: routingDraft.content})
      if (!put.success) throw new Error(put.error || 'Проверка Mihomo не пройдена')
      saved = true
      const warning = await applyRuntime(routingDraft.content, readSelections(routingDraft.content))
      await onRefreshConfigs()
      setRoutingDraft(null)
      showToast(warning || 'Маршрутизация Mihomo сохранена и применена')
    } catch (error) {
      if (saved) {
        const rollback = await apiCall<{success: boolean}>('PUT', 'configs?core=mihomo&validate=mihomo', {file: mihomoConfig.file, content: mihomoConfig.savedContent}).catch(() => null)
        if (rollback?.success) await applyRuntime(mihomoConfig.savedContent, previousChoices).catch(() => showToast('Не удалось полностью восстановить настройки после ошибки', 'error'))
      }
      showToast(error instanceof Error ? error.message : 'Ошибка применения Mihomo', 'error')
    } finally { setRoutingSaving(false) }
  }

  async function addMihomoRoute(name: string, domains: string[]): Promise<boolean> {
    return editMihomoCustomRoute((content) => addMihomoCustomRoute(content, name, domains), `Маршрут «${name}» добавлен`)
  }

  async function removeMihomoRoute(tag: string): Promise<boolean> {
    return editMihomoCustomRoute((content) => removeMihomoRouteDefinition(content, tag), 'Маршрут удалён')
  }

  async function editMihomoResources(tag: RouteTag, values: string[]): Promise<boolean> {
    return editMihomoCustomRoute(content => editMihomoRouteResources(content, tag, values), 'Ресурсы маршрута обновлены')
  }

  async function renameMihomoRoute(tag: string, name: string): Promise<boolean> {
    return editMihomoCustomRoute((content) => renameMihomoCustomRoute(content, tag, name), `Маршрут переименован в «${name.trim()}»`)
  }

  async function reorderMihomoRoute(source: RouteTag, target: RouteTag): Promise<boolean> {
    return editMihomoCustomRoute((content) => reorderMihomoRoutes(content, source, target), 'Порядок правил Mihomo сохранён')
  }

  async function connectMihomoSubscriptions() {
    if (configs.some((config) => config.isDirty)) return showToast('Сначала сохраните изменения в редакторе', 'error')
    const config = configs.find((item) => item.file.endsWith('/config.yaml') || item.file === 'config.yaml')
    if (!config) return showToast('Mihomo config.yaml не найден', 'error')
    let saved = false
    try {
      const parsed = jsyaml.load(config.savedContent) as Record<string, any>
      const providers = Object.keys(parsed?.['proxy-providers'] ?? {})
      if (providers.length === 0) throw new Error('В config.yaml нет proxy-providers')
      let content = config.savedContent
      for (const provider of providers) content = linkProviderToVpn(content, `  ${provider}:\n`)
      if (content === config.savedContent) return showToast('Провайдеры уже доступны в группах')
      dispatch({ type: 'SET_SERVICE_STATUS', status: 'pending', pendingText: 'Обновление групп Mihomo...' })
      const put = await apiCall<{ success: boolean; error?: string }>('PUT', 'configs?validate=mihomo', { file: config.file, content })
      if (!put.success) throw new Error(put.error || 'Mihomo не принял конфигурацию')
      saved = true
      const restart = await apiCall<{ success: boolean; error?: string }>('POST', 'control', { action: 'hardRestart', core: 'mihomo' })
      if (!restart.success) throw new Error(restart.error || 'Mihomo не перезапустился')
      const status = await apiCall<{ success: boolean; running: boolean }>('GET', 'control')
      if (!status.success || !status.running) throw new Error('Mihomo не запустился после обновления групп')
      await onRefreshConfigs()
      if (activeClashApiPort || activeClashApiUnix) await fetchClashProxies(activeClashApiPort ?? '', clashApiSecret, true, activeClashApiUnix ?? null)
      showToast('Узлы подписок подключены к группам')
      dispatch({ type: 'SET_SERVICE_STATUS', status: 'running' })
    } catch (error) {
      if (saved) {
        const rollback = await apiCall<{ success: boolean }>('PUT', 'configs?validate=mihomo', { file: config.file, content: config.savedContent }).catch(() => null)
        if (rollback?.success) await apiCall('POST', 'control', { action: 'hardRestart', core: 'mihomo' }).catch(() => null)
      }
      const status = await apiCall<{ success: boolean; running: boolean }>('GET', 'control').catch(() => null)
      dispatch({ type: 'SET_SERVICE_STATUS', status: status?.running ? 'running' : 'stopped' })
      showToast(error instanceof Error ? error.message : 'Не удалось подключить узлы к группам', 'error')
    }
  }

  const isMihomo = currentCore === 'mihomo' && (!!activeClashApiPort || !!activeClashApiUnix)
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768
  const usefulLinks = [
    { title: 'Инструкция панели', url: 'https://github.com/Fikisq/xkeen-csqtt#readme' },
    { title: 'Документация Xray', url: 'https://xtls.github.io/ru/config' },
  ]

  const activeRoutingDraft = routingDraft?.file === (isMihomo ? mihomoConfig?.file : xraySelectorsConfig?.file) ? routingDraft : null
  const routingUtilities = (<>
    {routingAutoSaving && <span className="text-muted-foreground text-xs" role="status" aria-live="polite">Применяется…</span>}
    <DropdownMenu>
    <DropdownMenuTrigger render={<Button size="sm" variant="outline" aria-label="Утилиты маршрутизации"><IconDotsFilled /></Button>} />
    <DropdownMenuContent align="end" className="min-w-60">
      <DropdownMenuGroup>
        <DropdownMenuItem onClick={onOpenBackups}><IconBox /> Резервные копии</DropdownMenuItem>
        <DropdownMenuItem onClick={onOpenGeoScan}><IconSearch /> Скан геофайлов</DropdownMenuItem>
      </DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenu></>)
  const routingToolbar = (<div className="border-border bg-input-background m-3 flex shrink-0 flex-wrap items-center gap-2 rounded-xl border p-3">
                  <Button size="sm" disabled={!activeRoutingDraft || routingSaving} onClick={() => { if (isMihomo) void commitMihomoRouting(); else if (xraySelectorsConfig) void applyXrayRoutingEdit(xraySelectorsConfig.file, content => content, 'Маршрутизация сохранена и применена', true) }}>{routingSaving ? 'Применение…' : 'Сохранить и применить'}</Button>
                  <Button size="sm" variant="outline" disabled={!activeRoutingDraft || routingSaving} onClick={() => setRoutingDraft(null)}>Отменить изменения</Button>
                  <span className="text-muted-foreground mr-auto text-xs" role="status">{activeRoutingDraft ? 'Есть неприменённые изменения' : 'Все изменения сохранены'}</span>
                  {routingUtilities}
                </div>
  )
  const deviceDraftToolbar = activeRoutingDraft && (<div className="border-border bg-input-background m-3 flex shrink-0 flex-wrap items-center gap-2 rounded-xl border p-3">
    <Button size="sm" disabled={routingSaving} onClick={() => { if (xraySelectorsConfig) void applyXrayRoutingEdit(xraySelectorsConfig.file, content => content, 'Маршрутизация сохранена и применена', true) }}>{routingSaving ? 'Применение…' : 'Сохранить и применить'}</Button>
    <Button size="sm" variant="outline" disabled={routingSaving} onClick={() => setRoutingDraft(null)}>Отменить изменения</Button>
    <span className="text-muted-foreground text-xs" role="status">Есть неприменённые изменения</span>
  </div>)

  return (
    <TooltipProvider delayDuration={500}>
      <>
        <div className="border-border bg-card flex flex-col overflow-hidden rounded-xl border md:min-h-0 md:flex-1">
          <div className={cn('flex shrink-0 flex-col gap-2 px-3 pt-3 sm:px-4 sm:pt-4 md:flex-row md:items-start')}>
            <div className="flex min-w-0 shrink-0 items-center gap-2">
              {isMihomo || hasXraySelectors ? (
                <div className="min-w-0 scrollbar-none overflow-x-auto md:overflow-x-visible [&::-webkit-scrollbar]:hidden">
                  <Tabs
                    value={currentPanel}
                    onValueChange={(value) => {
                      const panel = value as 'config' | 'selectors' | 'connections'
                      setActivePanel(panel)
                      setMountedPanels((prev) => (prev.has(panel) ? prev : new Set([...prev, panel])))
                    }}
                    className="w-max flex-row!"
                  >
                    <TabsList variant="line" className="mb-2 w-max shrink-0 gap-3 p-0 whitespace-nowrap md:mb-0">
                      <TabsTrigger value="selectors" className="p-0 text-sm font-semibold md:text-lg" disabled={!isRunning}>
                        {isMihomo ? 'Селекторы' : 'Маршрутизация'}
                      </TabsTrigger>
                      {isMihomo && (
                        <TabsTrigger value="connections" className="p-0 text-sm font-semibold md:text-lg" disabled={!isRunning}>
                          Соединения
                        </TabsTrigger>
                      )}
                      <TabsTrigger value="config" className="p-0 text-sm font-semibold md:text-lg" disabled={routingAutoSaving}>
                        Конфигурация
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                </div>
              ) : (
                <h2 className="shrink-0 text-lg font-semibold select-none">Конфигурация</h2>
              )}
            </div>

            {isMihomo && currentPanel === 'connections' && (
              <div className="ml-auto flex items-center gap-2">
                <span className="text-muted-foreground text-xs">Режим маршрутизации</span>
                <Select value={mode} items={{ direct: 'DIRECT', rule: 'RULE', global: 'GLOBAL' }} onValueChange={(value) => changeMode(value as ClashMode)}>
                  <SelectTrigger className="w-30">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="direct">DIRECT</SelectItem>
                      <SelectItem value="rule">RULE</SelectItem>
                      <SelectItem value="global">GLOBAL</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            )}

            {isMihomo && currentPanel === 'selectors' && (
              <div className="ml-auto flex items-center gap-1.5">
                <Button variant="outline" className="text-[13px]" onClick={() => window.dispatchEvent(new Event('mihomo:test-all'))}><IconBolt data-icon="inline-start" /> Пинг</Button>
                <Button variant="outline" className="text-[13px]" onClick={() => openProvidersModal('rules')}>
                  <IconListDetails data-icon="inline-start" />
                  Рулсеты
                </Button>
                <Tooltip>
                  <TooltipTrigger render={
                    <Button
                      variant="outline"
                      size="icon"
                      aria-label={allSelectorsCollapsed ? 'Развернуть все селекторы' : 'Свернуть все селекторы'}
                      onClick={() =>
                        window.dispatchEvent(new CustomEvent(TOGGLE_ALL_SELECTORS_EVENT, { detail: { collapsed: !allSelectorsCollapsed } }))
                      }
                    >
                      {allSelectorsCollapsed ? <IconChevronDown /> : <IconChevronUp />}
                    </Button>
                  } />
                  <TooltipContent>{allSelectorsCollapsed ? 'Развернуть все' : 'Свернуть все'}</TooltipContent>
                </Tooltip>
              </div>
            )}

            {(!(isMihomo || hasXraySelectors) || currentPanel === 'config') && (
              <div className="scrollbar-none overflow-x-auto overflow-y-hidden [-ms-overflow-style:none] md:ml-auto [&::-webkit-scrollbar]:hidden">
                {isConfigsLoading ? (
                  <div className="flex gap-2">
                    {[525, 310].map((w) => (
                      <Skeleton key={w} className="h-9 gap-0.5 rounded-lg p-0.75" style={{ width: w }} />
                    ))}
                  </div>
                ) : (
                  <Tabs
                    value={activeConfig?.file || ''}
                    onValueChange={(value) => {
                      const index = configs.findIndex((c) => c.file === value)
                      if (index >= 0) switchTab(index)
                    }}
                    className="flex-row!"
                  >
                    {coreConfigs.length > 0 && (
                      <TabsList className="shrink-0">
                        {coreConfigs.map((config) => (
                          <ConfigTab
                            key={config.file}
                            config={config}
                            currentCore={currentCore}
                            showToast={showToast}
                            onRefreshConfigs={refreshConfigsAndEditor}
                            withContextMenu
                          />
                        ))}
                      </TabsList>
                    )}
                    {xkeenConfigs.length > 0 && (
                      <TabsList className="shrink-0">
                        {xkeenConfigs.map((config) => (
                          <ConfigTab
                            key={config.file}
                            config={config}
                            currentCore={currentCore}
                            showToast={showToast}
                            onRefreshConfigs={refreshConfigsAndEditor}
                          />
                        ))}
                      </TabsList>
                    )}
                  </Tabs>
                )}
              </div>
            )}
            {xrayMigrationConfig && <Button variant="outline" className="text-[13px]" onClick={() => void applyXrayRoutingEdit(xrayMigrationConfig.file, enableXrayRoutingCards, 'Карточки Xray и маршрутизация для IP включены', true)}>Включить карточки Xray</Button>}
          </div>

          <div className={cn('relative', currentPanel === 'selectors' && (isMihomo || hasXraySelectors) ? '' : 'min-h-175! md:min-h-0 md:flex-1')}>
            {isMihomo && (
              <>
                {mountedPanels.has('selectors') && (
                  <div className={cn('flex flex-col', currentPanel !== 'selectors' && 'hidden')}>
                    {routingToolbar}
                    <div className={cn('relative min-h-0 flex-1', routingSaving && 'pointer-events-none opacity-60')}>
                    <LazyBoundary>
                      <SelectorsPanel
                        clashApiPort={(activeClashApiPort ?? '') as string}
                        mode={mode}
                        clashApiSecret={clashApiSecret ?? null}
                        clashApiUnix={activeClashApiUnix ?? null}
                        onCollapsedStateChange={setAllSelectorsCollapsed}
                        configContent={(routingDraft?.file === mihomoConfig?.file ? routingDraft?.content : mihomoConfig?.savedContent) ?? ''}
                        isDraft={!!activeRoutingDraft}
                        onSelectDraft={selectMihomoDraft}
                        onDeviceSelect={selectMihomoDevice}
                        onAddRoute={addMihomoRoute}
                        onRemoveRoute={removeMihomoRoute}
                        onEditResources={editMihomoResources}
                        onRenameRoute={renameMihomoRoute}
                        onReorderRoute={reorderMihomoRoute}
                      />
                    </LazyBoundary>
                    </div>
                  </div>
                )}
                {mountedPanels.has('connections') && (
                  <div className={cn(currentPanel !== 'connections' && 'hidden')}>
                    <LazyBoundary>
                      <ConnectionsPanel
                        clashApiPort={(activeClashApiPort ?? '') as string}
                        clashApiSecret={clashApiSecret ?? null}
                        clashApiUnix={activeClashApiUnix ?? null}
                      />
                    </LazyBoundary>
                  </div>
                )}
              </>
            )}

            {currentCore === 'xray' && hasXraySelectors && xraySelectorsConfig && currentPanel === 'selectors' && (
              <div className="flex flex-col">
                {deviceDraftToolbar}
                <div className={cn('relative min-h-0 flex-1', routingSaving && 'pointer-events-none opacity-60')}>
              <LazyBoundary>
                <XrayGlobalRoutingTable content={routingAutoPreview?.file === xraySelectorsConfig.file ? routingAutoPreview.content : routingDraft?.file === xraySelectorsConfig.file ? routingDraft.content : xraySelectorsConfig.savedContent} onChange={editGlobalRouting} onDeviceChange={editDeviceRouting} onError={message => showToast(message, 'error')} utilities={routingUtilities} />
                <section className="m-3"><LogPanel /></section>
              </LazyBoundary>
                </div>
              </div>
            )}

            {!isConfigsLoading && (!(isMihomo || hasXraySelectors) || mountedPanels.has('config')) && (
              <div
                className={cn(
                  'absolute inset-0',
                  (isMihomo || hasXraySelectors) && currentPanel !== 'config' && 'hidden'
                )}
              >
                <CodeMirrorEditorLazy
                  ref={editorRef}
                  onContentChange={handleContentChange}
                  onValidationChange={handleValidationChange}
                  onReady={handleEditorReady}
                  onSave={() => saveCurrentConfig()}
                />
              </div>
            )}
          </div>

          {(!(isMihomo || hasXraySelectors) || currentPanel === 'config') && (
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-1.5 px-3 pb-3 sm:px-4 sm:pb-4">
              <div className="min-w-0 text-xs">
                {isConfigsLoading ? (
                  <Skeleton className="h-4 w-30" />
                ) : validationState && activeConfig && isJsonOrYaml ? (
                  <span
                    className={cn(
                      'flex items-center gap-1.5 text-[13px] tracking-wide',
                      validationState.isValid ? 'text-green-400/90' : 'text-red-500'
                    )}
                  >
                    {validationState.isValid ? <IconCheck size={15} /> : <IconX size={15} />}
                    {validationState.isValid
                      ? `${fileLanguage?.toUpperCase()} валиден`
                      : `Ошибка: ${validationState.error || 'Файл невалиден'}`}
                  </span>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {isConfigsLoading ? (
                  <div className="flex gap-1.5">
                    {[120, 117, 96, 100].map((w) => (
                      <Skeleton key={w} className="h-9" style={{ width: w }} />
                    ))}
                  </div>
                ) : (
                  <>
                    <Tooltip>
                      <TooltipTrigger render={
                        <Button
                          size="default"
                          disabled={!canApply}
                          className="bg-green-600 text-white hover:bg-green-700"
                          onClick={() => saveAndApply()}
                        >
                          <IconRefresh data-icon="inline-start" /> Применить
                        </Button>
                      } />
                      <TooltipContent>Сохранить и перезапустить</TooltipContent>
                    </Tooltip>
                    <Button size="default" disabled={!canSave} onClick={() => saveCurrentConfig()}>
                      <IconDeviceFloppy data-icon="inline-start" /> Сохранить
                    </Button>
                    <Tooltip>
                      <TooltipTrigger render={
                        <Button variant="outline" disabled={!canFormat} onClick={() => editorRef.current?.format()}>
                          <IconCode data-icon="inline-start" /> <span className="hidden sm:inline">Формат</span>
                        </Button>
                      } />
                      <TooltipContent>Форматировать файл</TooltipContent>
                    </Tooltip>
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="outline"><IconDotsFilled data-icon="inline-start" /> <span className="hidden sm:inline">Утилиты</span></Button>} />
                      <DropdownMenuContent align="end" className="min-w-57">
                        <DropdownMenuGroup>
                          <DropdownMenuLabel>Утилиты</DropdownMenuLabel>
                          <DropdownMenuItem onClick={onOpenTemplate}>
                            <IconFileText /> Шаблоны конфигураций
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={onOpenBackups}>
                            <IconBox /> Бэкапы конфигураций
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={onOpenGeoScan}>
                            <IconSearch /> Скан геофайлов
                          </DropdownMenuItem>

                        </DropdownMenuGroup>
                        <DropdownMenuSeparator />
                        {isMobile ? (
                          <DropdownMenuGroup>
                            <DropdownMenuLabel>Полезные ссылки</DropdownMenuLabel>
                            {usefulLinks.map((link) => (
                              <DropdownMenuItem key={link.url} onClick={() => window.open(link.url, '_blank', 'noopener,noreferrer')}>
                                <IconExternalLinkFilled /> {link.title}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuGroup>
                        ) : (
                          <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                              <IconExternalLinkFilled /> Полезные ссылки
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent className="min-w-55">
                              {usefulLinks.map((link) => (
                                <DropdownMenuItem key={link.url} onClick={() => window.open(link.url, '_blank', 'noopener,noreferrer')}>
                                  <IconExternalLinkFilled /> {link.title}
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuSubContent>
                          </DropdownMenuSub>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
        {providersModalKind && mountProvidersModal && (
          <LazyBoundary>
            <ProvidersModal
              open={isProvidersModalOpen}
              kind={providersModalKind}
              clashApiPort={activeClashApiPort ?? ''}
              clashApiSecret={clashApiSecret ?? null}
              clashApiUnix={activeClashApiUnix ?? null}
              onOpenChange={handleProvidersModalOpenChange}
              onAddSubscription={onOpenImport}
              onConnectProviders={connectMihomoSubscriptions}
            />
          </LazyBoundary>
        )}
        <BackupsModalContainer onRefreshConfigs={refreshConfigsAndEditor} />
      </>
    </TooltipProvider>
  )
}


function hasCriticalChanges(oldContent: string, newContent: string, language: string): boolean {
  try {
    if (language === 'yaml') {
      const o = jsyaml.load(oldContent) as Record<string, unknown>
      const n = jsyaml.load(newContent) as Record<string, unknown>
      return ['listeners', 'redir-port', 'tproxy-port'].some((f) => JSON.stringify(o?.[f]) !== JSON.stringify(n?.[f]))
    }
    if (language === 'json') {
      const o = parseJsonc(oldContent)
      const n = parseJsonc(newContent)
      const clean = (arr: Record<string, unknown>[]) =>
        (arr || []).map((item) => Object.fromEntries(Object.entries(item).filter(([k]) => k !== 'sniffing')))
      return JSON.stringify(clean(o?.inbounds)) !== JSON.stringify(clean(n?.inbounds))
    }
  } catch {
    return false
  }
  return false
}

import {
  IconBrandDiscord,
  IconBrandGithub,
  IconBrandYoutube,
  IconDeviceGamepad2,
  IconSparkles,
  IconWorld,
} from '@tabler/icons-react'
import type { RouteTag } from '@/lib/xrayDeviceRouting'
import { customRouteName } from '@/lib/xrayDeviceRouting'

export const ROUTE_LABELS: Record<RouteTag, string> = {
  VPN: 'Селектор', Youtube: 'YouTube', Discord: 'Discord',
  Games: 'Игры', AI: 'Нейронки', Github: 'GitHub', RU: 'Российские сайты',
}

export function routeLabel(route: RouteTag): string { return ROUTE_LABELS[route] ?? customRouteName(route) }

export function RouteIcon({ route }: { route: RouteTag }) {
  const props = { size: 22, stroke: 1.8, 'aria-hidden': true as const }
  switch (route) {
    case 'VPN': return <IconWorld {...props} className="text-sky-400" />
    case 'Youtube': return <IconBrandYoutube {...props} className="text-red-500" />
    case 'Discord': return <IconBrandDiscord {...props} className="text-indigo-400" />
    case 'Games': return <IconDeviceGamepad2 {...props} className="text-violet-400" />
    case 'AI': return <IconSparkles {...props} className="text-fuchsia-400" />
    case 'Github': return <IconBrandGithub {...props} className="text-foreground" />
    case 'RU': return <IconWorld {...props} className="text-blue-400" />
    default: return <IconWorld {...props} className="text-sky-400" />
  }
}

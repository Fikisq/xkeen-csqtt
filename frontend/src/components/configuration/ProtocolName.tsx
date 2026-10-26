import { IconLockOpen, IconWorld } from '@tabler/icons-react'
import brokenShield from '@/assets/protocols/broken-shield.svg'

export function ProtocolName({ name, tag = '' }: { name: string; tag?: string }) {
  const value = `${tag} ${name}`.toLowerCase()
  const utility = /nfqws|zapret2/.test(value) ? 'nfqws' : /csqtt|wdtt/.test(value) ? 'reserve' : /^(direct|DIRECT|@direct)$/.test(tag) || name === 'direct' || name === 'Без VPN' ? 'direct' : null
  if (!utility) return <>{name}</>
  return <><span className="mr-1.5 inline-flex h-3.5 w-4.5 shrink-0 items-center justify-center align-[-2px] text-sky-300" aria-hidden="true">
    {utility === 'nfqws' ? <img src={brokenShield} alt="" className="h-3.5 w-4.5 object-contain" /> : utility === 'reserve' ? <IconLockOpen className="h-3.5 w-4.5" /> : <IconWorld className="h-3.5 w-4.5" />}
  </span>{name.replace(/^🔓\s*/, '')}</>
}

export function latencyTone(ms?: number, error?: string) {
  return error ? 'text-red-400' : ms === undefined ? 'text-foreground' : ms > 600 ? 'text-red-400' : ms > 300 ? 'text-amber-400' : 'text-emerald-400'
}

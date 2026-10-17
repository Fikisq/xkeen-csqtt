export interface PanelRelease {
  tag: string
  name: string
  prerelease: boolean
  publishedAt: string
  body: string
  url: string
}

export interface PanelReleasesResponse {
  success: boolean
  currentVersion: string
  releases: PanelRelease[]
  stale?: boolean
  error?: string
}

function version(value: string): { parts: number[]; prerelease: boolean } | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim())
  if (!match) return null
  const parts = match.slice(1, 4).map(Number)
  return parts.every(Number.isSafeInteger) ? { parts, prerelease: !!match[4] } : null
}

export function isNewStableRelease(release: PanelRelease, current: string): boolean {
  if (release.prerelease) return false
  const next = version(release.tag), installed = version(current)
  if (!next || next.prerelease || !installed) return false
  for (let index = 0; index < 3; index++) {
    if (next.parts[index] !== installed.parts[index]) return next.parts[index] > installed.parts[index]
  }
  return installed.prerelease
}

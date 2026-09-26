// Small built-in selection based on v2fly/domain-list-community.
// Domain lists are intentionally explicit: this panel does not require geosite.dat on the router.
export const ROUTE_PRESETS = [
  {
    name: 'YouTube',
    domains: ['youtube.com', 'youtu.be', 'youtube-nocookie.com', 'googlevideo.com', 'ytimg.com', 'ggpht.com', 'youtube.googleapis.com', 'youtubei.googleapis.com', 'youtubeeducation.com', 'youtubekids.com'],
  },
  {
    name: 'Discord',
    domains: ['discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net', 'discordcdn.com', 'discord.media', 'discordstatus.com', 'discord.gift'],
  },
  {
    name: 'Telegram',
    domains: ['telegram.org', 'telegram.me', 'telegram-cdn.org', 't.me', 'tdesktop.com', 'telegra.ph', 'telegram.space', 'telegram.dog', 'graph.org'],
  },
  {
    name: 'Нейронки',
    domains: ['openai.com', 'chatgpt.com', 'oaistatic.com', 'oaiusercontent.com', 'sora.com', 'anthropic.com', 'claude.ai', 'claude.com', 'claudeusercontent.com', 'gemini.google.com', 'gemini.gstatic.com', 'aistudio.google.com', 'generativelanguage.googleapis.com', 'notebooklm.google.com', 'perplexity.ai', 'perplexity.com', 'grok.com', 'x.ai', 'openrouter.ai', 'copilot.com', 'githubcopilot.com', 'huggingface.co', 'poe.com'],
  },
  {
    name: 'GitHub',
    domains: ['github.com', 'githubusercontent.com', 'githubassets.com', 'github.io', 'githubcopilot.com', 'github.dev', 'github.blog'],
  },
] as const

export function findRoutePresets(query: string) {
  const normalized = query.trim().toLowerCase()
  return normalized ? ROUTE_PRESETS.filter((preset) => preset.name.toLowerCase().includes(normalized) || preset.domains.some((domain) => domain.includes(normalized))) : ROUTE_PRESETS
}

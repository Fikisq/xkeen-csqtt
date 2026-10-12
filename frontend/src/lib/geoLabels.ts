const categoryNames: Record<string, string> = {
  'category-ru': 'Российские сайты', whitelist: 'Белый список', direct: 'Прямой доступ',
  private: 'Локальные сети', 'category-ru-all': 'Российские сайты',
  'category-ru-whitelist': 'Белый список РФ', ru: 'Россия', 'ru-banks': 'Банки РФ',
  youtube: 'YouTube', telegram: 'Telegram', openai: 'OpenAI', anthropic: 'Anthropic',
  perplexity: 'Perplexity', github: 'GitHub', 'category-ads': 'Реклама VK / Mail.ru',
}
export function geoCategoryLabel(category: string): string {
  return categoryNames[category.toLowerCase()] ?? category.toLowerCase()
}
export function geoDatabaseLabel(file: string): string {
  if (file.startsWith('roscomvpn-')) return `RoscomVPN · ${file.includes('geoip') ? 'IP' : 'домены'}`
  if (file.startsWith('ru-services-')) return `RU Resources · ${file.includes('geoip') ? 'IP' : 'домены'}`
  if (file === 'geosite.dat') return 'GeoSite · домены'
  if (file === 'geoip.dat') return 'GeoIP · IP'
  if (file === 'zkeenip.dat') return 'ZKeen · IP'
  return file.replace(/\.dat$/i, '')
}
export function resourceLabel(value: string): string {
  const external = /^ext:([^:]+):(.+)$/.exec(value)
  if (external) return `${geoDatabaseLabel(external[1]).split(' · ')[0]} · ${geoCategoryLabel(external[2])}`
  const standard = /^(geosite|geoip):(.+)$/.exec(value)
  if (standard) return `${standard[1] === 'geosite' ? 'GeoSite' : 'GeoIP'} · ${geoCategoryLabel(standard[2])}`
  return value.replace(/^(domain|full):/, '')
}

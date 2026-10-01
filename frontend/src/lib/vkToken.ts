// OAuth parameters used by amurcanov/csqtt 2.1.9 VkTokenScraper.
export const VK_AUTH_URL = 'https://oauth.vk.com/authorize?client_id=7793118&display=mobile&redirect_uri=https%3A%2F%2Foauth.vk.ru%2Fblank.html&response_type=token&scope=1073737727&v=5.199&revoke=1'

export function tokenFromVkRedirect(value: string): { token: string; expiresIn: number | null } {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('Вставьте полный адрес итоговой страницы VK из адресной строки') }
  if (url.protocol !== 'https:' || !['oauth.vk.com', 'oauth.vk.ru'].includes(url.hostname) || url.pathname !== '/blank.html') {
    throw new Error('Нужна итоговая ссылка https://oauth.vk.ru/blank.html#access_token=…')
  }
  const params = new URLSearchParams(url.hash.slice(1))
  if (params.has('error')) throw new Error('VK не выдал токен. Завершите вход или повторите авторизацию позже')
  const token = params.get('access_token') ?? ''
  if (!token || token.length > 4096 || !/^[A-Za-z0-9_.-]+$/.test(token)) throw new Error('В ссылке нет корректного access_token')
  const expires = params.get('expires_in')
  return { token, expiresIn: expires !== null && /^\d+$/.test(expires) ? Number(expires) : null }
}

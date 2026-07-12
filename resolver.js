'use strict'

const dns = require('dns').promises
const net = require('net')
const fetch = require('node-fetch')

class ResolverError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ResolverError'
  }
}

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(Number.isNaN)) return true
  const [a, b] = parts
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  )
}

function isPrivateIPv6(ip) {
  const value = ip.toLowerCase()
  return (
    value === '::1' ||
    value === '::' ||
    value.startsWith('fc') ||
    value.startsWith('fd') ||
    value.startsWith('fe8') ||
    value.startsWith('fe9') ||
    value.startsWith('fea') ||
    value.startsWith('feb') ||
    value.startsWith('::ffff:127.') ||
    value.startsWith('::ffff:10.') ||
    value.startsWith('::ffff:192.168.')
  )
}

async function assertSafePublicUrl(rawUrl) {
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new ResolverError('Link tidak valid.')
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ResolverError('Link harus memakai http:// atau https://.')
  }

  const hostname = parsed.hostname.toLowerCase()
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.local')) {
    throw new ResolverError('Alamat lokal tidak diperbolehkan.')
  }

  try {
    const addresses = await dns.lookup(hostname, { all: true, verbatim: true })
    for (const entry of addresses) {
      const family = net.isIP(entry.address)
      if ((family === 4 && isPrivateIPv4(entry.address)) || (family === 6 && isPrivateIPv6(entry.address))) {
        throw new ResolverError('Link menuju jaringan privat dan ditolak demi keamanan.')
      }
    }
  } catch (error) {
    if (error instanceof ResolverError) throw error
    throw new ResolverError('Domain video tidak dapat ditemukan.')
  }

  return parsed.toString()
}

function extractYouTubeId(rawUrl) {
  try {
    const url = new URL(rawUrl)
    const host = url.hostname.replace(/^www\./, '').toLowerCase()

    if (host === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0] || null
    if (host.endsWith('youtube.com')) {
      if (url.pathname === '/watch') return url.searchParams.get('v')
      const parts = url.pathname.split('/').filter(Boolean)
      if (['shorts', 'embed', 'live'].includes(parts[0])) return parts[1] || null
    }
  } catch {}
  return null
}

function isTikTokUrl(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./, '').toLowerCase()
    return host === 'tiktok.com' || host.endsWith('.tiktok.com')
  } catch {
    return false
  }
}

function collectUrlCandidates(value, path = '', results = []) {
  if (value == null) return results

  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) results.push({ url: value, path: path.toLowerCase() })
    return results
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectUrlCandidates(item, `${path}[${index}]`, results))
    return results
  }

  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      collectUrlCandidates(item, path ? `${path}.${key}` : key, results)
    }
  }

  return results
}

function scoreCandidate(candidate) {
  const path = candidate.path
  const url = candidate.url.toLowerCase()
  let score = 0

  if (/nowm|no_watermark|without_watermark/.test(path)) score += 100
  if (/video|play|download|hdplay|wmplay/.test(path)) score += 60
  if (/music|audio|cover|avatar|thumbnail|image/.test(path)) score -= 100
  if (/\.mp4(?:$|\?)/.test(url)) score += 50
  if (/\.m3u8(?:$|\?)/.test(url)) score += 30
  if (/tiktokcdn|byteoversea|muscdn|akamaized/.test(url)) score += 10
  return score
}

async function resolveTikTok(rawUrl) {
  const template = String(process.env.TIKTOK_API_URL || '').trim()
  const apiKey = String(process.env.TIKTOK_API_KEY || '').trim()

  if (!template) {
    throw new ResolverError(
      'Link TikTok memerlukan API resolver. Isi TIKTOK_API_URL dan TIKTOK_API_KEY di environment panel.'
    )
  }

  let apiUrl
  if (template.includes('{url}') || template.includes('{key}')) {
    apiUrl = template
      .replaceAll('{url}', encodeURIComponent(rawUrl))
      .replaceAll('{key}', encodeURIComponent(apiKey))
  } else {
    const parsed = new URL(template)
    parsed.searchParams.set('url', rawUrl)
    if (apiKey) parsed.searchParams.set('apikey', apiKey)
    apiUrl = parsed.toString()
  }

  let response
  try {
    response = await fetch(apiUrl, {
      headers: { accept: 'application/json' },
      timeout: 15000
    })
  } catch {
    throw new ResolverError('API TikTok tidak dapat dihubungi.')
  }

  if (!response.ok) {
    throw new ResolverError(`API TikTok gagal dengan status ${response.status}.`)
  }

  let data
  try {
    data = await response.json()
  } catch {
    throw new ResolverError('Respons API TikTok bukan JSON yang valid.')
  }

  const candidates = collectUrlCandidates(data)
    .sort((a, b) => scoreCandidate(b) - scoreCandidate(a))

  if (!candidates.length) {
    throw new ResolverError('API TikTok tidak mengembalikan link video yang dapat diputar.')
  }

  const directUrl = await assertSafePublicUrl(candidates[0].url)
  return {
    type: /\.m3u8(?:$|\?)/i.test(directUrl) ? 'hls' : 'video',
    url: directUrl,
    originalUrl: rawUrl,
    provider: 'tiktok'
  }
}

async function inspectDirectUrl(rawUrl) {
  const safeUrl = await assertSafePublicUrl(rawUrl)
  const pathname = new URL(safeUrl).pathname.toLowerCase()

  if (/\.(mp4|webm|ogg|mov|m4v)$/.test(pathname)) {
    return { type: 'video', url: safeUrl, provider: 'direct' }
  }
  if (/\.(m3u8)$/.test(pathname)) {
    return { type: 'hls', url: safeUrl, provider: 'direct' }
  }

  try {
    const response = await fetch(safeUrl, {
      method: 'HEAD',
      redirect: 'follow',
      timeout: 7000,
      headers: { 'user-agent': 'Mozilla/5.0 NobarBot/1.0' }
    })

    const contentType = String(response.headers.get('content-type') || '').toLowerCase()
    if (contentType.includes('application/vnd.apple.mpegurl') || contentType.includes('application/x-mpegurl')) {
      return { type: 'hls', url: safeUrl, provider: 'direct' }
    }
    if (contentType.startsWith('video/')) {
      return { type: 'video', url: safeUrl, provider: 'direct' }
    }
  } catch {}

  throw new ResolverError(
    'Link tersebut bukan YouTube, TikTok, MP4/WebM, atau HLS yang dapat dikenali.'
  )
}

async function resolveSource(input) {
  const raw = String(input || '').trim()
  if (!raw) throw new ResolverError('Sumber video kosong.')

  if (raw.startsWith('/media/')) {
    if (!/^\/media\/[a-zA-Z0-9._-]+$/.test(raw)) {
      throw new ResolverError('Path media lokal tidak valid.')
    }
    return { type: 'video', url: raw, provider: 'whatsapp' }
  }

  const youtubeId = extractYouTubeId(raw)
  if (youtubeId && /^[a-zA-Z0-9_-]{6,20}$/.test(youtubeId)) {
    return {
      type: 'youtube',
      videoId: youtubeId,
      url: raw,
      provider: 'youtube'
    }
  }

  if (isTikTokUrl(raw)) {
    return resolveTikTok(raw)
  }

  return inspectDirectUrl(raw)
}

module.exports = {
  ResolverError,
  resolveSource,
  extractYouTubeId,
  assertSafePublicUrl
}

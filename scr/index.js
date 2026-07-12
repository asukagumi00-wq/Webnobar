const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store'
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...headers }
  })
}

function error(message, status = 400) {
  return json({ ok: false, message }, status)
}

function safeText(value, max = 80) {
  return String(value ?? '')
    .replace(/[<>`\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function randomBlock(length = 4) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, byte => chars[byte % chars.length]).join('')
}

function randomToken() {
  return `NBR-${randomBlock()}-${randomBlock()}-${randomBlock()}`
}

function randomId(prefix = '') {
  return `${prefix}${crypto.randomUUID()}`
}

function getCookie(request, name) {
  const cookie = request.headers.get('cookie') || ''
  for (const part of cookie.split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key === name) return decodeURIComponent(value.join('='))
  }
  return ''
}

function parseYouTubeId(source) {
  try {
    const url = new URL(source)
    const host = url.hostname.replace(/^www\./, '')
    if (host === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0] || ''
    if (host.endsWith('youtube.com')) {
      if (url.searchParams.get('v')) return url.searchParams.get('v')
      const parts = url.pathname.split('/').filter(Boolean)
      const marker = parts.findIndex(part => ['shorts', 'embed', 'live'].includes(part))
      if (marker >= 0) return parts[marker + 1] || ''
    }
  } catch {}
  return ''
}

function parseTikTokId(source) {
  const match = String(source).match(/\/video\/(\d{8,30})/)
  return match?.[1] || ''
}

function resolveMedia(source) {
  const clean = String(source || '').trim()
  let parsed
  try {
    parsed = new URL(clean)
  } catch {
    throw new Error('Link video tidak valid.')
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Link harus menggunakan http atau https.')

  const youtubeId = parseYouTubeId(clean)
  if (youtubeId) {
    return {
      type: 'youtube',
      videoId: youtubeId,
      source: clean,
      title: `YouTube • ${youtubeId}`
    }
  }

  const tiktokId = parseTikTokId(clean)
  if (tiktokId) {
    return {
      type: 'tiktok',
      videoId: tiktokId,
      source: clean,
      title: `TikTok • ${tiktokId}`
    }
  }

  const pathname = parsed.pathname.toLowerCase()
  if (pathname.endsWith('.m3u8')) {
    return { type: 'hls', url: clean, source: clean, title: 'Video HLS' }
  }
  if (/\.(mp4|webm|ogg|mov|m4v)$/i.test(pathname)) {
    return { type: 'direct', url: clean, source: clean, title: 'Video langsung' }
  }

  if (/tiktok\.com$/i.test(parsed.hostname) || /tiktok\.com$/i.test(parsed.hostname.replace(/^www\./, ''))) {
    throw new Error('Gunakan link TikTok lengkap yang mengandung /video/ID, bukan link pendek vt.tiktok.com.')
  }

  throw new Error('Link belum didukung. Gunakan YouTube, TikTok lengkap, MP4/WebM, atau M3U8.')
}

function defaultState() {
  return {
    active: null,
    queue: [],
    tokens: {},
    auth: {},
    playback: { currentTime: 0, playing: false, updatedAt: Date.now() },
    chat: [],
    reactions: { '👍': 0, '❤️': 0, '😂': 0, '🔥': 0 },
    events: [],
    latestEventId: 0,
    publicUrl: ''
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/') || url.pathname === '/ws') {
      const id = env.NOBAR_ROOM.idFromName('global-room')
      const stub = env.NOBAR_ROOM.get(id)
      return stub.fetch(request)
    }
    return env.ASSETS.fetch(request)
  }
}

export class NobarRoom {
  constructor(ctx, env) {
    this.ctx = ctx
    this.env = env
    this.state = defaultState()
    this.ready = ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get('state')) || defaultState()
      this.cleanup()
    })
  }

  async persist() {
    await this.ctx.storage.put('state', this.state)
  }

  cleanup() {
    const now = Date.now()
    for (const [token, data] of Object.entries(this.state.tokens || {})) {
      if (!data || Number(data.expiresAt || 0) <= now) delete this.state.tokens[token]
    }
    for (const [id, data] of Object.entries(this.state.auth || {})) {
      if (!data || Number(data.expiresAt || 0) <= now) delete this.state.auth[id]
    }
    if (!Array.isArray(this.state.queue)) this.state.queue = []
    if (!Array.isArray(this.state.chat)) this.state.chat = []
    if (!Array.isArray(this.state.events)) this.state.events = []
    if (!this.state.reactions) this.state.reactions = { '👍': 0, '❤️': 0, '😂': 0, '🔥': 0 }
  }

  tokenTtlMs() {
    const minutes = Math.max(5, Math.min(1440, Number(this.env.NOBAR_TOKEN_TTL_MINUTES || 360)))
    return minutes * 60_000
  }

  sessionTtlMs() {
    const hours = Math.max(1, Math.min(24, Number(this.env.NOBAR_SESSION_MAX_HOURS || 6)))
    return hours * 3_600_000
  }

  requireBot(request) {
    const expected = String(this.env.NOBAR_BOT_SECRET || '')
    const received = String(request.headers.get('x-nobar-secret') || '')
    if (!expected) throw Object.assign(new Error('NOBAR_BOT_SECRET belum dipasang di Cloudflare.'), { status: 500 })
    if (!received || received !== expected) throw Object.assign(new Error('Secret bot salah atau tidak dikirim.'), { status: 401 })
  }

  createToken({ role, jid, name, sessionId }) {
    let token
    do token = randomToken()
    while (this.state.tokens[token])
    this.state.tokens[token] = {
      role,
      jid: String(jid || ''),
      name: safeText(name, 24) || (role === 'host' ? 'Host' : 'Penonton'),
      sessionId,
      expiresAt: Date.now() + this.tokenTtlMs()
    }
    return token
  }

  publicSession(session = this.state.active) {
    if (!session) return null
    return {
      id: session.id,
      requesterJid: session.requesterJid,
      requesterName: session.requesterName,
      hostName: session.requesterName,
      chatJid: session.chatJid,
      title: session.title,
      media: session.media,
      createdAt: session.createdAt
    }
  }

  publicStatus() {
    return {
      ok: true,
      active: this.publicSession(),
      queueLength: this.state.queue.length,
      viewers: this.ctx.getWebSockets().length
    }
  }

  queueStatus() {
    return this.state.queue.map((item, index) => ({
      requesterJid: item.requesterJid,
      requesterName: item.requesterName,
      title: item.title,
      position: index + 1
    }))
  }

  addEvent(event) {
    const id = ++this.state.latestEventId
    this.state.events.push({ id, at: Date.now(), ...event })
    if (this.state.events.length > 100) this.state.events = this.state.events.slice(-100)
  }

  beginSession(session, createEvent = false) {
    this.state.active = session
    this.state.playback = { currentTime: 0, playing: false, updatedAt: Date.now() }
    this.state.chat = []
    this.state.reactions = { '👍': 0, '❤️': 0, '😂': 0, '🔥': 0 }
    this.state.tokens = {}
    this.state.auth = {}
    const hostToken = this.createToken({
      role: 'host',
      jid: session.requesterJid,
      name: session.requesterName,
      sessionId: session.id
    })
    if (createEvent) {
      this.addEvent({
        type: 'session-started',
        session: this.publicSession(session),
        hostToken,
        publicUrl: this.state.publicUrl
      })
    }
    return hostToken
  }

  async endSession(reason = 'ended') {
    if (!this.state.active) return { ended: null, promoted: null }
    const ended = this.publicSession()
    this.broadcast('room:ended', { reason })
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.close(1000, 'Sesi berakhir') } catch {}
    }

    this.state.active = null
    this.state.tokens = {}
    this.state.auth = {}
    this.state.playback = { currentTime: 0, playing: false, updatedAt: Date.now() }
    this.state.chat = []
    this.state.reactions = { '👍': 0, '❤️': 0, '😂': 0, '🔥': 0 }

    let promoted = null
    if (this.state.queue.length) {
      promoted = this.state.queue.shift()
      this.beginSession(promoted, true)
    }
    await this.persist()
    return { ended, promoted: promoted ? this.publicSession(promoted) : null }
  }

  getAuth(request) {
    const id = getCookie(request, 'nobar_session')
    if (!id) return null
    const auth = this.state.auth[id]
    if (!auth || auth.expiresAt <= Date.now()) {
      if (auth) delete this.state.auth[id]
      return null
    }
    if (!this.state.active || auth.sessionId !== this.state.active.id) return null
    return { id, ...auth }
  }

  broadcast(event, data) {
    const payload = JSON.stringify({ event, data })
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(payload) } catch {}
    }
  }

  snapshot() {
    return {
      session: this.publicSession(),
      playback: this.state.playback,
      chat: this.state.chat,
      reactions: this.state.reactions,
      viewers: this.ctx.getWebSockets().length
    }
  }

  async readJson(request) {
    try {
      return await request.json()
    } catch {
      throw Object.assign(new Error('Body JSON tidak valid.'), { status: 400 })
    }
  }

  async fetch(request) {
    await this.ready
    this.cleanup()
    const url = new URL(request.url)
    this.state.publicUrl = url.origin

    try {
      if (url.pathname === '/api/status' && request.method === 'GET') {
        return json(this.publicStatus())
      }

      if (url.pathname === '/api/auth' && request.method === 'POST') {
        if (!this.state.active) return error('Belum ada sesi nobar aktif.', 404)
        const body = await this.readJson(request)
        const token = String(body.token || '').trim().toUpperCase()
        const tokenData = this.state.tokens[token]
        if (!tokenData || tokenData.expiresAt <= Date.now()) return error('Token tidak valid atau sudah digunakan.', 401)
        if (tokenData.sessionId !== this.state.active.id) return error('Token berasal dari sesi yang sudah berakhir.', 401)

        delete this.state.tokens[token]
        const authId = randomId('ses_')
        this.state.auth[authId] = {
          role: tokenData.role,
          jid: tokenData.jid,
          name: tokenData.name,
          sessionId: tokenData.sessionId,
          expiresAt: Date.now() + this.sessionTtlMs()
        }
        await this.persist()
        return json(
          { ok: true, user: this.state.auth[authId] },
          200,
          {
            'set-cookie': `nobar_session=${encodeURIComponent(authId)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(this.sessionTtlMs() / 1000)}`
          }
        )
      }

      if (url.pathname === '/api/me' && request.method === 'GET') {
        const auth = this.getAuth(request)
        if (!auth) return error('unauthorized', 401)
        return json({ ok: true, user: auth })
      }

      if (url.pathname === '/api/logout' && request.method === 'POST') {
        const auth = this.getAuth(request)
        if (auth) delete this.state.auth[auth.id]
        await this.persist()
        return json(
          { ok: true },
          200,
          { 'set-cookie': 'nobar_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' }
        )
      }

      if (url.pathname === '/ws') {
        if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return error('WebSocket upgrade diperlukan.', 426)
        const auth = this.getAuth(request)
        if (!auth) return error('unauthorized', 401)
        const pair = new WebSocketPair()
        const client = pair[0]
        const server = pair[1]
        server.serializeAttachment({ authId: auth.id })
        this.ctx.acceptWebSocket(server)
        server.send(JSON.stringify({ event: 'room:snapshot', data: this.snapshot() }))
        queueMicrotask(() => this.broadcast('presence:update', { viewers: this.ctx.getWebSockets().length }))
        return new Response(null, { status: 101, webSocket: client })
      }

      if (url.pathname.startsWith('/api/bot/')) {
        this.requireBot(request)

        if (url.pathname === '/api/bot/status' && request.method === 'GET') {
          return json({
            ok: true,
            active: this.publicSession(),
            queue: this.queueStatus(),
            viewers: this.ctx.getWebSockets().length,
            latestEventId: this.state.latestEventId
          })
        }

        if (url.pathname === '/api/bot/events' && request.method === 'GET') {
          const after = Number(url.searchParams.get('after') || 0)
          return json({
            ok: true,
            events: this.state.events.filter(event => event.id > after),
            latestEventId: this.state.latestEventId
          })
        }

        if (url.pathname === '/api/bot/enqueue' && request.method === 'POST') {
          const body = await this.readJson(request)
          const requesterJid = String(body.requesterJid || '')
          if (!requesterJid) return error('requesterJid wajib diisi.')
          if (this.state.active?.requesterJid === requesterJid) return error('Kamu sedang menjadi host sesi nobar yang aktif.', 409)
          if (this.state.queue.some(item => item.requesterJid === requesterJid)) return error('Kamu sudah berada di antrean nobar.', 409)

          let media
          try { media = resolveMedia(body.source) }
          catch (err) { return error(err.message) }

          const session = {
            id: randomId('room_'),
            requesterJid,
            requesterName: safeText(body.requesterName, 24) || 'Host',
            chatJid: String(body.chatJid || ''),
            title: safeText(body.title, 100) || media.title,
            media,
            createdAt: Date.now()
          }

          if (!this.state.active) {
            const hostToken = this.beginSession(session, false)
            await this.persist()
            return json({
              ok: true,
              status: 'active',
              session: this.publicSession(session),
              hostToken,
              publicUrl: this.state.publicUrl
            })
          }

          this.state.queue.push(session)
          await this.persist()
          return json({
            ok: true,
            status: 'queued',
            position: this.state.queue.length,
            active: this.publicSession(),
            publicUrl: this.state.publicUrl
          })
        }

        if (url.pathname === '/api/bot/join-token' && request.method === 'POST') {
          if (!this.state.active) return error('Belum ada sesi nobar aktif.', 404)
          const body = await this.readJson(request)
          const name = safeText(body.name, 24)
          if (name.length < 2) return error('Nama minimal 2 karakter.')
          const token = this.createToken({
            role: 'viewer',
            jid: body.jid,
            name,
            sessionId: this.state.active.id
          })
          await this.persist()
          return json({
            ok: true,
            token,
            publicUrl: this.state.publicUrl,
            session: this.publicSession()
          })
        }

        if (url.pathname === '/api/bot/host-token' && request.method === 'POST') {
          if (!this.state.active) return error('Belum ada sesi nobar aktif.', 404)
          const body = await this.readJson(request)
          if (!body.forceOwner && String(body.jid || '') !== this.state.active.requesterJid) {
            return error('Kamu bukan host sesi aktif.', 403)
          }
          const token = this.createToken({
            role: 'host',
            jid: body.jid,
            name: safeText(body.name, 24) || this.state.active.requesterName,
            sessionId: this.state.active.id
          })
          await this.persist()
          return json({ ok: true, token, publicUrl: this.state.publicUrl, session: this.publicSession() })
        }

        if (url.pathname === '/api/bot/revoke' && request.method === 'POST') {
          const body = await this.readJson(request)
          delete this.state.tokens[String(body.token || '').trim().toUpperCase()]
          await this.persist()
          return json({ ok: true })
        }

        if (url.pathname === '/api/bot/end' && request.method === 'POST') {
          const body = await this.readJson(request)
          const result = await this.endSession(safeText(body.reason, 50) || 'ended-by-bot')
          return json({ ok: true, ...result })
        }

        if (url.pathname === '/api/bot/cancel' && request.method === 'POST') {
          const body = await this.readJson(request)
          const jid = String(body.jid || '')
          const index = this.state.queue.findIndex(item => item.requesterJid === jid)
          if (index < 0) return error('Kamu tidak berada di antrean.', 404)
          const [removed] = this.state.queue.splice(index, 1)
          await this.persist()
          return json({ ok: true, removed: this.publicSession(removed) })
        }

        if (url.pathname === '/api/bot/upload') {
          return error('Upload video WhatsApp belum tersedia pada Worker gratis. Gunakan link YouTube, TikTok lengkap, MP4, atau M3U8.', 501)
        }
      }

      return error('Endpoint tidak ditemukan.', 404)
    } catch (err) {
      console.error(err)
      return error(err?.message || 'Server error.', Number(err?.status || 500))
    }
  }

  async webSocketMessage(ws, rawMessage) {
    await this.ready
    let payload
    try { payload = JSON.parse(typeof rawMessage === 'string' ? rawMessage : new TextDecoder().decode(rawMessage)) }
    catch { return }

    const attachment = ws.deserializeAttachment?.() || {}
    const auth = this.state.auth[attachment.authId]
    if (!auth || !this.state.active || auth.sessionId !== this.state.active.id) {
      try { ws.close(1008, 'unauthorized') } catch {}
      return
    }

    if (payload.type === 'chat') {
      const text = safeText(payload.text, 220)
      if (!text) return
      const message = {
        id: randomId('msg_'),
        name: auth.name,
        role: auth.role,
        text,
        at: Date.now()
      }
      this.state.chat.push(message)
      if (this.state.chat.length > 100) this.state.chat = this.state.chat.slice(-100)
      await this.persist()
      this.broadcast('chat:new', message)
      return
    }

    if (payload.type === 'reaction') {
      const emoji = ['👍', '❤️', '😂', '🔥'].includes(payload.emoji) ? payload.emoji : ''
      if (!emoji) return
      this.state.reactions[emoji] = Number(this.state.reactions[emoji] || 0) + 1
      await this.persist()
      this.broadcast('reaction:new', { emoji, totals: this.state.reactions })
      return
    }

    if (payload.type === 'playback' && auth.role === 'host') {
      const currentTime = Math.max(0, Math.min(24 * 3600, Number(payload.currentTime || 0)))
      this.state.playback = {
        currentTime,
        playing: Boolean(payload.playing),
        updatedAt: Date.now()
      }
      await this.persist()
      this.broadcast('player:update', this.state.playback)
      return
    }

    if (payload.type === 'session:end' && auth.role === 'host') {
      await this.endSession('ended-by-host')
    }
  }

  async webSocketClose() {
    queueMicrotask(() => this.broadcast('presence:update', { viewers: this.ctx.getWebSockets().length }))
  }

  async webSocketError() {
    queueMicrotask(() => this.broadcast('presence:update', { viewers: this.ctx.getWebSockets().length }))
  }
}

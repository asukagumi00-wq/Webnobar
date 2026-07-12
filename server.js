'use strict'

if (global.__HANA_NOBAR_SERVER__) {
  module.exports = global.__HANA_NOBAR_SERVER__
} else {
  try {
    require('dotenv').config()
  } catch {}

  const crypto = require('crypto')
  const fs = require('fs')
  const path = require('path')
  const express = require('express')
  const { createServer } = require('http')
  const { Server } = require('socket.io')
  const { resolveSource } = require('./resolver')

  const ROOT = __dirname
  const PUBLIC_DIR = path.join(ROOT, 'public')
  const DATA_DIR = path.join(ROOT, 'data')
  const MEDIA_DIR = path.join(PUBLIC_DIR, 'media')
  const STATE_FILE = path.join(DATA_DIR, 'state.json')

  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.mkdirSync(MEDIA_DIR, { recursive: true })

  function freshState() {
    return {
      version: 1,
      active: null,
      queue: [],
      tokens: {},
      accessSessions: {},
      botEvents: [],
      nextEventId: 1,
      updatedAt: Date.now()
    }
  }

  function loadState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
      return { ...freshState(), ...parsed }
    } catch {
      return freshState()
    }
  }

  let state = loadState()
  let saveTimer = null
  let notifier = async () => {}
  let httpServer = null
  let io = null
  let started = false
  let startingPromise = null
  const socketsBySession = new Map()
  const rateLimits = new Map()

  function scheduleSave() {
    state.updatedAt = Date.now()
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      const temp = `${STATE_FILE}.tmp`
      try {
        fs.writeFileSync(temp, JSON.stringify(state, null, 2))
        fs.renameSync(temp, STATE_FILE)
      } catch (error) {
        console.error('[NOBAR] Gagal menyimpan state:', error.message)
      }
    }, 150)
  }


  function pushBotEvent(event) {
    const id = Number(state.nextEventId || 1)
    state.nextEventId = id + 1
    state.botEvents = Array.isArray(state.botEvents) ? state.botEvents : []
    state.botEvents.push({ id, at: Date.now(), ...event })
    state.botEvents = state.botEvents.slice(-100)
    scheduleSave()
    return id
  }

  function safeSecretEqual(a, b) {
    const left = Buffer.from(String(a || ''))
    const right = Buffer.from(String(b || ''))
    return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right)
  }

  function requireBot(req, res, next) {
    const expected = String(process.env.NOBAR_BOT_SECRET || '')
    const provided = String(req.get('x-nobar-secret') || '')
    if (!expected || !safeSecretEqual(expected, provided)) {
      return res.status(401).json({ ok: false, message: 'Akses bot ditolak.' })
    }
    next()
  }

  function getPort() {
    return Number(process.env.PORT || process.env.NOBAR_PORT || 3000)
  }

  function getPublicUrl() {
    return String(process.env.NOBAR_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${getPort()}`)
      .replace(/\/+$/, '')
  }

  function randomId(prefix = '') {
    return `${prefix}${crypto.randomBytes(10).toString('hex')}`
  }

  function makeReadableToken() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    const bytes = crypto.randomBytes(12)
    let value = ''
    for (let i = 0; i < 12; i++) value += alphabet[bytes[i] % alphabet.length]
    return `NBR-${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8, 12)}`
  }

  function normalizeToken(token) {
    return String(token || '').trim().toUpperCase().replace(/\s+/g, '')
  }

  function hashToken(token) {
    return crypto.createHash('sha256').update(normalizeToken(token)).digest('hex')
  }

  function safeName(name) {
    return String(name || '')
      .replace(/[<>`]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 24)
  }

  function currentPlayback(playback) {
    if (!playback) return { playing: false, currentTime: 0, updatedAt: Date.now(), revision: 0 }
    let currentTime = Number(playback.currentTime) || 0
    if (playback.playing) currentTime += Math.max(0, Date.now() - playback.updatedAt) / 1000
    return { ...playback, currentTime, updatedAt: Date.now() }
  }

  function cleanExpired() {
    const now = Date.now()
    let changed = false

    for (const [hash, token] of Object.entries(state.tokens)) {
      if (token.expiresAt <= now || (token.used && token.usedAt && token.usedAt + 10 * 60 * 1000 <= now)) {
        delete state.tokens[hash]
        changed = true
      }
    }

    for (const [sid, access] of Object.entries(state.accessSessions)) {
      if (access.expiresAt <= now || !state.active || access.sessionId !== state.active.id) {
        delete state.accessSessions[sid]
        changed = true
      }
    }

    const maxHours = Math.max(1, Number(process.env.NOBAR_SESSION_MAX_HOURS || 6))
    if (state.active && state.active.startedAt + maxHours * 60 * 60 * 1000 <= now) {
      endActiveSession('expired').catch(console.error)
    }

    if (changed) scheduleSave()
  }

  function invalidateSessionAuth(sessionId) {
    for (const [hash, token] of Object.entries(state.tokens)) {
      if (token.sessionId === sessionId) delete state.tokens[hash]
    }
    for (const [sid, access] of Object.entries(state.accessSessions)) {
      if (access.sessionId === sessionId) delete state.accessSessions[sid]
    }
  }

  function issueToken({ sessionId, jid, name, role }) {
    const token = makeReadableToken()
    const tokenHash = hashToken(token)
    const ttlMinutes = Math.max(15, Number(process.env.NOBAR_TOKEN_TTL_MINUTES || 360))

    for (const [hash, existing] of Object.entries(state.tokens)) {
      if (
        existing.sessionId === sessionId &&
        existing.jid === jid &&
        existing.role === role &&
        !existing.used
      ) {
        delete state.tokens[hash]
      }
    }

    state.tokens[tokenHash] = {
      sessionId,
      jid,
      name: safeName(name) || 'Penonton',
      role: role === 'host' ? 'host' : 'viewer',
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlMinutes * 60 * 1000,
      used: false
    }
    scheduleSave()
    return token
  }

  function revokeToken(token) {
    const hash = hashToken(token)
    if (state.tokens[hash]) {
      delete state.tokens[hash]
      scheduleSave()
      return true
    }
    return false
  }

  function createAccessFromToken(rawToken) {
    cleanExpired()
    const tokenHash = hashToken(rawToken)
    const record = state.tokens[tokenHash]

    if (!record || record.used || record.expiresAt <= Date.now()) {
      throw new Error('Token tidak valid, sudah dipakai, atau kedaluwarsa.')
    }
    if (!state.active || record.sessionId !== state.active.id) {
      throw new Error('Sesi untuk token ini sudah berakhir.')
    }

    const sid = randomId('sid_')
    record.used = true
    record.usedAt = Date.now()
    state.accessSessions[sid] = {
      sessionId: record.sessionId,
      jid: record.jid,
      name: record.name,
      role: record.role,
      createdAt: Date.now(),
      expiresAt: Math.min(record.expiresAt, state.active.expiresAt)
    }
    scheduleSave()
    return { sid, access: state.accessSessions[sid] }
  }

  function parseCookies(header) {
    const output = {}
    for (const pair of String(header || '').split(';')) {
      const index = pair.indexOf('=')
      if (index < 0) continue
      const key = pair.slice(0, index).trim()
      const value = pair.slice(index + 1).trim()
      if (key) output[key] = decodeURIComponent(value)
    }
    return output
  }

  function getAccessFromRequest(req) {
    cleanExpired()
    const sid = parseCookies(req.headers.cookie).nobar_sid
    if (!sid) return null
    const access = state.accessSessions[sid]
    if (!access || !state.active || access.sessionId !== state.active.id) return null
    return { sid, ...access }
  }

  function sanitizeQueueItem(item) {
    return {
      id: item.id,
      requesterJid: item.requesterJid,
      requesterName: safeName(item.requesterName) || 'Host',
      chatJid: item.chatJid,
      title: safeName(item.title) || 'Nobar tanpa judul',
      media: item.media,
      createdAt: item.createdAt
    }
  }

  function makeSession(item) {
    const maxHours = Math.max(1, Number(process.env.NOBAR_SESSION_MAX_HOURS || 6))
    const now = Date.now()
    return {
      id: randomId('room_'),
      requesterJid: item.requesterJid,
      requesterName: safeName(item.requesterName) || 'Host',
      chatJid: item.chatJid,
      title: safeName(item.title) || 'Nobar tanpa judul',
      media: item.media,
      createdAt: item.createdAt || now,
      startedAt: now,
      expiresAt: now + maxHours * 60 * 60 * 1000,
      playback: {
        playing: false,
        currentTime: 0,
        updatedAt: now,
        revision: 0
      },
      chat: [],
      reactions: { '👍': 0, '❤️': 0, '😂': 0, '🔥': 0 }
    }
  }

  async function activateItem(item, shouldNotify) {
    const session = makeSession(item)
    state.active = session
    scheduleSave()
    const hostToken = issueToken({
      sessionId: session.id,
      jid: session.requesterJid,
      name: session.requesterName,
      role: 'host'
    })

    if (io) io.emit('lobby:update', publicStatus())

    if (shouldNotify) {
      const event = {
        type: 'session-started',
        session: publicSessionForBot(session),
        hostToken,
        publicUrl: getPublicUrl()
      }
      pushBotEvent(event)
      await notifier(event).catch(error => console.error('[NOBAR] Notifier gagal:', error.message))
    }

    return { session, hostToken }
  }

  async function enqueueSession({ requesterJid, requesterName, chatJid, title, source }) {
    cleanExpired()
    if (!requesterJid || !chatJid) throw new Error('Identitas pemanggil atau chat tidak tersedia.')

    if (state.active && state.active.requesterJid === requesterJid) {
      throw new Error('Kamu sedang menjadi host sesi nobar yang aktif.')
    }
    if (state.queue.some(item => item.requesterJid === requesterJid)) {
      throw new Error('Kamu sudah berada di antrean nobar.')
    }

    const media = await resolveSource(source)
    const item = sanitizeQueueItem({
      id: randomId('queue_'),
      requesterJid,
      requesterName,
      chatJid,
      title: title || inferTitle(media),
      media,
      createdAt: Date.now()
    })

    if (!state.active) {
      const startedResult = await activateItem(item, false)
      return {
        status: 'started',
        session: publicSessionForBot(startedResult.session),
        hostToken: startedResult.hostToken,
        publicUrl: getPublicUrl()
      }
    }

    state.queue.push(item)
    scheduleSave()
    if (io) io.emit('lobby:update', publicStatus())
    return {
      status: 'queued',
      position: state.queue.length,
      active: publicSessionForBot(state.active),
      publicUrl: getPublicUrl()
    }
  }

  function inferTitle(media) {
    if (media.provider === 'youtube') return `YouTube • ${media.videoId}`
    if (media.provider === 'tiktok') return 'Video TikTok'
    if (media.provider === 'whatsapp') return 'Video WhatsApp'
    return media.type === 'hls' ? 'Live/HLS Stream' : 'Video MP4'
  }

  function publicSessionForBot(session) {
    if (!session) return null
    return {
      id: session.id,
      requesterJid: session.requesterJid,
      requesterName: session.requesterName,
      chatJid: session.chatJid,
      title: session.title,
      mediaType: session.media.type,
      provider: session.media.provider,
      startedAt: session.startedAt,
      expiresAt: session.expiresAt
    }
  }

  function publicStatus() {
    return {
      active: state.active
        ? {
            id: state.active.id,
            title: state.active.title,
            hostName: state.active.requesterName,
            provider: state.active.media.provider,
            startedAt: state.active.startedAt,
            viewers: getViewerCount(state.active.id)
          }
        : null,
      queueLength: state.queue.length
    }
  }

  function getStatusForBot() {
    return {
      active: publicSessionForBot(state.active),
      viewers: state.active ? getViewerCount(state.active.id) : 0,
      queue: state.queue.map((item, index) => ({
        position: index + 1,
        requesterJid: item.requesterJid,
        requesterName: item.requesterName,
        chatJid: item.chatJid,
        title: item.title,
        provider: item.media.provider,
        createdAt: item.createdAt
      }))
    }
  }

  function createJoinToken({ jid, name }) {
    cleanExpired()
    if (!state.active) throw new Error('Belum ada sesi nobar yang aktif.')
    const cleanName = safeName(name)
    if (cleanName.length < 2) throw new Error('Nama nobar minimal 2 karakter.')
    return {
      token: issueToken({
        sessionId: state.active.id,
        jid,
        name: cleanName,
        role: 'viewer'
      }),
      publicUrl: getPublicUrl(),
      session: publicSessionForBot(state.active)
    }
  }

  function createHostToken({ jid, name, forceOwner = false }) {
    cleanExpired()
    if (!state.active) throw new Error('Belum ada sesi nobar yang aktif.')
    if (!forceOwner && state.active.requesterJid !== jid) {
      throw new Error('Hanya host sesi aktif atau owner bot yang dapat mengambil token host.')
    }
    return {
      token: issueToken({
        sessionId: state.active.id,
        jid,
        name: safeName(name) || state.active.requesterName,
        role: 'host'
      }),
      publicUrl: getPublicUrl(),
      session: publicSessionForBot(state.active)
    }
  }

  function localMediaPath(media) {
    if (!media || media.provider !== 'whatsapp' || !media.url.startsWith('/media/')) return null
    const filename = path.basename(media.url)
    return path.join(MEDIA_DIR, filename)
  }

  function scheduleLocalMediaDelete(media) {
    const file = localMediaPath(media)
    if (!file) return
    setTimeout(() => fs.promises.unlink(file).catch(() => {}), 60_000).unref?.()
  }

  async function promoteNext() {
    if (state.active || !state.queue.length) return null
    const next = state.queue.shift()
    scheduleSave()
    return activateItem(next, true)
  }

  async function endActiveSession(reason = 'ended') {
    if (!state.active) return { ended: null, next: null }

    const ended = state.active
    const roomName = `session:${ended.id}`
    state.active = null
    invalidateSessionAuth(ended.id)
    scheduleLocalMediaDelete(ended.media)
    scheduleSave()

    if (io) {
      io.to(roomName).emit('room:ended', { reason })
      io.emit('lobby:update', publicStatus())
    }

    const endedEvent = {
      type: 'session-ended',
      reason,
      session: publicSessionForBot(ended)
    }
    pushBotEvent(endedEvent)
    await notifier(endedEvent).catch(() => {})

    const next = await promoteNext()
    return { ended: publicSessionForBot(ended), next: next ? publicSessionForBot(next.session) : null }
  }

  async function cancelOwnQueue(jid) {
    const index = state.queue.findIndex(item => item.requesterJid === jid)
    if (index < 0) throw new Error('Kamu tidak berada di antrean nobar.')
    const [removed] = state.queue.splice(index, 1)
    scheduleLocalMediaDelete(removed.media)
    scheduleSave()
    if (io) io.emit('lobby:update', publicStatus())
    return removed
  }

  function getViewerCount(sessionId) {
    return socketsBySession.get(sessionId)?.size || 0
  }

  function roomSnapshot(access) {
    if (!state.active) return null
    return {
      session: {
        id: state.active.id,
        title: state.active.title,
        hostName: state.active.requesterName,
        media: state.active.media,
        startedAt: state.active.startedAt
      },
      user: {
        name: access.name,
        role: access.role
      },
      playback: currentPlayback(state.active.playback),
      chat: state.active.chat.slice(-100),
      reactions: state.active.reactions,
      viewers: getViewerCount(state.active.id)
    }
  }

  function checkRate(socket, key, intervalMs) {
    const id = `${socket.id}:${key}`
    const now = Date.now()
    const previous = rateLimits.get(id) || 0
    if (now - previous < intervalMs) return false
    rateLimits.set(id, now)
    return true
  }

  function emitPresence(sessionId) {
    if (!io) return
    io.to(`session:${sessionId}`).emit('presence:update', {
      viewers: getViewerCount(sessionId)
    })
  }

  function securityHeaders(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    next()
  }

  async function startServer() {
    if (started) return api
    if (startingPromise) return startingPromise

    startingPromise = new Promise((resolve, reject) => {
      const app = express()
      app.disable('x-powered-by')
      app.use(securityHeaders)

      app.get('/health', (req, res) => res.json({ ok: true, service: 'nobar', active: Boolean(state.active) }))

      app.post('/api/bot/upload', requireBot, express.raw({ type: 'application/octet-stream', limit: '150mb' }), async (req, res) => {
        try {
          if (!Buffer.isBuffer(req.body) || !req.body.length) throw new Error('Video kosong.')
          const filename = `wa-${Date.now()}-${crypto.randomBytes(5).toString('hex')}.mp4`
          await fs.promises.writeFile(path.join(MEDIA_DIR, filename), req.body)
          res.json({ ok: true, source: `/media/${filename}` })
        } catch (error) {
          res.status(400).json({ ok: false, message: error.message })
        }
      })

      app.use(express.json({ limit: '64kb' }))

      app.post('/api/bot/enqueue', requireBot, async (req, res) => {
        try {
          const result = await enqueueSession(req.body || {})
          res.json({ ok: true, ...result })
        } catch (error) {
          res.status(400).json({ ok: false, message: error.message })
        }
      })

      app.post('/api/bot/join-token', requireBot, (req, res) => {
        try {
          res.json({ ok: true, ...createJoinToken(req.body || {}) })
        } catch (error) {
          res.status(400).json({ ok: false, message: error.message })
        }
      })

      app.post('/api/bot/host-token', requireBot, (req, res) => {
        try {
          res.json({ ok: true, ...createHostToken(req.body || {}) })
        } catch (error) {
          res.status(400).json({ ok: false, message: error.message })
        }
      })

      app.post('/api/bot/revoke', requireBot, (req, res) => {
        res.json({ ok: true, revoked: revokeToken(req.body?.token) })
      })

      app.get('/api/bot/status', requireBot, (req, res) => {
        const result = getStatusForBot()
        res.json({ ok: true, ...result, latestEventId: Math.max(0, Number(state.nextEventId || 1) - 1) })
      })

      app.get('/api/bot/events', requireBot, (req, res) => {
        const after = Math.max(0, Number(req.query.after || 0))
        const events = (Array.isArray(state.botEvents) ? state.botEvents : []).filter(event => event.id > after)
        res.json({ ok: true, events, latestEventId: Math.max(after, ...events.map(event => event.id), Number(state.nextEventId || 1) - 1) })
      })

      app.post('/api/bot/end', requireBot, async (req, res) => {
        try {
          const result = await endActiveSession(String(req.body?.reason || 'ended-by-bot'))
          res.json({ ok: true, ...result })
        } catch (error) {
          res.status(400).json({ ok: false, message: error.message })
        }
      })

      app.post('/api/bot/cancel', requireBot, async (req, res) => {
        try {
          const removed = await cancelOwnQueue(req.body?.jid)
          res.json({ ok: true, removed })
        } catch (error) {
          res.status(400).json({ ok: false, message: error.message })
        }
      })

      app.get('/api/status', (req, res) => res.json(publicStatus()))

      app.post('/api/auth', (req, res) => {
        try {
          const { sid, access } = createAccessFromToken(req.body?.token)
          const secure = getPublicUrl().startsWith('https://')
          res.setHeader(
            'Set-Cookie',
            `nobar_sid=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=21600${secure ? '; Secure' : ''}`
          )
          res.json({ ok: true, user: { name: access.name, role: access.role } })
        } catch (error) {
          res.status(401).json({ ok: false, message: error.message })
        }
      })

      app.get('/api/me', (req, res) => {
        const access = getAccessFromRequest(req)
        if (!access) return res.status(401).json({ ok: false })
        res.json({ ok: true, user: { name: access.name, role: access.role } })
      })

      app.post('/api/logout', (req, res) => {
        const sid = parseCookies(req.headers.cookie).nobar_sid
        if (sid) delete state.accessSessions[sid]
        scheduleSave()
        res.setHeader('Set-Cookie', 'nobar_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0')
        res.json({ ok: true })
      })

      app.use('/media', express.static(MEDIA_DIR, {
        fallthrough: false,
        maxAge: '1h',
        setHeaders(res) {
          res.setHeader('Accept-Ranges', 'bytes')
          res.setHeader('Cache-Control', 'private, max-age=3600')
        }
      }))
      app.use(express.static(PUBLIC_DIR, { maxAge: '10m' }))
      app.get('*', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')))

      httpServer = createServer(app)
      io = new Server(httpServer, {
        maxHttpBufferSize: 50_000,
        pingInterval: 25_000,
        pingTimeout: 20_000
      })

      io.use((socket, next) => {
        cleanExpired()
        const sid = parseCookies(socket.handshake.headers.cookie).nobar_sid
        const access = sid && state.accessSessions[sid]
        if (!access || !state.active || access.sessionId !== state.active.id) {
          return next(new Error('unauthorized'))
        }
        socket.data.sid = sid
        socket.data.access = access
        next()
      })

      io.on('connection', socket => {
        const access = socket.data.access
        const sessionId = access.sessionId
        const roomName = `session:${sessionId}`
        socket.join(roomName)

        if (!socketsBySession.has(sessionId)) socketsBySession.set(sessionId, new Set())
        socketsBySession.get(sessionId).add(socket.id)

        socket.emit('room:snapshot', roomSnapshot(access))
        emitPresence(sessionId)

        socket.on('chat:send', payload => {
          if (!state.active || state.active.id !== sessionId) return
          if (!checkRate(socket, 'chat', 900)) return
          const text = String(payload?.text || '')
            .replace(/[<>`]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 220)
          if (!text) return

          const message = {
            id: randomId('msg_'),
            name: access.name,
            role: access.role,
            text,
            at: Date.now()
          }
          state.active.chat.push(message)
          state.active.chat = state.active.chat.slice(-100)
          scheduleSave()
          io.to(roomName).emit('chat:new', message)
        })

        socket.on('reaction:send', payload => {
          if (!state.active || state.active.id !== sessionId) return
          if (!checkRate(socket, 'reaction', 350)) return
          const emoji = String(payload?.emoji || '')
          if (!Object.prototype.hasOwnProperty.call(state.active.reactions, emoji)) return
          state.active.reactions[emoji] += 1
          scheduleSave()
          io.to(roomName).emit('reaction:new', {
            emoji,
            name: access.name,
            totals: state.active.reactions
          })
        })

        socket.on('player:update', payload => {
          if (access.role !== 'host' || !state.active || state.active.id !== sessionId) return
          if (!checkRate(socket, 'player', 250)) return

          const currentTime = Math.max(0, Math.min(Number(payload?.currentTime) || 0, 24 * 60 * 60))
          const playing = Boolean(payload?.playing)
          state.active.playback = {
            playing,
            currentTime,
            updatedAt: Date.now(),
            revision: (state.active.playback.revision || 0) + 1
          }
          scheduleSave()
          socket.to(roomName).emit('player:update', state.active.playback)
        })

        socket.on('session:end', async () => {
          if (access.role !== 'host' || !state.active || state.active.id !== sessionId) return
          await endActiveSession('host-ended')
        })

        socket.on('disconnect', () => {
          rateLimits.delete(`${socket.id}:chat`)
          rateLimits.delete(`${socket.id}:reaction`)
          rateLimits.delete(`${socket.id}:player`)
          const set = socketsBySession.get(sessionId)
          if (set) {
            set.delete(socket.id)
            if (!set.size) socketsBySession.delete(sessionId)
          }
          emitPresence(sessionId)
        })
      })

      const port = getPort()
      httpServer.once('error', error => {
        startingPromise = null
        console.error(`[NOBAR] Website gagal berjalan di port ${port}:`, error.message)
        reject(error)
      })
      httpServer.listen(port, '0.0.0.0', () => {
        started = true
        console.log(`[NOBAR] Website aktif: ${getPublicUrl()} (port ${port})`)
        resolve(api)
      })
    })

    return startingPromise
  }

  function setNotifier(callback) {
    notifier = typeof callback === 'function' ? callback : async () => {}
  }

  const cleanupInterval = setInterval(cleanExpired, 60_000)
  cleanupInterval.unref?.()

  const api = {
    startServer,
    setNotifier,
    enqueueSession,
    createJoinToken,
    createHostToken,
    revokeToken,
    getStatusForBot,
    endActiveSession,
    cancelOwnQueue,
    getPublicUrl,
    getMediaDir: () => MEDIA_DIR
  }

  global.__HANA_NOBAR_SERVER__ = api
  module.exports = api
}

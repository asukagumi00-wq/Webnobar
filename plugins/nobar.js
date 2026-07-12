'use strict'

const fetchImpl = global.fetch || require('node-fetch')

function mentionOf(jid) {
  return `@${String(jid || '').split('@')[0]}`
}

function cleanDisplayName(name) {
  return String(name || '')
    .replace(/[<>`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24)
}

function getConfig() {
  const baseUrl = String(process.env.NOBAR_REMOTE_URL || '').replace(/\/+$/, '')
  const secret = String(process.env.NOBAR_BOT_SECRET || '')
  if (!baseUrl || !secret) {
    throw new Error('Isi NOBAR_REMOTE_URL dan NOBAR_BOT_SECRET di file .env bot.')
  }
  return { baseUrl, secret }
}

async function apiRequest(endpoint, options = {}) {
  const { baseUrl, secret } = getConfig()
  const method = options.method || 'GET'
  const headers = {
    'x-nobar-secret': secret,
    ...(options.headers || {})
  }

  let body
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.json)
  } else if (options.body !== undefined) {
    body = options.body
  }

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), options.timeout || 30000) : null

  try {
    const response = await fetchImpl(`${baseUrl}${endpoint}`, {
      method,
      headers,
      body,
      signal: controller?.signal
    })
    const data = await response.json().catch(() => ({ ok: false, message: `HTTP ${response.status}` }))
    if (!response.ok || data.ok === false) {
      throw new Error(data.message || `Server nobar gagal: HTTP ${response.status}`)
    }
    return data
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Server nobar terlalu lama merespons.')
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function sendMention(conn, chat, text, quoted, mentions = []) {
  return conn.sendMessage(chat, { text, mentions }, quoted ? { quoted } : {})
}

async function sendPrivate(conn, jid, text) {
  return conn.sendMessage(jid, { text })
}

function tokenMessage({ title, token, publicUrl, role }) {
  return [
    '🎬 *AKSES NOBAR*',
    '',
    `Judul: *${title}*`,
    `Akses: *${role === 'host' ? 'HOST / PENGENDALI' : 'PENONTON'}*`,
    `Website: ${publicUrl}`,
    `Token: *${token}*`,
    '',
    'Masukkan token tersebut pada halaman website.',
    'Token hanya bisa digunakan satu kali. Jangan berikan kepada orang lain.'
  ].join('\n')
}

async function deliverToken(conn, jid, data, role) {
  await sendPrivate(conn, jid, tokenMessage({
    title: data.session.title,
    token: data.token,
    publicUrl: data.publicUrl,
    role
  }))
}

async function obtainSource(m, conn, text) {
  const urlMatch = String(text || '').match(/https?:\/\/\S+/i)
  if (urlMatch) return { source: urlMatch[0], title: '' }

  throw new Error(
    'Versi Cloudflare gratis belum mendukung upload video WhatsApp langsung. ' +
    'Gunakan `.nobar <link YouTube/TikTok lengkap/MP4/M3U8>`.'
  )
}

function isFreeUser(isOwner, isROwner, isPrems) {
  return Boolean(isOwner || isROwner || isPrems)
}

function cursorStore() {
  try {
    global.db.data.settings ||= {}
    global.db.data.settings.nobarRemote ||= {}
    return global.db.data.settings.nobarRemote
  } catch {
    global.__NOBAR_REMOTE_CURSOR_STORE__ ||= {}
    return global.__NOBAR_REMOTE_CURSOR_STORE__
  }
}

async function handleRemoteEvent(event) {
  const conn = global.conn
  if (!conn || !event) return

  if (event.type === 'session-started') {
    const session = event.session
    const hostMention = mentionOf(session.requesterJid)

    await sendMention(
      conn,
      session.chatJid,
      [
        '🎬 *GILIRAN NOBAR DIMULAI*',
        '',
        `${hostMention}, antreanmu sekarang menjadi sesi aktif.`,
        `Judul: *${session.title}*`,
        '',
        'Member lain dapat masuk dengan:',
        '`.joinnobar <nama>`'
      ].join('\n'),
      null,
      [session.requesterJid]
    ).catch(() => {})

    await sendPrivate(
      conn,
      session.requesterJid,
      tokenMessage({
        title: session.title,
        token: event.hostToken,
        publicUrl: event.publicUrl,
        role: 'host'
      })
    ).catch(async () => {
      await sendMention(
        conn,
        session.chatJid,
        `${hostMention}, token host gagal dikirim pribadi. Chat bot lalu ketik *.tokennobar*.`,
        null,
        [session.requesterJid]
      ).catch(() => {})
    })
  }
}

function startRemotePoller() {
  if (global.__HANA_NOBAR_REMOTE_POLLER__) return
  if (!process.env.NOBAR_REMOTE_URL || !process.env.NOBAR_BOT_SECRET) return

  const state = { running: false, lastErrorAt: 0 }
  global.__HANA_NOBAR_REMOTE_POLLER__ = state

  const tick = async () => {
    if (state.running) return
    state.running = true
    try {
      const store = cursorStore()
      if (!Number.isFinite(Number(store.lastEventId))) {
        const status = await apiRequest('/api/bot/status')
        store.lastEventId = Number(status.latestEventId || 0)
        return
      }

      const result = await apiRequest(`/api/bot/events?after=${Number(store.lastEventId || 0)}`)
      for (const event of result.events || []) {
        await handleRemoteEvent(event)
        store.lastEventId = Math.max(Number(store.lastEventId || 0), Number(event.id || 0))
      }
      store.lastEventId = Math.max(Number(store.lastEventId || 0), Number(result.latestEventId || 0))
    } catch (error) {
      if (Date.now() - state.lastErrorAt > 5 * 60 * 1000) {
        state.lastErrorAt = Date.now()
        console.error('[NOBAR REMOTE] Polling gagal:', error.message)
      }
    } finally {
      state.running = false
    }
  }

  tick().catch(() => {})
  state.timer = setInterval(tick, 10000)
  state.timer.unref?.()
}

startRemotePoller()

let handler = async (m, {
  conn,
  text,
  command,
  usedPrefix,
  isOwner,
  isROwner,
  isPrems
}) => {
  const prefix = usedPrefix || '.'
  const cmd = String(command || '').toLowerCase()
  const user = global.db?.data?.users?.[m.sender] || {}
  const free = isFreeUser(isOwner, isROwner, isPrems)

  if (cmd === 'nobar') {
    if (!free) throw 'Perintah *.nobar* hanya dapat dipakai owner bot dan member premium.'

    const { source, title } = await obtainSource(m, conn, text)
    const result = await apiRequest('/api/bot/enqueue', {
      method: 'POST',
      json: {
        requesterJid: m.sender,
        requesterName: m.pushName || mentionOf(m.sender),
        chatJid: m.chat,
        title,
        source
      }
    })

    if (result.status === 'queued') {
      const activeJid = result.active.requesterJid
      return sendMention(
        conn,
        m.chat,
        [
          '⏳ *ANTREAN NOBAR*',
          '',
          `Sedang ada sesi ${mentionOf(activeJid)}.`,
          `${mentionOf(m.sender)}, kamu berada di antrean ke-*${result.position}*.`,
          '',
          'Bot akan memberi tahu saat giliranmu dimulai.'
        ].join('\n'),
        m,
        [activeJid, m.sender]
      )
    }

    try {
      await deliverToken(conn, m.sender, {
        token: result.hostToken,
        publicUrl: result.publicUrl,
        session: result.session
      }, 'host')
    } catch {
      await apiRequest('/api/bot/revoke', { method: 'POST', json: { token: result.hostToken } }).catch(() => {})
      throw 'Room dibuat, tetapi token host gagal dikirim. Chat bot pribadi lalu ketik *.tokennobar*.'
    }

    return sendMention(
      conn,
      m.chat,
      [
        '🎬 *ROOM NOBAR DIBUKA*',
        '',
        `Host: ${mentionOf(m.sender)}`,
        `Judul: *${result.session.title}*`,
        `Website: ${result.publicUrl}`,
        '',
        'Token host telah dikirim melalui chat pribadi.',
        `Member dapat masuk dengan: *${prefix}joinnobar <nama>*`
      ].join('\n'),
      m,
      [m.sender]
    )
  }

  if (cmd === 'joinnobar') {
    const name = cleanDisplayName(text)
    if (name.length < 2) throw `Masukkan nama yang tampil di web.\n\nContoh: *${prefix}joinnobar Hanz*`
    if (!free && Number(user.limit || 0) < 1) throw 'Limit kamu habis. Join nobar membutuhkan 1 limit.'

    const data = await apiRequest('/api/bot/join-token', {
      method: 'POST',
      json: { jid: m.sender, name }
    })

    try {
      await deliverToken(conn, m.sender, data, 'viewer')
    } catch {
      await apiRequest('/api/bot/revoke', { method: 'POST', json: { token: data.token } }).catch(() => {})
      throw 'Token gagal dikirim pribadi. Chat bot lalu ulangi *.joinnobar <nama>*.'
    }

    if (!free) user.limit = Number(user.limit || 0) - 1

    return sendMention(
      conn,
      m.chat,
      [
        `✅ ${mentionOf(m.sender)} berhasil mendapat token nobar.`,
        'Token dan link dikirim melalui chat pribadi.',
        free ? 'Owner/premium tidak dipotong limit.' : `Sisa limit: *${user.limit}*`
      ].join('\n'),
      m,
      [m.sender]
    )
  }

  if (cmd === 'tokennobar') {
    const data = await apiRequest('/api/bot/host-token', {
      method: 'POST',
      json: {
        jid: m.sender,
        name: m.pushName || 'Host',
        forceOwner: Boolean(isOwner || isROwner)
      }
    })
    await deliverToken(conn, m.sender, data, 'host')
    return m.reply('✅ Token host baru telah dikirim melalui chat pribadi.')
  }

  if (cmd === 'statusnobar' || cmd === 'antriannobar') {
    const status = await apiRequest('/api/bot/status')
    if (!status.active) return m.reply('Belum ada sesi nobar yang aktif.')

    const mentions = [status.active.requesterJid, ...(status.queue || []).map(item => item.requesterJid)]
    const queueText = status.queue?.length
      ? status.queue.slice(0, 15).map(item => `${item.position}. ${mentionOf(item.requesterJid)} — ${item.title}`).join('\n')
      : 'Antrean kosong.'

    return sendMention(
      conn,
      m.chat,
      [
        '📺 *STATUS NOBAR*',
        '',
        `Host aktif: ${mentionOf(status.active.requesterJid)}`,
        `Judul: *${status.active.title}*`,
        `Penonton online: *${status.viewers}*`,
        `Jumlah antrean: *${status.queue.length}*`,
        '',
        '*DAFTAR ANTREAN*',
        queueText
      ].join('\n'),
      m,
      mentions
    )
  }

  if (cmd === 'batalkannobar') {
    const result = await apiRequest('/api/bot/cancel', { method: 'POST', json: { jid: m.sender } })
    return m.reply(`✅ Antrean nobar *${result.removed.title}* dibatalkan.`)
  }

  if (cmd === 'stopnobar') {
    const status = await apiRequest('/api/bot/status')
    if (!status.active) throw 'Belum ada sesi nobar yang aktif.'
    if (!(isOwner || isROwner) && status.active.requesterJid !== m.sender) {
      throw 'Hanya owner bot atau host sesi aktif yang dapat menghentikan nobar.'
    }
    await apiRequest('/api/bot/end', { method: 'POST', json: { reason: 'stopped-by-command' } })
    return m.reply('⏹️ Sesi dihentikan. Antrean berikutnya otomatis dimulai.')
  }

  if (cmd === 'skipnobar') {
    if (!(isOwner || isROwner)) throw 'Perintah ini khusus owner bot.'
    const status = await apiRequest('/api/bot/status')
    if (!status.active) throw 'Belum ada sesi nobar yang aktif.'
    await apiRequest('/api/bot/end', { method: 'POST', json: { reason: 'skipped-by-owner' } })
    return m.reply('⏭️ Sesi dilewati dan antrean berikutnya dipanggil.')
  }
}

handler.help = [
  'nobar <link>',
  'joinnobar <nama>',
  'statusnobar',
  'antriannobar',
  'tokennobar',
  'batalkannobar',
  'stopnobar',
  'skipnobar'
]
handler.tags = ['main']
handler.command = /^(nobar|joinnobar|statusnobar|antriannobar|tokennobar|batalkannobar|stopnobar|skipnobar)$/i
handler.limit = false
handler.exp = 0

module.exports = handler

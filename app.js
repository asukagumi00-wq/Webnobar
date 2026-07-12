'use strict'

const $ = selector => document.querySelector(selector)
const loginView = $('#loginView')
const roomView = $('#roomView')
const loginForm = $('#loginForm')
const tokenInput = $('#tokenInput')
const loginError = $('#loginError')
const lobbyText = $('#lobbyText')
const video = $('#videoPlayer')
const youtubeWrap = $('#youtubeWrap')
const playerMessage = $('#playerMessage')
const syncButton = $('#syncButton')
const syncState = $('#syncState')
const chatMessages = $('#chatMessages')
const chatForm = $('#chatForm')
const chatInput = $('#chatInput')

let socket = null
let snapshot = null
let currentUser = null
let youtubePlayer = null
let youtubeReadyPromise = null
let hlsInstance = null
let applyingRemote = false
let lastRemotePlayback = null
let hostHeartbeat = null

async function request(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.message || 'Permintaan gagal.')
  return data
}

function showLogin() {
  roomView.classList.add('hidden')
  loginView.classList.remove('hidden')
  disconnectSocket()
  refreshLobby()
}

function showRoom(user) {
  currentUser = user
  loginView.classList.add('hidden')
  roomView.classList.remove('hidden')
  $('#myName').textContent = user.name
  $('#roleBadge').textContent = user.role === 'host' ? 'HOST' : 'PENONTON'
  $('#endButton').classList.toggle('hidden', user.role !== 'host')
  connectSocket()
}

async function refreshLobby() {
  try {
    const status = await request('/api/status', { headers: {} })
    lobbyText.textContent = status.active
      ? `Sedang berlangsung: ${status.active.title} oleh ${status.active.hostName}. Antrean: ${status.queueLength}.`
      : 'Belum ada sesi nobar yang aktif.'
  } catch {
    lobbyText.textContent = 'Status server tidak dapat dibaca.'
  }
}

loginForm.addEventListener('submit', async event => {
  event.preventDefault()
  loginError.textContent = ''
  const button = loginForm.querySelector('button')
  button.disabled = true
  try {
    const result = await request('/api/auth', {
      method: 'POST',
      body: JSON.stringify({ token: tokenInput.value })
    })
    tokenInput.value = ''
    showRoom(result.user)
  } catch (error) {
    loginError.textContent = error.message
  } finally {
    button.disabled = false
  }
})

$('#logoutButton').addEventListener('click', async () => {
  await request('/api/logout', { method: 'POST', body: '{}' }).catch(() => {})
  showLogin()
})

function disconnectSocket() {
  if (socket) socket.disconnect()
  socket = null
  if (hostHeartbeat) clearInterval(hostHeartbeat)
  hostHeartbeat = null
}

function connectSocket() {
  disconnectSocket()
  socket = io({ transports: ['websocket', 'polling'] })
  syncState.textContent = 'Menghubungkan…'

  socket.on('connect', () => {
    syncState.textContent = 'Terhubung dan tersinkron'
  })
  socket.on('connect_error', error => {
    syncState.textContent = 'Koneksi terputus'
    if (String(error.message).includes('unauthorized')) showLogin()
  })
  socket.on('room:snapshot', async data => {
    snapshot = data
    $('#roomTitle').textContent = data.session.title
    $('#hostName').textContent = `Host: ${data.session.hostName}`
    $('#viewerCount').textContent = data.viewers
    renderReactions(data.reactions)
    chatMessages.innerHTML = ''
    data.chat.forEach(renderChat)
    await setupPlayer(data.session.media)
    applyPlayback(data.playback, true)
    startHostHeartbeat()
  })
  socket.on('player:update', playback => applyPlayback(playback))
  socket.on('chat:new', renderChat)
  socket.on('presence:update', data => { $('#viewerCount').textContent = data.viewers })
  socket.on('reaction:new', data => {
    renderReactions(data.totals)
    floatReaction(data.emoji)
  })
  socket.on('room:ended', () => {
    alert('Sesi nobar telah berakhir.')
    showLogin()
  })
}

function destroyPlayers() {
  if (hlsInstance) hlsInstance.destroy()
  hlsInstance = null
  if (youtubePlayer && typeof youtubePlayer.destroy === 'function') youtubePlayer.destroy()
  youtubePlayer = null
  video.pause()
  video.removeAttribute('src')
  video.load()
  video.classList.add('hidden')
  youtubeWrap.classList.add('hidden')
  youtubeWrap.innerHTML = '<div id="youtubePlayer"></div>'
}

async function setupPlayer(media) {
  destroyPlayers()
  playerMessage.classList.remove('hidden')
  playerMessage.textContent = 'Menyiapkan pemutar…'

  if (media.type === 'youtube') {
    youtubeWrap.classList.remove('hidden')
    await loadYouTubeApi()
    youtubePlayer = new YT.Player('youtubePlayer', {
      videoId: media.videoId,
      playerVars: {
        autoplay: 0,
        controls: currentUser.role === 'host' ? 1 : 0,
        playsinline: 1,
        rel: 0,
        modestbranding: 1
      },
      events: {
        onReady() {
          playerMessage.classList.add('hidden')
          if (lastRemotePlayback) applyPlayback(lastRemotePlayback)
        },
        onStateChange(event) {
          if (currentUser.role !== 'host' || applyingRemote) return
          if (event.data === YT.PlayerState.ENDED) socket.emit('session:end')
          if ([YT.PlayerState.PLAYING, YT.PlayerState.PAUSED].includes(event.data)) emitHostPlayback()
        },
        onError() {
          playerMessage.textContent = 'Video YouTube tidak mengizinkan embed atau tidak tersedia.'
          playerMessage.classList.remove('hidden')
        }
      }
    })
    return
  }

  video.classList.remove('hidden')
  video.controls = currentUser.role === 'host'
  video.style.pointerEvents = currentUser.role === 'host' ? 'auto' : 'none'

  if (media.type === 'hls' && window.Hls && Hls.isSupported()) {
    hlsInstance = new Hls({ enableWorker: true })
    hlsInstance.loadSource(media.url)
    hlsInstance.attachMedia(video)
  } else {
    video.src = media.url
  }

  video.onloadedmetadata = () => {
    playerMessage.classList.add('hidden')
    if (lastRemotePlayback) applyPlayback(lastRemotePlayback)
  }
  video.onerror = () => {
    playerMessage.textContent = 'Video gagal dimuat. Link mungkin kedaluwarsa atau tidak mengizinkan pemutaran.'
    playerMessage.classList.remove('hidden')
  }
  video.onplay = () => { if (currentUser.role === 'host' && !applyingRemote) emitHostPlayback() }
  video.onpause = () => { if (currentUser.role === 'host' && !applyingRemote) emitHostPlayback() }
  video.onseeked = () => { if (currentUser.role === 'host' && !applyingRemote) emitHostPlayback() }
  video.onended = () => { if (currentUser.role === 'host') socket.emit('session:end') }
}

function loadYouTubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve()
  if (youtubeReadyPromise) return youtubeReadyPromise
  youtubeReadyPromise = new Promise(resolve => {
    const previous = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previous === 'function') previous()
      resolve()
    }
    const script = document.createElement('script')
    script.src = 'https://www.youtube.com/iframe_api'
    document.head.appendChild(script)
  })
  return youtubeReadyPromise
}

function expectedTime(playback) {
  return Number(playback.currentTime || 0) + (playback.playing ? Math.max(0, Date.now() - playback.updatedAt) / 1000 : 0)
}

async function applyPlayback(playback, forceHostRestore = false) {
  lastRemotePlayback = playback
  if (currentUser?.role === 'host' && !forceHostRestore) return
  applyingRemote = true
  const target = expectedTime(playback)

  try {
    if (snapshot?.session.media.type === 'youtube') {
      if (!youtubePlayer || typeof youtubePlayer.getCurrentTime !== 'function') return
      const current = Number(youtubePlayer.getCurrentTime() || 0)
      if (Math.abs(current - target) > 1.7) youtubePlayer.seekTo(target, true)
      const state = youtubePlayer.getPlayerState()
      if (playback.playing && state !== YT.PlayerState.PLAYING) {
        youtubePlayer.playVideo()
      } else if (!playback.playing && state === YT.PlayerState.PLAYING) {
        youtubePlayer.pauseVideo()
      }
    } else {
      if (!Number.isFinite(video.duration) && video.readyState < 1) return
      if (Math.abs(video.currentTime - target) > 1.25) video.currentTime = target
      if (playback.playing && video.paused) {
        await video.play().catch(() => syncButton.classList.remove('hidden'))
      } else if (!playback.playing && !video.paused) {
        video.pause()
      }
    }
  } finally {
    setTimeout(() => { applyingRemote = false }, 120)
  }
}

function emitHostPlayback() {
  if (!socket || currentUser?.role !== 'host') return
  let currentTime = 0
  let playing = false

  if (snapshot?.session.media.type === 'youtube') {
    if (!youtubePlayer || typeof youtubePlayer.getCurrentTime !== 'function') return
    currentTime = Number(youtubePlayer.getCurrentTime() || 0)
    playing = youtubePlayer.getPlayerState() === YT.PlayerState.PLAYING
  } else {
    currentTime = Number(video.currentTime || 0)
    playing = !video.paused && !video.ended
  }
  socket.emit('player:update', { currentTime, playing })
}

function startHostHeartbeat() {
  if (hostHeartbeat) clearInterval(hostHeartbeat)
  if (currentUser?.role !== 'host') return
  hostHeartbeat = setInterval(emitHostPlayback, 2000)
}

syncButton.addEventListener('click', async () => {
  syncButton.classList.add('hidden')
  if (snapshot?.session.media.type === 'youtube') {
    youtubePlayer?.playVideo?.()
  } else {
    await video.play().catch(() => syncButton.classList.remove('hidden'))
  }
  if (lastRemotePlayback) setTimeout(() => applyPlayback(lastRemotePlayback), 250)
})

$('#fullscreenButton').addEventListener('click', () => {
  const frame = $('#playerFrame')
  if (frame.requestFullscreen) frame.requestFullscreen()
  else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen()
})

$('#endButton').addEventListener('click', () => {
  if (confirm('Akhiri sesi nobar ini?')) socket?.emit('session:end')
})

chatForm.addEventListener('submit', event => {
  event.preventDefault()
  const text = chatInput.value.trim()
  if (!text || !socket) return
  socket.emit('chat:send', { text })
  chatInput.value = ''
})

function renderChat(message) {
  const item = document.createElement('div')
  item.className = `chat-item ${message.role === 'host' ? 'host' : ''}`

  const header = document.createElement('div')
  header.className = 'chat-name'
  const name = document.createElement('span')
  name.textContent = `${message.name}${message.role === 'host' ? ' • HOST' : ''}`
  const time = document.createElement('span')
  time.className = 'chat-time'
  time.textContent = new Date(message.at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
  header.append(name, time)

  const body = document.createElement('div')
  body.className = 'chat-text'
  body.textContent = message.text
  item.append(header, body)
  chatMessages.appendChild(item)
  chatMessages.scrollTop = chatMessages.scrollHeight
}

document.querySelectorAll('[data-reaction]').forEach(button => {
  button.addEventListener('click', () => {
    socket?.emit('reaction:send', { emoji: button.dataset.reaction })
  })
})

function renderReactions(totals) {
  document.querySelectorAll('[data-reaction]').forEach(button => {
    button.querySelector('span').textContent = totals?.[button.dataset.reaction] || 0
  })
}

function floatReaction(emoji) {
  const element = document.createElement('span')
  element.className = 'float-emoji'
  element.textContent = emoji
  element.style.left = `${10 + Math.random() * 75}%`
  $('#reactionFloat').appendChild(element)
  setTimeout(() => element.remove(), 1900)
}

request('/api/me', { headers: {} })
  .then(result => showRoom(result.user))
  .catch(showLogin)

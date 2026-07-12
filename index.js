'use strict'

const nobar = require('./server')

nobar.startServer().catch(error => {
  console.error('[NOBAR] Gagal menyalakan server:', error)
  process.exit(1)
})

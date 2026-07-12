# Nobar Cloudflare Worker — versi backend asli

Paket ini mengganti proyek Express/Socket.IO yang tidak dapat berjalan langsung di Cloudflare Worker.
Versi ini memakai:

- Cloudflare Worker untuk API dan static website
- Durable Object SQLite untuk satu room global, antrean, token, chat, dan sinkronisasi
- Native WebSocket, bukan Socket.IO
- Plugin WhatsApp remote

## Fitur

- `.nobar <link>` hanya owner/premium
- satu sesi aktif, sisanya antre
- `.joinnobar <nama>` membuat token acak sekali pakai
- pemotongan limit hanya untuk member biasa setelah token berhasil dikirim
- chat, reaksi, jumlah pengguna online
- host mengendalikan play/pause/seek
- YouTube, TikTok URL lengkap `/video/ID`, MP4/WebM, dan M3U8
- antrean berikutnya otomatis aktif setelah sesi selesai

## A. Ganti isi repository GitHub

Hapus file proyek Render lama di repository, lalu upload seluruh isi folder ini ke root repository.
Struktur root harus:

```text
public/
src/
plugins/
package.json
wrangler.jsonc
README.md
```

`package.json` dan `wrangler.jsonc` harus terlihat langsung di halaman utama repository.

## B. Deploy di Cloudflare

1. Cloudflare Dashboard → Workers & Pages.
2. Buka Worker yang sekarang, atau buat Worker baru dari repository GitHub.
3. Build command: `npm install`
4. Deploy command: `npx wrangler deploy`
5. Root directory: kosong.
6. Tambahkan secret/variable:

```text
NOBAR_BOT_SECRET = rahasia acak minimal 32 karakter
NOBAR_TOKEN_TTL_MINUTES = 360
NOBAR_SESSION_MAX_HOURS = 6
```

Nilai `NOBAR_BOT_SECRET` jangan dikirim kepada orang lain.

Setelah deploy, buka:

```text
https://NAMA-WORKER.workers.dev/api/status
```

Hasil benar berbentuk JSON, misalnya:

```json
{"ok":true,"active":null,"queueLength":0,"viewers":0}
```

Jika yang tampil HTML, backend belum ter-deploy dengan benar.

## C. Ganti plugin di panel bot

1. Hapus/rename plugin lama:

```text
/home/container/plugins/nobar.js
```

2. Upload file baru:

```text
plugins/nobar.js
```

3. File `nobar-web/` lama boleh dihapus setelah plugin baru terpasang. Plugin Cloudflare tidak memanggil folder tersebut.

4. Isi `.env` bot:

```env
NOBAR_REMOTE_URL=https://NAMA-WORKER.workers.dev
NOBAR_BOT_SECRET=RAHASIA_YANG_SAMA_DENGAN_CLOUDFLARE
```

Jangan memakai tanda `/` di akhir URL.

5. Restart bot.

## D. Tes urut

1. Buka `https://NAMA-WORKER.workers.dev/api/status`.
2. Dari WhatsApp: `.statusnobar`.
3. Owner/premium: `.nobar https://youtu.be/VIDEO_ID`.
4. Akun lain: `.joinnobar Hanz`.
5. Masukkan token di website.
6. Buka incognito dan masukkan token sama. Token harus ditolak karena sekali pakai.

## Catatan penting

- Token dari plugin lokal lama tidak akan dikenali Worker.
- Setelah pindah, buat sesi baru dan token baru.
- Upload video WhatsApp langsung belum didukung pada versi Worker gratis ini. Gunakan link video.
- Link TikTok pendek `vt.tiktok.com` belum didukung; gunakan URL lengkap yang mengandung `/video/ID`.

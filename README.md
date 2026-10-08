# POS UMKM 🧾

Web POS/kasir untuk UMKM (warung, toko kecil). Offline-first PWA.

## Fitur
- 🛒 **Kasir cepat** — klik produk, keranjang, bayar, kembalian otomatis
- 📦 **Kelola produk & stok** — CRUD produk, tambah/kurang stok
- 🏷️ **Kategori produk** — dengan warna
- 📊 **Laporan harian** — omzet, transaksi, produk terlaris, grafik per jam, 7 hari terakhir
- 🧾 **Struk printable** — tampil setelah bayar, bisa print
- 👥 **Multi-kasir** — login sederhana (admin/kasir)
- 📴 **Offline-first** — transaksi saat offline diantrekan di IndexedDB, sync FIFO otomatis + idempotency key

## Tech
- Backend: Express + `node:sqlite` (bawaan Node 24, tanpa native build)
- Frontend: SPA vanilla JS + PWA (service worker, manifest)
- DB: SQLite (`DB_PATH`, default `./pos.db`; di Railway pakai volume `/data`)

## Jalan lokal
```bash
npm install
node server.js
# buka http://localhost:3000
# login: admin / admin123
```

## Deploy Railway
- Build: `npm install` → Start: `npm start`
- Set `DB_PATH=/data/pos.db` + pasang volume di `/data`

## Desain
Dark premium — background arang hangat (`#141210`), satu aksen berani (`#e84393`).

# MIG Duel Kick 10 — TROOP V5

Versi ini mengikuti command yang didokumentasikan pada Developer API MigReborn:
`wss://developer.mig33.id/developer/ws`.

## Fitur
- 10 Troop.
- Main troop + nomor awal/akhir; rentang harus tepat 10 nomor.
- Generate Password mengisi Main password dan password seluruh troop.
- Save/Load menyimpan main troop, main password, rentang, username dan password 10 troop.
- Nama save di UI tidak memakai `.json`; ekstensi ditambahkan saat download.
- Status hanya ditampilkan pada badge pojok: ONLINE/OFFLINE.
- Caption kecil jumlah saldo setiap troop.
- Login/logout per troop dan Login All/Logout All.
- `room.join`, `room.leave`, `room.participants`, `wallet.balance`, dan `room.kick` diteruskan sebagai command WebSocket resmi.
- ListView peserta membaca username dari event `room.participants.result` yang diterima melalui WebSocket, tanpa membuat endpoint peserta palsu.
- Checkbox peserta dapat dipindahkan ke Target Kick.
- Tidak memakai `confirm()`.

## Jalankan
```bash
npm install
npm start
```
Server wajib menggunakan `process.env.PORT` saat di-host.

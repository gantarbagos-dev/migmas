# MIG Duel Kick 10

Aplikasi web multi-ID untuk MigReborn Developer WebSocket API.

## Fitur
- Login sampai 10 ID.
- Setiap ID menggunakan koneksi WebSocket terpisah.
- Join/leave room.
- Kirim `room.participants`.
- Pilih target ID.
- Kirim `room.kick` dari akun yang login.
- Cek saldo.
- Ping keep-alive otomatis setiap 40 detik.
- Password tidak disimpan ke file/database.

## Menjalankan
```bash
npm install
npm start
```

Buka:
`http://localhost:3000`

## API
Menggunakan endpoint WebSocket resmi:
`wss://developer.mig33.id/developer/ws`

Dokumentasi:
https://mig33.id/api.html

## Catatan
`room.kick` di API adalah **vote-kick**, bukan direct kick. Hasil akhir tetap bergantung pada sistem vote/aturan server MigReborn.

Untuk produksi, tambahkan autentikasi aplikasi, HTTPS, rate limiting, dan jangan menyimpan password.

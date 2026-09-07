# MIG Duel Kick 10 v2

Aplikasi web multi-ID untuk MigReborn Developer WebSocket API.

## Fitur
- 10 slot akun dengan koneksi WebSocket terpisah.
- Generate username berurutan, misalnya 1–10 atau 11–20.
- Generate 10 password acak dan otomatis mengisi semua kolom password.
- Save 10 username/password ke file JSON dengan nama file pilihan.
- Load kembali file JSON ke 10 slot.
- Login per ID, Login All, Logout per ID, dan Logout All.
- Join/leave room, participants, balance, dan vote-kick.
- Ping keep-alive otomatis setiap 40 detik.
- Password tidak disimpan oleh server ke database/file.

## Catatan keamanan
Fitur Save/Load menyimpan password dalam file JSON lokal dalam bentuk teks biasa karena diperlukan untuk memulihkan isian. Jangan membagikan file tersebut dan simpan hanya di perangkat yang Anda percaya.

## Menjalankan
```bash
npm install
npm start
```

## API
WebSocket resmi: `wss://developer.mig33.id/developer/ws`
Dokumentasi: `https://mig33.id/api.html`

`room.kick` adalah **vote-kick**, bukan direct kick. Hasil akhir tetap mengikuti aturan/sistem vote server MigReborn.

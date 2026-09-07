# MIG Duel Kick 10 — Troop UI

Web app Node.js/Express yang menggunakan **MigReborn Developer WebSocket API resmi**.

Official API: https://mig33.id/api.html
WebSocket endpoint: `wss://developer.mig33.id/developer/ws`

## Fitur
- 10 slot Troop, masing-masing nama troop + password.
- Generate Troop berdasarkan rentang angka yang harus berjumlah tepat 10: `1`–`10`, `11`–`20`, `50`–`59`, dan juga bisa terbalik `20`–`11`.
- Generate satu password acak yang sama untuk semua 10 troop.
- Save/Load JSON dengan nama file; default `troop1.json`.
- Login / Logout per troop dan Logout All.
- Login 10 troop memakai koneksi WebSocket terpisah untuk setiap troop.
- Ping keep-alive 40 detik sesuai aturan API.
- Join / Leave room.
- Meminta `room.participants` dan menerima event WebSocket asli ke browser.
- ListView peserta dengan checkbox dan pemindahan ke list target.
- Target kick dikirim sebagai `room.kick` sesuai API resmi (vote-kick, bukan direct kick).
- Tidak menyimpan credential ke disk di backend.

## API commands used
Only documented MigReborn Developer API commands are used:
- `developer.login`
- `ping`
- `room.join`
- `room.leave`
- `room.participants`
- `room.kick`
- `wallet.balance`

The backend relays the raw WebSocket event to the browser so the UI does not invent undocumented API response fields. Participant ListView is populated only when the received `room.participants.result` contains a documented/actual `data.participants` array.

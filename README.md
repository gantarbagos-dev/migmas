# MIG Duel Kick 10 TROOP V7

Node.js/Express frontend + backend using the official MigReborn Developer WebSocket API.

## V7 changes
- Generate Password button keeps the same button height as Generate Troop and remains beside Main Password.
- Login All uses one HTTP batch command and opens the required separate WebSocket connection for each Troop concurrently.
- Join All / Leave All / Participants / Balance / Vote-Kick use one HTTP batch command that sends the official command concurrently to all active Troop WebSockets.
- Logout All closes all active sessions in one batch command.
- The official API requires a separate WebSocket per account; V7 does not incorrectly combine multiple accounts into one WebSocket.
- WebSocket ping keep-alive remains enabled every 40 seconds.

## Official API
Endpoint: `wss://developer.mig33.id/developer/ws`
Docs: https://mig33.id/api.html
\n## Perubahan Timer\n- Timer default: 60000 ms.\n- Countdown hanya dimulai dari event vote-started `room.kick.state`/`room.kick` yang valid.\n- Countdown asynchronous dan berhenti di 0 ms.\n- Textbox Timer default: 1500 ms.\n- Tombol ikon jam mereset timer ke 60000 ms.\n- Jika label timer sama persis dengan nilai textbox Timer, KICK ALL dipicu otomatis.\n
## Perbaikan Countdown
- Feedback `vote_started` duplikat tidak lagi me-reset countdown ke 60000 ms.
- Countdown berhenti di 0 dan tetap 0 sampai event `vote_started` baru atau tombol reset ditekan.
- Pemicu KICK ALL memakai deteksi melewati threshold agar nilai 1500 ms tidak terlewat oleh jitter setTimeout.
- Tombol reset tetap mengembalikan label ke 60000 ms.

## Perbaikan Pemicu Countdown v3
- Jalur backend `detectKickCountdown()` dihapus.
- Backend tidak lagi membuat event `kick.countdown.start` dari teks API umum.
- Satu-satunya pemicu countdown adalah event API `room.kick.state` dengan `action=vote_started`, `command=kick`, `success != false`, dan format status awal vote-kick yang valid.
- Saat countdown sedang berjalan, `vote_started` lain tidak dapat me-reset timer.
- Setelah countdown selesai di 0, timer menunggu event vote baru.

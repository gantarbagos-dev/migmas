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

- UI: saldo kini hanya menampilkan nilainya saja, kecil di sebelah kiri status OFFLINE/ONLINE.
- UI: GENERATE TROOP dipindahkan ke samping Main troop dan ukurannya disamakan dengan GENERATE PASSWORD.
- UI: tombol KOSONGKAN dipindahkan ke posisi lama GENERATE TROOP dan diubah menjadi DELETE.
- UI: list peserta dibuat lebih rapi sebagai listbox dengan checkbox, hover, dan state terpilih yang lebih jelas.

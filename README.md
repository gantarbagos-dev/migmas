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
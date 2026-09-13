# MIG Duel Kick 10 - Ultra Fast Kick All

Kick All now uses Race Mode: each WebSocket dispatches up to 3 `room.kick` commands as a small burst without waiting for `room.kick.queued`. Queued responses are matched per WebSocket in FIFO order and processed in the background. No `job.get` is used.

- Up to 10 WebSockets run concurrently.
- Target dispatch is not blocked by queue acknowledgement or job completion.
- `textdelay` still controls the configured delay between target pairs in each WebSocket sequence.
- Progress remains based on verified job results.
- Final execution waits only for queued acknowledgements so progress reflects API acceptance; there is no job completion verification.

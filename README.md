# MIG Duel Kick 10 - Ultra Fast Kick All

Kick All now dispatches `room.kick` commands without waiting for `room.kick.queued` before sending the next target. Queued responses are matched per WebSocket in FIFO order, and each returned `job_id` is verified in the background with `job.get`.

- Up to 10 WebSockets run concurrently.
- Target dispatch is not blocked by queue acknowledgement or job completion.
- `textdelay` still controls the configured delay between target pairs in each WebSocket sequence.
- Progress remains based on verified job results.
- Final execution waits for background verification so completion/progress remains accurate.

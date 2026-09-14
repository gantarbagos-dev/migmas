# MIG Duel Kick 10 - Instant Dispatch

KICK ALL menjalankan hingga 10 WebSocket secara bersamaan. Setiap WebSocket mengirim target dalam burst sesuai pilihan Burst (1–10) tanpa menunggu respons API.

- Maksimal 10 WebSocket berjalan konkuren.
- Dispatch `room.kick` tidak menunggu ACK, `room.kick.queued`, atau `job.get`.
- Progress KICK ALL dihitung dari jumlah command yang berhasil dikirim melalui WebSocket (`dispatchedJobs`).
- `textdelay` mengatur jeda antar-burst di dalam loop dan juga jeda dari akhir satu loop ke loop berikutnya.
- Burst berikutnya dimulai setelah delay yang ditentukan; tidak ada penantian ACK/job completion.
- Kegagalan transport WebSocket tetap dicatat sebagai `send_failed`.

Version 44: memperbaiki bug LOGIN ALL, membersihkan kode/status ACK lama yang sudah tidak digunakan, dan memperbarui README agar sesuai dengan implementasi aktif.


Performance note (v45): WebSocket progress state is indexed by physical slot for O(1) lookup; no Array.find() is used in the KICK ALL dispatch hot path.

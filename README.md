# MIG Duel Kick 10 - Instant Dispatch

KICK ALL menjalankan hingga 10 WebSocket secara bersamaan. Setiap WebSocket mengirim target dalam burst sesuai pilihan Burst (1–10) tanpa menunggu respons API.

- Maksimal 10 WebSocket berjalan konkuren.
- Dispatch `room.kick` tidak menunggu ACK, `room.kick.queued`, atau `job.get`.
- Progress KICK ALL dihitung dari jumlah command yang berhasil dikirim melalui WebSocket (`dispatchedJobs`).
- `textdelay` mengatur jeda antar-burst di dalam setiap loop dan juga jeda dari akhir satu loop ke loop berikutnya.
- Di dalam satu burst, target dikirim langsung berurutan tanpa delay buatan.
- Kegagalan transport WebSocket dicatat sebagai `send_failed`.
- Server bind ke `0.0.0.0` agar dapat menerima koneksi dari platform hosting seperti Bonto.
- Frontend menggunakan cache-busting `frontend.js?v=49`.

## Deployment

Jalankan dengan `npm start` atau `yarn start`. Dependency diambil dari `package.json`. Node.js 18 atau lebih baru diperlukan.

## Performance

- WebSocket progress state menggunakan lookup O(1) berdasarkan physical slot.
- Tidak ada `Array.find()` pada KICK ALL dispatch hot path.
- Tidak ada penantian ACK atau `job.get` untuk dispatch KICK.
- Progress UI diperbarui secara coalesced agar tidak membuat Promise-chain untuk setiap target.

Version 51: mempertegas dispatch Burst 1–10, menampilkan metadata burst pada progress, dan mencegah update progress tertunda menimpa status selesai. Perubahan lain dari v48 dipertahankan.


- Progress Target dihitung dari target yang benar-benar sudah didispatch oleh seluruh WebSocket, bukan dari pembagian global `dispatchedJobs`.
- Progress Burst mengikuti target yang sudah benar-benar terkirim pada burst tersebut.


## Countdown trigger
Countdown hanya dipicu oleh event sistem `room.kick.state` dengan `action=vote_started`, `command=kick`, teks `has been started by`, dan room yang sama dengan room yang sedang diikuti WebSocket. Pesan chat biasa yang mengandung teks tersebut tidak memicu timer. Timer memakai timestamp event asli sehingga jeda transport/render otomatis dikurangkan dari sisa waktu.

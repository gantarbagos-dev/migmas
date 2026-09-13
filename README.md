MIGSOCK v18

UI retained from v17. KICK ALL now shows a real per-Troop progress bar. Backend progress is based on the official room.kick queue/job lifecycle: room.kick.queued -> job.get terminal status. A Troop bar advances only when its individual kick job reaches success; failed jobs are shown separately.

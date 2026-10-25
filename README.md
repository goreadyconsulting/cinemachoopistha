# Cinema Choopistha

A private synchronized movie-watch-party app, backed by Supabase and hosted on GitHub Pages.

## What it does

- Guest entry (Supabase anonymous sign-ins; no email, GitHub account or password)
- Create rooms or join with an invite link/code
- At most two active guests per room can pause, play, seek, and select videos
- Live online-member presence
- Private Supabase Storage upload and signed video playback URLs
- Responsive design for desktop and mobile

## Project

- Repository: https://github.com/goreadyconsulting/cinemachoopistha
- Supabase project: https://supabase.com/dashboard/project/pqnuknmxstemsjxhpmau
- Intended website: https://goreadyconsulting.github.io/cinemachoopistha/

The connected Supabase project already has the watch-party SQL migration applied.

## Required Supabase setting (one-time)

**Enable Anonymous Sign-ins** at
https://supabase.com/dashboard/project/pqnuknmxstemsjxhpmau/auth/providers
under Authentication > Sign In / Providers > Anonymous Sign-ins.

No GitHub OAuth configuration is needed. Supabase creates a disposable user session behind the scenes, so RLS can protect rooms, uploads and playback.

**Hosting**: GitHub Pages deploys from branch `main`, folder `/(root)`.

## Two-guest seat rules

- One room creator + one invited guest = two active guests maximum.
- A third guest receives a "room is full" error, enforced by a serialized database join function.
- The browser refreshes its active room seat every 20 seconds.
- An inactive seat expires after 90 seconds (e.g. a guest closes their browser).
- Click **Leave room** to release a seat immediately. Clicking **All rooms** merely pauses your seat heartbeat; it expires after 90 seconds, or can be resumed by re-entering the room.
- Guest identity is bound to browser-local anonymous session. Clearing browser storage/signing out creates a new identity, not a permanent account.

All site files are static: index.html, styles.css, app.js, and config.js. There is no build step.
Only the public Supabase publishable key is included in config.js; data protection depends on database Row Level Security and Storage policies.

## Video limitations

- Supported uploads: MP4 / WebM, up to **5 GB** each, using TUS resumable 6 MB chunks with a percentage progress bar. Re-select the **same file** after a network interruption to resume within 24 hours.
- **Required:** In [Supabase Storage Settings](https://supabase.com/dashboard/project/pqnuknmxstemsjxhpmau/storage/settings), set **Global file size limit** to at least **5 GB** (bucket and database limits are already 5 GiB). The connected organisation has Pro, which permits this setting. Without changing the global limit, uploads above its configured value still fail.
- Each private video uses a six-hour signed link when it is selected for playback.
- Each viewer streams their own video from Supabase Storage; playback commands synchronize via Realtime.
- The browser may block automatic playback with sound. The **Tap to play on this device** button solves this locally.
- A recent HTML5 browser is required. H.264 MP4 works best across devices.
- This is for videos you have the rights to share. It does not bypass DRM or support paid streaming services.

## Suggested next iteration

Queue reorder/delete, subtitles, host/moderator privileges, reactions/chat, and a streaming CDN/transcoding pipeline for full-length feature films.

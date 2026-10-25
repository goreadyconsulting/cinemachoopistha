# Cinema Choopistha

A private synchronized movie-watch-party app, backed by Supabase and hosted on GitHub Pages.

## What it does

- GitHub sign-in through Supabase Authentication
- Create rooms or join with an invite link/code
- Multiple participants can pause, play, seek, and select videos
- Live online-member presence
- Private Supabase Storage upload and signed video playback URLs
- Responsive design for desktop and mobile

## Project

- Repository: https://github.com/goreadyconsulting/cinemachoopistha
- Supabase project: https://supabase.com/dashboard/project/pqnuknmxstemsjxhpmau
- Intended website: https://goreadyconsulting.github.io/cinemachoopistha/

The connected Supabase project already has the watch-party SQL migration applied.

## Go live (two one-time dashboard actions)

1. **GitHub OAuth**: Register a GitHub OAuth App at https://github.com/settings/developers with callback URL:
   https://pqnuknmxstemsjxhpmau.supabase.co/auth/v1/callback
   Put the GitHub OAuth client ID and secret into **Supabase → Authentication → Sign In / Providers → GitHub**. The GitHub client secret must stay inside the Supabase dashboard.
2. **Redirect allowlist**: In **Supabase → Authentication → URL Configuration**, set the Site URL to:
   https://goreadyconsulting.github.io/cinemachoopistha/
   Add the same value to the Redirect URLs allowlist.
3. **Hosting**: In **GitHub repository → Settings → Pages**, choose **Deploy from a branch**, branch **main**, folder **/(root)**, and save.

All site files are static: index.html, styles.css, app.js, and config.js. There is no build step.
Only the public Supabase publishable key is included in config.js; data protection depends on database Row Level Security and Storage policies.

## Video limitations

- Supported uploads: MP4 / WebM, up to **50 MB** each (starter configuration; Free plan storage cap).
- Each viewer streams their own video from Supabase Storage; playback commands synchronize via Realtime.
- The browser may block automatic playback with sound. The **Tap to play on this device** button solves this locally.
- A recent HTML5 browser is required. H.264 MP4 works best across devices.
- This is for videos you have the rights to share. It does not bypass DRM or support paid streaming services.

## Suggested next iteration

Resumable large-file uploads, queue reorder/delete, subtitles, host/moderator privileges, reactions/chat, and a streaming CDN/transcoding pipeline for full-length feature films.

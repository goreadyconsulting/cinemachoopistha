# Cinema Choopistha

A private streaming place with independent solo playback and a shared, mutually agreed movie-night room, powered by Supabase and hosted on GitHub Pages.

**Website:** https://goreadyconsulting.github.io/cinemachoopistha/

## Enter

1. Sign in as Kittu or Subbu using the profile PIN.
2. Choose **Watch individually** or **Wait for partner**.
3. Solo: browse and play a film privately. Every play/pause, seek and 10-second skip is local, and per-film progress is saved in browser storage under the selected profile.
4. Together: the first profile waits in a private lobby. Once both are present, each suggests a movie. Both vote; only matching votes open the selected film in the shared synchronized player.
5. The final screen shows only the chosen film, a minimal title and floating video controls. Movie recommendations and the film shelf stay hidden; chat starts collapsed.
6. After refreshing, a verified session restores the current experience in the same browser tab. Leaving Together returns you to the two-experience choice.

**PINs are not in this repository.** They are verified on the Supabase server against bcrypt hashes stored in the non-exposed \`private.watch_pin_codes\` table. Repeated incorrect attempts are temporarily blocked per anonymous session. The previous guest-label-only login function is disabled, and room/database/storage read operations require a PIN-verified session.

PINs are just four digits and therefore best suited to a small personal project, not high-assurance security. A disposable anonymous Supabase account can avoid an account-scoped lockout by creating a new session. Use longer credentials or full Auth with CAPTCHA if stronger protection is needed.

An anonymous Supabase login session remains available on that browser when it is refreshed. Use the small profile button to sign out or change profiles.

## Movies

Films are uploaded in the Supabase dashboard to the private **cinema-library** bucket, at the root of the bucket. No upload controls appear in the website.

**Dashboard:** https://supabase.com/dashboard/project/pqnuknmxstemsjxhpmau/storage/buckets

MKV files can be listed but usually will not play reliably in browsers. For the best results on phones, tablets, and computers, use MP4 with H.264 video and AAC audio. When both an MKV and an MP4 have the same parsed title, the MP4 is preferred.

WebVTT subtitle sidecar files may be uploaded with the same base filename and a \`.vtt\` extension. The player shows a CC control when one or more are available.

## Product design

- No visible branding header, profile selection followed by a compact PIN form
- One film feature, one real movie shelf, no placeholder movie categories
- One shared approved-movie room and an independent solo mode; no invite codes or upload UI
- Responsive theatre, native fullscreen, optional picture-in-picture, subtitles, loading indicators
- Music-player-style previous / play-pause / next icons with no visible numeric labels; previous/next still skip exactly 10 seconds for both viewers, including while paused
- Private two-person live chat with a compact, collapsible bottom-right chat window on all devices
- Shared playback state and resume position with local volume controls
- Presence indicators for Kittu and Subbu

## Stack

Supabase Storage, Auth (anonymous users), Postgres RPCs and policies, and Realtime. Frontend files are static HTML, CSS, and JavaScript. GitHub Pages deploys from \`main\` at the repository root.

SQL migrations already applied in the live Supabase project are stored in \`supabase/migrations\`. PIN **setup values are intentionally not stored in migrations**.


## Private in-room chat

- Supabase table: \`public.watch_chat_messages\`, with RLS requiring active PIN-verified membership in the cinema room
- Chat sender identity comes from the server-side verified profile (Kittu or Subbu), never a user-entered field
- Writing requires the \`send_cinema_chat\` RPC; no direct client INSERT privilege
- Messages are stored persistently, limited to 500 characters, and rate-limited to 1 per second per viewer
- New messages flow via Supabase Realtime Postgres Changes, with a 6-second polling fallback
- The UI loads the 100 latest messages when joining and keeps a bounded in-browser list

The \`skip_cinema_seconds\` RPC serializes updates to the one shared room so 10-second skips are consistent for both viewers. The current play/pause state is preserved.

## Startup and layout

- A purple/lavender split-color heart is rendered immediately during startup.
- Previously PIN-verified guest sessions bypass the profile chooser when still valid.
- Refreshing while in the cinema restores the watch screen in the same browser tab; autoplay with sound may still require a tap.
- Without a verified session, the page shows the Kittu/Subbu profile chooser after the heart loader.
- Chat starts minimized as a floating bottom-right button; it opens into a compact window with a collapse control and unread message count.

## Music-player controls

The player has a thin timeline above a centered three-button transport: rewind 10 seconds, play/pause, forward 10 seconds. The skip controls use icon-only double-chevron shapes with descriptive accessibility labels (no visible digits). Elapsed/duration timestamps remain available to assistive technology but are visually hidden. Subtitle, mute, picture-in-picture and fullscreen controls sit on the right and remain responsive on mobile.


## Movie posters

The homepage automatically tries to show a film poster instead of the generic cinematic SVG:

1. **Optional local poster** (most reliable): put a JPG, PNG or WebP in \`cinema-library\` beside the MP4, named to match its base filename, for example \`WALL-E.mp4\` + \`WALL-E.jpg\` (or \`WALL-E.poster.jpg\`). The client obtains a signed read URL from the same private bucket. Posters remain in Supabase, not in GitHub.
2. **Known-film poster mapping**: Ante Sundaraniki (2022), WALL·E (2008), and DC (2026, Tamil) have curated public promotional poster URLs.
3. **Other movie titles**: the frontend attempts a conservative film-title search using Wikipedia's PageImages API (requires internet access to Wikipedia and its thumbnail host). A failed or ambiguous search leaves the SVG fallback, rather than displaying an incorrect movie poster.

The player and its WebVTT subtitle matching are unchanged. Videos must be uploaded separately; a \`.vtt\` file alone won't appear as a movie in the catalog.

Note: Promotional posters are third-party assets; their sources may prohibit hotlinking or change their URLs. Upload a personally sourced matching \`.jpg\` / \`.png\` / \`.webp\` for full control over reliability, with appropriate rights to use the artwork.


## Immersive playback controls

Player actions and progress are overlaid inside the video instead of occupying
space beneath it. The bar fades after about 3 seconds of inactivity while the
movie plays, returns on mouse movement or touch, and remains visible when paused,
loading, scrubbing or being actively navigated by keyboard. The floating chat is
not part of the overlay.

Mute, subtitles, picture-in-picture, and fullscreen show a lavender/purple
highlight while active, and their aria-pressed state reflects the browser's
actual current setting. The play/pause glyph reflects shared playback status;
back/forward are momentary 10-second shared seeks.


## Play/pause state and idle controls

The centered play/pause button now reflects the authoritative shared room state:
purple pause icon while playing (\`aria-pressed=true\`) and a neutral play icon
while paused (\`aria-pressed=false\`). Rewind/forward remain momentary actions.
Playback controls auto-hide after approximately three seconds of inactivity even
if a mouse pointer is stationary over the control bar. They remain visible during
a held click/touch, timeline scrubbing, keyboard interaction, buffering, and
paused playback. Moving the mouse or tapping the player restores the overlay.

## Two-person movie-night lobby

The backend public.cinema_lobby_action function handles join, status, heartbeat,
propose, vote, and leave. The server checks the PIN-verified profile and uses a
locked private singleton Postgres row for atomic, mutually approved decisions.
The lobby table lives in the private schema with RLS and no direct client read.
Only one active device can occupy each profile's lobby seat.

Stale seats expire after 80 seconds. The frontend polls status every four seconds
and sends heartbeats every 20 seconds. The agreed title is written once to the
existing shared watch room, paused at the beginning. Realtime playback continues
to use the existing verified shared-room permissions.

Solo playback never invokes shared-room playback or skip RPCs. Local solo resume
positions are stored per film and per profile in the current browser, not synced
between devices. The movie shelf and prominent presence controls remain hidden
while a screening is active.

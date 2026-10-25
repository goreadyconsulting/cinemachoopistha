# Cinema Choopistha

A simple streaming room for two people, powered by Supabase and hosted on GitHub Pages.

**Website:** https://goreadyconsulting.github.io/cinemachoopistha/

## Enter

1. Choose **Kittu** or **Subbu**.
2. Enter that profile's private four-digit PIN.
3. Browse the films in the **Movies** shelf and choose **Watch Together**.
4. Both people join the same persistent room. Play, pause, seek, and the **−10s / +10s** buttons are synchronized.
5. Open **Chat** beside the player to message each other while watching. On phones and tablets, Chat opens as a closeable bottom sheet.

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
- One shared room; no invite codes, manual room creation, or upload UI
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

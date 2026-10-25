# Cinema Choopistha — our little movie universe

A cinematic, couple-focused streaming experience for Kittu & Subbu, with a **Supabase Storage movie library**, custom artwork, Netflix-inspired home screen and synchronized two-person watch rooms.

- Site: https://goreadyconsulting.github.io/cinemachoopistha/
- Supabase project: https://supabase.com/dashboard/project/pqnuknmxstemsjxhpmau

## Enter the cinema

Choose **Kittu** or **Subbu** on the login screen. These are the only allowed profile names. Each private screening room supports **one active Kittu and one active Subbu**. Each active seat is kept alive while in the room and expires after 90 seconds of inactivity.

**Important security note:** These are **name-only profiles, not password-protected accounts**. Anyone who knows the website can select either name. Browser-local Supabase anonymous sessions provide database identities, but do not prove a real person's identity. Do not store movies that must be protected from anyone who can access this site. Password/PIN verification can be added if desired.

Anonymous Sign-ins must be enabled in Supabase Authentication → Sign In / Providers.

## Add a movie — directly from Supabase

1. Go to [Supabase Storage](https://supabase.com/dashboard/project/pqnuknmxstemsjxhpmau/storage/buckets).
2. Open the private **cinema-library** bucket.
3. Click **Upload file** and select a movie. **Upload in the bucket root**, not inside a folder.
4. Go to the Cinema Choopistha website. The film appears in the **Shared movie library** or **Movie library** sidebar after clicking **Refresh**.
5. Enter a room, click the movie to select it, then play/pause/seek. Both viewers share controls.

Dashboard uploads are not permitted from the website. Users may only list/stream movies after selecting a profile. The separate legacy \`watch-videos\` bucket (used by earlier room uploads) is preserved.

The cinema-library bucket accepts files up to **5 GiB**. Ensure Supabase **Storage → Settings → Global file size limit** is also set high enough for your movie. Large file uploads may be more reliable using Supabase's TUS resumable upload protocol.

## Your MKV movie

**MKV can be uploaded to the library**, but HTML5 video does not reliably play Matroska in common browsers. The movie appears in the library with a compatibility warning. Converting the container to MP4 before uploading is the most reliable route.

If the MKV already contains H.264 video, try a remux (fast, usually no video re-encoding):

\`\`\`bash
ffmpeg -i "input.mkv" -map 0:v:0 -map 0:a:0? -c:v copy -c:a aac -movflags +faststart "movie.mp4"
\`\`\`

If the original video codec is HEVC/H.265 or incompatible with a viewer's browser, convert the video to H.264:

\`\`\`bash
ffmpeg -i "input.mkv" -map 0:v:0 -map 0:a:0? -c:v libx264 -preset medium -crf 22 -c:a aac -b:a 192k -movflags +faststart "movie.mp4"
\`\`\`

The \`-map 0:a:0?\` is optional when no audio stream exists. Conversion can require significant CPU time and disk space. Ensure you have the rights to share the file.

## How playback works

- The browser lists movie objects in Supabase Storage directly (no manual metadata table).
- Movies are stored in a private bucket; viewers obtain signed 6-hour URLs.
- Changing video, playing, pausing, or seeking updates a server-validated room state.
- Realtime Postgres Changes and Presence share room state and online users.
- Browsers may block sound autoplay; use the **Tap to play on this device** button.
- This is a static GitHub Pages app. It does not transcode media or bypass DRM.

## Applied database migrations

See \`supabase/migrations/\` for the SQL already applied to the project's database.

## Frontend design (October 2026)

- Profile chooser: two illustrated cards for Kittu and Subbu
- Cinematic feature banner: displays the first movie in Supabase Storage, with no dummy movie listing
- Netflix-inspired collection shelf: cards derived from actual movie objects in `cinema-library`
- Human-readable movie titles parsed from filenames (for example, `Ante.Sundaraniki.2022.1080p....mkv` becomes **Ante Sundaraniki (2022)**)
- If MKV and MP4 of the same named movie are both present, MP4 is preferred
- Featured play and movie cards create a room and prepare the selected film
- Watch page retains room playback synchronization and private member presence
- Artwork is an original SVG visual fallback, not an official film poster
- No movie-upload buttons on the website

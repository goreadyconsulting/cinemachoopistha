# Cinema Choopistha

A minimal private watch-together app for **Kittu and Subbu**, hosted on GitHub Pages and backed by Supabase.

**Site:** https://goreadyconsulting.github.io/cinemachoopistha/

## How to use

1. Choose **Kittu** or **Subbu**. Each browser gets an anonymous Supabase session tied to the selected name.
2. The homepage shows your actual films from the private **cinema-library** Storage bucket. There are no sample movie cards.
3. Press **Watch together** (or choose a film). The app joins one persistent shared room; no room creation or invite codes.
4. The other person opens the same URL and presses **Join Kittu / Join Subbu**.
5. Video selection, play, pause, and seek are synchronized. Volume and picture-in-picture are local. Native fullscreen includes the controls.

Your shared room and prior movie progress are preserved in Supabase. Leaving the room pauses playback when both people are gone. Stale playing sessions are also stopped upon the next entrance based on the last guest heartbeat.

## Where films live

Upload films directly to **Supabase Storage → cinema-library**, at bucket root. The website never uploads a movie.

https://supabase.com/dashboard/project/pqnuknmxstemsjxhpmau/storage/buckets

The global and bucket file-size limits must accommodate your movie. The library automatically prefers **MP4 over MKV** when two files have the same parsed movie title.

The site uses an external promotional poster for Ante Sundaraniki, with a bundled SVG fallback when offline or the poster host is unavailable. Other titles use the bundled fallback until custom poster metadata is added.

### Conversion

Some browsers do not play MKV/HEVC. For best cross-device playback, encode **MP4 with H.264 video and AAC audio**, using same-as-source resolution and frame rate. Keep the original MKV.

Optional WebVTT subtitle files can sit next to the MP4 using matching names (e.g., \`Movie.2022.mp4\` and \`Movie.2022.en.vtt\`). When present the player offers a CC toggle.

## Architecture

- Supabase Auth: anonymous sign-ins; only two profile labels are offered.
- Supabase Storage: private \`cinema-library\` bucket. Signed URLs stream video.
- Database: the singleton \`cinema_home\` references an existing watch room. \`enter_shared_cinema\`, \`get_cinema_status\`, and \`leave_shared_cinema\` are membership-controlled RPCs.
- Supabase Realtime: room state update feed + private Presence, with polling fallback.
- Frontend: static HTML/CSS/JavaScript; responsive mobile/tablet/desktop, reduced-motion support.

**Security note:** The names Kittu and Subbu are **not authenticated identities**. Anyone with the website link can select either label. Anonymous Supabase Auth supplies session identity for database permissions, not proof of which person is using the website. Add PINs or real sign-in before treating this as private from others.

**Content:** Share only movies you have the rights to stream to the other viewer. The app does not bypass DRM.

## Deployment

GitHub Pages: branch \`main\` / root. Changes to \`index.html\`, \`styles.css\`, \`app.js\`, or \`cinema-night.svg\` deploy automatically. \`config.js\` holds only a publishable Supabase key (never service-role keys).

Applied migration files are tracked in \`supabase/migrations/\`.

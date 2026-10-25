# Cinema Choopistha

A simple streaming room for two people, powered by Supabase and hosted on GitHub Pages.

**Website:** https://goreadyconsulting.github.io/cinemachoopistha/

## Enter

1. Choose **Kittu** or **Subbu**.
2. Enter that profile's private four-digit PIN.
3. Browse the films in the **Movies** shelf and choose **Watch Together**.
4. Both people join the same persistent room. Play, pause, and seek are synchronized.

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
- Shared playback state and resume position with local volume controls
- Presence indicators for Kittu and Subbu

## Stack

Supabase Storage, Auth (anonymous users), Postgres RPCs and policies, and Realtime. Frontend files are static HTML, CSS, and JavaScript. GitHub Pages deploys from \`main\` at the repository root.

SQL migrations already applied in the live Supabase project are stored in \`supabase/migrations\`. PIN **setup values are intentionally not stored in migrations**.

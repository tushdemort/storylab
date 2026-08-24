# StoryLab paired assessment

A full-stack paired storytelling assessment built with Next.js 16 and Supabase. It provides issued-ID entry, explicit consent, fullscreen/focus monitoring, random two-person matching, synchronized chat and timers, unanimous story approval, an individual quiz, raw keystroke collection, and a protected researcher console.

## Prerequisites

- Node.js 20.9 or newer
- A Supabase project with Anonymous Sign-Ins enabled
- A Vercel project for production deployment
- Supabase CLI and Docker only if you want the complete local Supabase stack

## Local setup

1. Install dependencies:

   ```powershell
   npm.cmd install
   ```

2. Copy `.env.example` to `.env.local` and provide the Supabase project URL, publishable key, secret key, and a comma-separated `ADMIN_EMAILS` allowlist.

3. Apply the database migration:

   ```powershell
   supabase db push
   ```

   For a fully local Supabase environment, run `supabase start` and then `supabase db reset`. The local seed adds `DEMO001` through `DEMO004`; never use those predictable IDs in a live study.

4. In Supabase Authentication, enable Anonymous Sign-Ins. Create each researcher as an email/password user, disable public email signup, and list the same lowercase email in `ADMIN_EMAILS`. The first successful allowlisted login registers that Auth user in the private admin table.

5. Start the app:

   ```powershell
   npm.cmd run dev
   ```

Participant entry is at `http://localhost:3000`; researcher access is at `http://localhost:3000/admin`.

## Researcher workflow

1. Sign in at `/admin`.
2. Replace all placeholder consent, instruction, attention, and quiz text. Publishing creates a new immutable study version; existing attempts keep their original version.
3. Import a CSV of pseudonymous participant IDs. The first column is used, and an optional header is detected automatically.
4. Monitor stage counts and reset interrupted IDs when appropriate.
5. Export the dataset as a ZIP of related CSV files. Raw keystrokes include deleted drafts and pasted content, so store exports according to the approved research protocol.
6. Pair-level deletion is permanent and cascades through shared content and both participants’ recorded events.

## Production deployment

1. Create the Supabase project in the required region and run `supabase db push --linked`.
2. Confirm Anonymous Sign-Ins, Realtime private-channel authorization, and the `paired-assessment-cleanup` Cron job are enabled.
3. Add every variable from `.env.example` to Vercel. Use the Supabase secret key only as a server-side variable; never prefix it with `NEXT_PUBLIC_`.
4. Deploy to Vercel and set `NEXT_PUBLIC_APP_URL` to the HTTPS production origin.
5. Perform a two-computer rehearsal in current desktop Chrome and Safari. Fullscreen requires a user gesture and cannot create an operating-system-level kiosk.

## Verification

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
npm.cmd run build
npx.cmd playwright install chromium webkit
npm.cmd run test:e2e
supabase test db
```

The Playwright enrollment test mocks the backend and can run without Supabase. Full two-participant workflow testing requires a migrated test project and short timer values published from the researcher console.

## Data and security notes

- Participant and admin mutations use database functions that validate the current workflow stage.
- RLS restricts durable pair records and private Realtime topics. Keystrokes and integrity events are append-only for participants and readable only by researchers.
- Keystrokes are collected only by listeners attached to the chat and final-story textareas. ID, consent, attention, quiz, admin, other tabs, and other applications are outside the logger’s scope.
- Event batches are stored temporarily in IndexedDB and sent idempotently. Chat submission remains independent if telemetry is temporarily offline.
- Issued IDs are treated as pseudonymous credentials. Use high-entropy IDs and do not reuse codes across studies.

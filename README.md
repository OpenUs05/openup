# OpenUS

Consent-based transparency app for couples. Each person has their own account on their own phone; nothing is shared until both agree.

## What works
- Email + password accounts (scrypt-hashed), 120-day sessions
- Pairing two phones with a 6-character invite code or invite link
- Live sync every 5 seconds: agreements (request → partner approves), check-ins and replies, trusted contacts
- Real location sharing on a map (opt-in per person), safe places with automatic arrive/leave alerts
- "I need help" alert, pause/leave connection, 30-day movement history
- Push notifications (Android, desktop, and iPhone once added to the home screen)
- Installable PWA with offline shell

## Layout
- `public/` – the app (single page), service worker, manifest, icons
- `netlify/functions/api/` – API (`/api/*`), storage in Netlify Blobs
- `test/` – `npm test` runs API tests; `node test/dev-server.mjs` runs the app locally with in-memory storage

## Environment (set in Netlify)
`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` for push notifications.

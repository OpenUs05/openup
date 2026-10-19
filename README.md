# OpenUS

Your OpenUS app, unchanged, plus an add-on for **two-phone sync** and **live GPS arrive/leave notifications**.

- `public/index.html` – your OpenUS_App.html, exactly as designed, plus one line at the end that loads the add-on
- `public/index-1.html` – your earlier OpenUS file, same one-line addition
- `public/openus-sync.js` – the add-on (sync codes, live GPS card, pinned safe places, notifications)
- `original/` – untouched copies of both files
- `netlify/functions/api/` – sync + GPS server (Netlify Functions + Blobs)

Push notifications use `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` set in Netlify.

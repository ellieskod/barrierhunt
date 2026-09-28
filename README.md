# Barrier hunt

Live photo wall for accessibility lecture. Node only, no dependencies, no database.
Everything is kept in memory and disappears when the server restarts or redeploys.

## Deploy on Railway
1. Put this folder in a GitHub repo and create a Railway project from it
   (Railway runs `npm start` automatically).
2. In Railway > Settings > Networking, generate a public domain.

## Use in the lecture
- Students: open the URL on their phones.
- Projector: open `https://your-url/?present` (shows QR code and join link).
- Moderation: open `https://your-url/?admin=asecretkey` to get delete buttons.
- Clear the wall before class:
  curl -X POST "https://your-url/api/reset?key=asecretkey"
- To change the secret, set `ADMIN_KEY` env var on Railway or redeploy.

Run locally: `node server.js`, then open http://localhost:3000

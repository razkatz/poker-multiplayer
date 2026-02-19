# ♠ Texas Hold'em — Multiplayer

Full-stack multiplayer Texas Hold'em poker. Up to 9 players per table, real-time via Socket.io.

---

## Project Structure

```
poker-multiplayer/
├── package.json
├── src/
│   ├── server.js       # Express + Socket.io server
│   └── game.js         # Poker engine (deck, hand eval, game logic)
└── public/
    └── index.html      # Full frontend (lobby + game)
```

---

## Run Locally

```bash
npm install
npm run dev        # uses nodemon for auto-reload
# OR
npm start          # plain node
```

Open http://localhost:3000 in multiple browser tabs to test multiplayer.

---

## Deploy to Railway (Recommended — Free)

1. Push to GitHub:
   ```bash
   git init
   git add .
   git commit -m "Initial poker game"
   gh repo create poker-game --public --push
   ```

2. Go to https://railway.app → **New Project → Deploy from GitHub**

3. Select your repo. Railway auto-detects Node.js and runs `npm start`.

4. Once deployed, Railway gives you a public URL like:
   `https://poker-game-production.up.railway.app`

5. Share that URL with friends — they join with the room code.

---

## Deploy to Render (Free)

1. Push to GitHub (same as above).

2. Go to https://render.com → **New → Web Service**

3. Connect your repo. Set:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Environment:** Node

4. Deploy. You'll get a public URL.

> ⚠️ Render free tier spins down after 15 min of inactivity. Railway is better for always-on.

---

## Deploy to Vercel ⚠️

Vercel is **not recommended** for this project. It's serverless and doesn't support persistent WebSocket connections (Socket.io needs a long-lived server). Use Railway or Render instead.

---

## How to Play

1. **Host** opens the app → clicks **CREATE TABLE** → shares the room link or 6-character code
2. **Friends** open the link → enter their name → click **JOIN TABLE**
3. Host clicks **DEAL** to start each hand
4. Play Texas Hold'em — Fold / Check / Call / Raise / All In
5. Use the built-in chat to trash-talk 🃏

---

## Features

- ✅ Up to 9 players per table
- ✅ Real-time via Socket.io
- ✅ Full Texas Hold'em rules (blinds, betting rounds, showdown)
- ✅ Hand evaluator (Royal Flush → High Card)
- ✅ Invite link system (share URL = auto-join room)
- ✅ In-game chat
- ✅ Reconnect support (rejoin mid-hand)
- ✅ Dealer button, side pots, all-in handling
- ✅ Hand history log

---

## Extending the Game

Some ideas for next features:
- [ ] Spectator mode
- [ ] Player avatars / emojis
- [ ] Tournament mode (eliminations)
- [ ] Sound effects
- [ ] Mobile responsive polish
- [ ] Persistent leaderboard (add a DB like SQLite or Postgres)

# StudyMate AI — backend

A tiny Express server whose only job is to hold your OpenRouter API key
and forward chat requests to it. The frontend never sees the key.

```
User → Frontend (index.html) → Backend (this folder, key hidden) → OpenRouter
```

## 1. Where your API key goes

1. Get a key at https://openrouter.ai/keys
2. In this `backend/` folder, copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
3. Open `.env` and paste your key into `OPENROUTER_API_KEY=`.

**That's it — that's the only file the key ever lives in.** `.env` is
already listed in `.gitignore`, so it won't be committed or uploaded
anywhere by accident. Never put the key in `chat.js`, `server.js`,
or any frontend file.

## 2. Run it locally

```bash
cd backend
npm install
npm start
```

You should see `StudyMate AI backend listening on port 3000`.
Test it:

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"question":"Explain recursion simply"}'
```

Then in the frontend's `config.js`, make sure:
```js
const STUDYMATE_BACKEND_URL = "http://localhost:3000/api/chat";
```
Open `index.html` and ask the AI Tutor something — it'll go through this
server now, with no key prompt anywhere in the UI.

## 3. Deploy it (so real users can reach it)

Any Node host works. Render's free tier is the easiest:

1. Push this `backend/` folder to its own GitHub repo (or a subfolder of
   your project's repo).
2. On https://render.com → **New → Web Service** → connect the repo.
3. Settings:
   - **Root directory:** `backend` (if it's a subfolder)
   - **Build command:** `npm install`
   - **Start command:** `npm start`
4. Under **Environment**, add the same variables from `.env`:
   - `OPENROUTER_API_KEY` = your real key
   - `OPENROUTER_MODEL` = e.g. `openai/gpt-4o-mini`
   - `ALLOWED_ORIGINS` = your deployed frontend URL, e.g.
     `https://your-username.github.io`
5. Deploy. Render gives you a URL like
   `https://studymate-ai-backend.onrender.com`.
6. Back in the frontend's `config.js`, change the line to:
   ```js
   const STUDYMATE_BACKEND_URL = "https://studymate-ai-backend.onrender.com/api/chat";
   ```
7. Redeploy the frontend (GitHub Pages / Netlify). Done — users open
   the site and chat, no key prompt, no exposed key.

## Notes

- `ALLOWED_ORIGINS` restricts which websites are allowed to call your
  backend (CORS). Set it to your real frontend URL(s) once deployed,
  instead of leaving it as `*`, so strangers can't point their own
  site at your backend and spend your credits.
- A simple per-IP rate limit (15 requests/minute) is already wired up
  in `server.js` — tune `windowMs`/`max` there if you want it looser
  or stricter.
- Free Render web services sleep after inactivity and take a few
  seconds to wake up on the first request — normal, not a bug.

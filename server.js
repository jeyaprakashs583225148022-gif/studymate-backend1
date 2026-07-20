require("dotenv").config();

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const chatRoute = require("./routes/chat");
const readUrlRoute = require("./routes/readUrl");
const exportRoute = require("./routes/export");

const app = express();
const PORT = process.env.PORT || 3000;

// Render (and most hosts) sit behind a reverse proxy, which sets the
// X-Forwarded-For header. Without this, express-rate-limit throws a
// validation error on every request and the API returns 502s.
app.set("trust proxy", 1);

// --- CORS: only allow your own frontend(s) to call this API ---
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: allowedOrigins.includes("*") ? true : allowedOrigins
}));

// Raised from 10kb so a few attached photos (sent as base64 data-URLs) and
// pasted file/page text can actually fit in the request body.
app.use(express.json({ limit: "15mb" }));

// --- Basic rate limiting so one visitor can't burn through your credits ---
const chatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 15,             // 15 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please slow down and try again in a bit." }
});
const readUrlLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please slow down and try again in a bit." }
});
// File generation (docx/xlsx/pptx/zip) is heavier on the server than a
// normal chat reply, so it gets its own, slightly tighter limit.
const exportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many export requests — please slow down and try again in a bit." }
});

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "StudyMate AI backend" });
});

app.use("/api", chatLimiter, chatRoute);
app.use("/api", readUrlLimiter, readUrlRoute);
app.use("/api", exportLimiter, exportRoute);

app.listen(PORT, () => {
  console.log(`StudyMate AI backend listening on port ${PORT}`);
});

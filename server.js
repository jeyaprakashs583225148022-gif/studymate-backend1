require("dotenv").config();

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const chatRoute = require("./routes/chat");

const app = express();
const PORT = process.env.PORT || 3000;

// --- CORS: only allow your own frontend(s) to call this API ---
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: allowedOrigins.includes("*") ? true : allowedOrigins
}));

app.use(express.json({ limit: "10kb" }));

// --- Basic rate limiting so one visitor can't burn through your credits ---
const chatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 15,             // 15 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please slow down and try again in a bit." }
});

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "StudyMate AI backend" });
});

app.use("/api", chatLimiter, chatRoute);

app.listen(PORT, () => {
  console.log(`StudyMate AI backend listening on port ${PORT}`);
});

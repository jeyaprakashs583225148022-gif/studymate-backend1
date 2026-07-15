const express = require("express");
const router = express.Router();

// ============================================================
//  This is the ONLY place the API key is used. It is read from
//  the environment (see .env) and never sent to the browser.
// ============================================================
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

router.post("/chat", async (req, res) => {
  try {
    const question = (req.body?.question || "").toString().trim();

    if (!question) {
      return res.status(400).json({ error: "Missing 'question' in request body." });
    }
    if (question.length > 2000) {
      return res.status(400).json({ error: "Question is too long (max 2000 characters)." });
    }
    if (!OPENROUTER_API_KEY) {
      // Server isn't configured yet — tell the caller clearly instead of leaking a stack trace.
      return res.status(500).json({ error: "Server is not configured with an API key yet." });
    }

    const upstream = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + OPENROUTER_API_KEY, // <-- key added here, server-side only
        "HTTP-Referer": process.env.PUBLIC_SITE_URL || "https://studymate.ai",
        "X-Title": "StudyMate AI"
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          {
            role: "system",
            content: "You are a concise, friendly study tutor. Answer clearly for a student, using short paragraphs or a short list where helpful."
          },
          { role: "user", content: question }
        ]
      })
    });

    if (!upstream.ok) {
      let detail = "";
      try { detail = (await upstream.json())?.error?.message || ""; } catch (_) { /* ignore */ }
      return res.status(502).json({ error: "Upstream AI request failed" + (detail ? ": " + detail : "") });
    }

    const data = await upstream.json();
    const answer = data?.choices?.[0]?.message?.content;

    if (!answer) {
      return res.status(502).json({ error: "No answer returned from the AI provider." });
    }

    return res.json({ answer });
  } catch (err) {
    console.error("Chat route error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

module.exports = router;

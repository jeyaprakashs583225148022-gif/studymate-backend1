const express = require("express");
const router = express.Router();

// ============================================================
//  This is the ONLY place the API key is used. It is read from
//  the environment (see .env) and never sent to the browser.
// ============================================================
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-4o";
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
        temperature: 0.3,
        max_tokens: 700, // keeps answers well within a small/free OpenRouter credit balance
        messages: [
          {
            role: "system",
            content: "You are a careful, accurate study tutor. Prioritize correctness over confidence: think through facts, dates, formulas, and calculations step by step before answering, and double-check numeric or logical results before giving them. If you are not sure of something, say so plainly instead of guessing or making it up. Never invent facts, sources, or numbers. Answer clearly for a student. Format your answer for readability: use short paragraphs (2-4 sentences), and switch to a bullet list (lines starting with \"- \") or a numbered list (\"1. \", \"2. \") whenever you're listing steps, parts, or examples. Use **bold** for key terms only, not whole sentences. Don't use headings, tables, or code blocks unless the question is specifically about code."
          },
          { role: "user", content: question }
        ]
      })
    });

    if (!upstream.ok) {
      let detail = "";
      try { detail = (await upstream.json())?.error?.message || ""; } catch (_) { /* ignore */ }
      console.error("OpenRouter request failed:", upstream.status, detail);
      return res.status(502).json({ error: "Upstream AI request failed" + (detail ? ": " + detail : "") });
    }

    const data = await upstream.json();
    let answer = data?.choices?.[0]?.message?.content;

    if (!answer) {
      return res.status(502).json({ error: "No answer returned from the AI provider." });
    }

    // Some models occasionally leak internal moderation/classifier tags
    // (e.g. "User Safety: safe") instead of, or alongside, a real answer.
    // Strip any such lines out before this ever reaches the user.
    answer = answer
      .split("\n")
      .filter(line => !/^\s*(user safety|safety|moderation|classification)\s*:/i.test(line))
      .join("\n")
      .trim();

    if (!answer) {
      return res.status(502).json({ error: "The model returned no usable answer." });
    }

    return res.json({ answer });
  } catch (err) {
    console.error("Chat route error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

module.exports = router;

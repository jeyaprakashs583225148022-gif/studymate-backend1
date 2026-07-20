const express = require("express");
const router = express.Router();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// gemini-2.5-flash was retired for new API keys — gemini-3.5-flash is the
// current stable, generally-available model (also multimodal: handles text
// and images in one model, so no separate "vision model" is needed).
const GEMINI_MODEL   = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const GEMINI_URL      = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const MAX_IMAGES = 4;

const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const TAVILY_URL     = "https://api.tavily.com/search";

const REALTIME_PATTERNS = [
  /\b(today|tonight|this (week|month|year)|right now|at the moment|currently|now)\b/i,
  /\b(latest|recent|new|update|just (released|announced|happened))\b/i,
  /\b(news|breaking|trending|viral)\b/i,
  /\b(weather|temperature|forecast)\b/i,
  /\b(price|cost|rate|stock|crypto|bitcoin|market)\b/i,
  /\b(who (is|are|was|were) (the )?(current|new|latest|present))\b/i,
  /\b(when (is|was|will) .{0,40} (held|happen|start|end|release|come out))\b/i,
  /\b(20(2[4-9]|[3-9]\d))\b/,
  /\b(exam date|result|syllabus|admit card|cutoff|notification)\b/i,
  /\b(election|government|minister|president|prime minister|CEO|appointed)\b/i,
  /\b(score|match|tournament|fixture|ipl|world cup|olympics)\b/i,
];

function needsSearch(question) {
  if (!TAVILY_API_KEY) return false;
  return REALTIME_PATTERNS.some(re => re.test(question));
}

async function fetchSearchContext(query) {
  try {
    const res = await fetch(TAVILY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + TAVILY_API_KEY
      },
      body: JSON.stringify({
        query,
        max_results: 5,
        search_depth: "basic",
        include_answer: true
      }),
      signal: AbortSignal.timeout(6000)
    });

    if (!res.ok) {
      console.warn("Tavily search returned", res.status);
      return "";
    }

    const data = await res.json();

    let context = "";
    if (data.answer) {
      context += `Summary: ${data.answer}\n\n`;
    }

    const results = Array.isArray(data.results) ? data.results : [];
    if (!results.length && !context) return "";

    const lines = results.map((item, i) =>
      `[${i + 1}] ${item.title}\n${item.content || ""}\nSource: ${item.url}`
    );

    context += lines.join("\n\n");
    return context;

  } catch (err) {
    console.warn("Tavily search error:", err.message);
    return "";
  }
}

router.post("/chat", async (req, res) => {
  try {
    const question = (req.body?.question || "").toString().trim();

    if (!question) {
      return res.status(400).json({ error: "Missing 'question' in request body." });
    }
    if (question.length > 2000) {
      return res.status(400).json({ error: "Question is too long (max 2000 characters)." });
    }

    const MAX_HISTORY_MESSAGES = 12;
    const MAX_HISTORY_CHARS    = 4000;
    const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];
    let historyCharBudget = MAX_HISTORY_CHARS;
    const history = rawHistory
      .slice(-MAX_HISTORY_MESSAGES)
      .map(m => {
        const role    = m?.role === "assistant" ? "assistant" : "user";
        let   content = (m?.content || "").toString().trim();
        if (!content) return null;
        if (content.length > historyCharBudget) content = content.slice(0, historyCharBudget);
        historyCharBudget -= content.length;
        if (historyCharBudget <= 0) return null;
        return { role, content };
      })
      .filter(Boolean);

    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "Server is not configured with an API key yet." });
    }

    // --- Optional attachments: photos, an uploaded file's text, or a link's text ---
    const images = Array.isArray(req.body?.images)
      ? req.body.images.filter(u => typeof u === "string" && u.startsWith("data:image/")).slice(0, MAX_IMAGES)
      : [];

    let fileContext = null;
    if (req.body?.fileContext && typeof req.body.fileContext.text === "string") {
      fileContext = {
        name: (req.body.fileContext.name || "uploaded file").toString().slice(0, 120),
        text: req.body.fileContext.text.toString().slice(0, 6000) // trimmed to conserve tokens on the free tier
      };
    }

    let urlContext = null;
    if (req.body?.urlContext && typeof req.body.urlContext.content === "string") {
      urlContext = {
        url: (req.body.urlContext.url || "").toString().slice(0, 500),
        title: (req.body.urlContext.title || "").toString().slice(0, 200),
        content: req.body.urlContext.content.toString().slice(0, 4000) // trimmed to conserve tokens on the free tier
      };
    }

    let searchContext = "";
    let searchWasUsed = false;
    if (!images.length && needsSearch(question)) {
      searchContext = await fetchSearchContext(question);
      searchWasUsed = !!searchContext;
    }

    const basePersonality =
      "You are a careful, accurate study tutor. " +
      "Prioritize correctness over confidence: think through facts, dates, formulas, " +
      "and calculations step by step before answering, and double-check numeric or " +
      "logical results before giving them. If you are not sure of something, say so " +
      "plainly instead of guessing or making it up. Never invent facts, sources, or numbers. " +
      "Answer clearly for a student. Format your answer for readability: use short paragraphs " +
      "(2-4 sentences), and switch to a bullet list (lines starting with \"- \") or a numbered " +
      "list (\"1. \", \"2. \") whenever you are listing steps, parts, or examples. Use **bold** " +
      "for key terms only, not whole sentences. Don't use headings, tables, or code blocks " +
      "unless the question is specifically about code. Keep the tone modern, warm, and " +
      "encouraging — like a friendly, upbeat tutor texting a student, not a textbook. " +
      "Sprinkle in a few relevant emojis where they naturally fit (e.g. 👋 for greetings, " +
      "💡 for a key idea, ✅ for a completed step, 📚 for study tips) — enough to feel " +
      "lively, but never more than a handful per answer, and never inside code, formulas, " +
      "or numeric results. Earlier turns of this conversation may be included before the " +
      "latest question — use them to resolve references like \"he\", \"that\", or \"the " +
      "second one\", and to keep answers consistent with what was already said.";

    let systemContent = basePersonality;

    if (searchWasUsed) {
      systemContent +=
        "\n\n--- LIVE WEB SEARCH RESULTS (fetched just now for this question) ---\n" +
        searchContext +
        "\n--- END OF SEARCH RESULTS ---\n\n" +
        "Use the search results above to ground your answer in current, accurate information. " +
        "Cite the source number in brackets (e.g. [1]) when you use a fact from a result. " +
        "If the search results don't cover the question well, use your own knowledge and say so.";
    }

    if (fileContext) {
      systemContent +=
        `\n\n--- TEXT FROM A FILE THE STUDENT UPLOADED (\"${fileContext.name}\") ---\n` +
        fileContext.text +
        "\n--- END OF FILE ---\n\n" +
        "Use the file content above to answer the student's question about it (e.g. summarizing, " +
        "explaining, or quizzing them on it). If the question doesn't relate to the file, ignore it.";
    }

    if (urlContext) {
      systemContent +=
        `\n\n--- TEXT READ FROM A LINK THE STUDENT SHARED (${urlContext.title || urlContext.url}) ---\n` +
        urlContext.content +
        "\n--- END OF PAGE CONTENT ---\n\n" +
        "The student pasted the link above; its page content was fetched automatically. Use it to answer " +
        "their question (e.g. summarize it, explain it, or answer what they asked about it).";
    }

    if (images.length) {
      systemContent +=
        "\n\nThe student attached photo(s) — look carefully (handwriting, diagrams, textbook pages, " +
        "homework, objects/scenes, faces) and use them to answer.\n\n" +
        "IMPORTANT on naming real people: you have strong visual recognition, so if the photo clearly " +
        "shows a well-known public figure — a political leader, historical figure, actor, athlete, or " +
        "other celebrity you recognize with genuine confidence — go ahead and name them and share a " +
        "couple of accurate, relevant facts. Do NOT hedge or refuse to name someone just because they're " +
        "famous. The caution only applies to people who are NOT public figures (e.g. a random photo of an " +
        "ordinary private person): for those, don't guess an identity — describe what you see and ask the " +
        "student who it is instead. Never invent a name, title, or biography for anyone.";
    }

    // Gemini uses "user"/"model" roles (not "assistant") and wraps each
    // message's content in a "parts" array instead of a plain string.
    const historyContents = history.map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }]
    }));

    // Build the final user turn's parts: the question text, plus any
    // attached photos as inline base64 data (Gemini's multimodal format).
    const userParts = [{ text: question }];
    for (const dataUrl of images) {
      const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (match) {
        userParts.push({ inline_data: { mime_type: match[1], data: match[2] } });
      }
    }

    const upstream = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemContent }] },
        contents: [
          ...historyContents,
          { role: "user", parts: userParts }
        ],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 1200
        }
      })
    });

    if (!upstream.ok) {
      let detail = "";
      try { detail = (await upstream.json())?.error?.message || ""; } catch (_) { /* ignore */ }
      console.error("Gemini request failed:", upstream.status, detail);

      // Free-tier Gemini keys share a requests-per-minute budget too — give a
      // clear, distinct message instead of a generic failure the frontend
      // would otherwise mask with a canned offline answer that looks broken.
      if (upstream.status === 429) {
        return res.status(429).json({
          error: "rate_limited",
          message: "The AI is at its free-tier request limit for the next few seconds — please wait about 10-15 seconds and try again."
        });
      }

      return res.status(502).json({ error: "Upstream AI request failed" + (detail ? ": " + detail : "") });
    }

    const data = await upstream.json();

    // Gemini can refuse/stop for safety reasons with no text content at all —
    // surface that distinctly instead of a generic "no answer" message.
    const finishReason = data?.candidates?.[0]?.finishReason;
    let answer = (data?.candidates?.[0]?.content?.parts || [])
      .map(p => p.text || "")
      .join("")
      .trim();

    if (!answer) {
      if (finishReason === "SAFETY" || finishReason === "PROHIBITED_CONTENT") {
        return res.status(502).json({ error: "The AI couldn't answer that question." });
      }
      return res.status(502).json({ error: "No answer returned from the AI provider." });
    }

    answer = answer
      .split("\n")
      .filter(line => !/^\s*(user safety|safety|moderation|classification)\s*:/i.test(line))
      .join("\n")
      .trim();

    if (!answer) {
      return res.status(502).json({ error: "The model returned no usable answer." });
    }

    return res.json({ answer, searchUsed: searchWasUsed });

  } catch (err) {
    console.error("Chat route error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

module.exports = router;

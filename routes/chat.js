const express = require("express");
const router = express.Router();

// ============================================================
//  API credentials — all read from environment variables.
//  Never hardcode keys here. Never commit .env to git.
// ============================================================
const GROQ_API_KEY          = process.env.GROQ_API_KEY;
const GROQ_MODEL            = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
const GROQ_URL              = "https://api.groq.com/openai/v1/chat/completions";

const GOOGLE_SEARCH_API_KEY = process.env.GOOGLE_SEARCH_API_KEY;
const GOOGLE_SEARCH_CX      = process.env.GOOGLE_SEARCH_ENGINE_ID;
const GOOGLE_SEARCH_URL     = "https://www.googleapis.com/customsearch/v1";

// ============================================================
//  Decide if a question actually needs a live web search.
//  Questions about current events, news, prices, recent dates,
//  or anything time-sensitive get searched. Pure study/concept
//  questions ("what is photosynthesis?") skip the search so the
//  answer arrives faster and doesn't waste quota.
// ============================================================
const REALTIME_PATTERNS = [
  /\b(today|tonight|this (week|month|year)|right now|at the moment|currently|now)\b/i,
  /\b(latest|recent|new|update|just (released|announced|happened))\b/i,
  /\b(news|breaking|trending|viral)\b/i,
  /\b(weather|temperature|forecast)\b/i,
  /\b(price|cost|rate|stock|crypto|bitcoin|market)\b/i,
  /\b(who (is|are|was|were) (the )?(current|new|latest|present))\b/i,
  /\b(when (is|was|will) .{0,40} (held|happen|start|end|release|come out))\b/i,
  /\b(20(2[4-9]|[3-9]\d))\b/,   // years 2024 and beyond
  /\b(exam date|result|syllabus|admit card|cutoff|notification)\b/i,
  /\b(election|government|minister|president|prime minister|CEO|appointed)\b/i,
  /\b(score|match|tournament|fixture|ipl|world cup|olympics)\b/i,
];

function needsSearch(question) {
  if (!GOOGLE_SEARCH_API_KEY || !GOOGLE_SEARCH_CX) return false;
  return REALTIME_PATTERNS.some(re => re.test(question));
}

// ============================================================
//  Fetch the top Google search results for a query.
//  Returns a plain-text block with titles + snippets so the
//  model can read them as context. Returns "" on any failure
//  so the main handler can fall back gracefully.
// ============================================================
async function fetchSearchContext(query) {
  try {
    const url = new URL(GOOGLE_SEARCH_URL);
    url.searchParams.set("key", GOOGLE_SEARCH_API_KEY);
    url.searchParams.set("cx",  GOOGLE_SEARCH_CX);
    url.searchParams.set("q",   query);
    url.searchParams.set("num", "5");          // top 5 results is plenty
    url.searchParams.set("safe", "active");

    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      console.warn("Google Search returned", res.status);
      return "";
    }

    const data = await res.json();
    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) return "";

    // Format as numbered list so the model can refer back to a source by number.
    const lines = items.map((item, i) =>
      `[${i + 1}] ${item.title}\n${item.snippet || ""}\nSource: ${item.link}`
    );

    return lines.join("\n\n");
  } catch (err) {
    console.warn("Google Search fetch error:", err.message);
    return "";   // non-fatal — answer without search context
  }
}

// ============================================================
//  POST /chat
// ============================================================
router.post("/chat", async (req, res) => {
  try {
    const question = (req.body?.question || "").toString().trim();

    if (!question) {
      return res.status(400).json({ error: "Missing 'question' in request body." });
    }
    if (question.length > 2000) {
      return res.status(400).json({ error: "Question is too long (max 2000 characters)." });
    }

    // Validate and trim conversation history sent by the frontend.
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

    if (!GROQ_API_KEY) {
      return res.status(500).json({ error: "Server is not configured with an API key yet." });
    }

    // --- Optional: Google Search for realtime context ---
    let searchContext = "";
    let searchWasUsed = false;
    if (needsSearch(question)) {
      searchContext = await fetchSearchContext(question);
      searchWasUsed = !!searchContext;
    }

    // Build the system prompt. If we have live search results, inject them
    // so the model grounds its answer in fresh data. Otherwise the model
    // uses its own training knowledge (fine for timeless study topics).
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

    const systemContent = searchWasUsed
      ? basePersonality +
        "\n\n--- LIVE WEB SEARCH RESULTS (fetched just now for this question) ---\n" +
        searchContext +
        "\n--- END OF SEARCH RESULTS ---\n\n" +
        "Use the search results above to ground your answer in current, accurate information. " +
        "Cite the source number in brackets (e.g. [1]) when you use a fact from a result. " +
        "If the search results don't cover the question well, use your own knowledge and say so."
      : basePersonality;

    const upstream = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + GROQ_API_KEY
      },
      body: JSON.stringify({
        model:       GROQ_MODEL,
        temperature: 0.3,
        max_tokens:  2000,
        messages: [
          { role: "system", content: systemContent },
          ...history,
          { role: "user", content: question }
        ]
      })
    });

    if (!upstream.ok) {
      let detail = "";
      try { detail = (await upstream.json())?.error?.message || ""; } catch (_) { /* ignore */ }
      console.error("Groq request failed:", upstream.status, detail);
      return res.status(502).json({ error: "Upstream AI request failed" + (detail ? ": " + detail : "") });
    }

    const data = await upstream.json();
    let answer = data?.choices?.[0]?.message?.content;

    if (!answer) {
      return res.status(502).json({ error: "No answer returned from the AI provider." });
    }

    // Strip any internal moderation/classifier lines some models leak.
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

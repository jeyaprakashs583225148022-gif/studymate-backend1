const express = require("express");
const router = express.Router();

const GROQ_API_KEY   = process.env.GROQ_API_KEY;
const GROQ_MODEL     = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
const GROQ_URL       = "https://api.groq.com/openai/v1/chat/completions";

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

    if (!GROQ_API_KEY) {
      return res.status(500).json({ error: "Server is not configured with an API key yet." });
    }

    let searchContext = "";
    let searchWasUsed = false;
    if (needsSearch(question)) {
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
      "encouraging â€” like a friendly, upbeat tutor texting a student, not a textbook. " +
      "Sprinkle in a few relevant emojis where they naturally fit (e.g. ðŸ‘‹ for greetings, " +
      "ðŸ’¡ for a key idea, âœ… for a completed step, ðŸ“š for study tips) â€” enough to feel " +
      "lively, but never more than a handful per answer, and never inside code, formulas, " +
      "or numeric results. Earlier turns of this conversation may be included before the " +
      "latest question â€” use them to resolve references like \"he\", \"that\", or \"the " +
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

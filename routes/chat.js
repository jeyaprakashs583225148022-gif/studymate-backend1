const express = require("express");
const router = express.Router();

const GROQ_API_KEY   = process.env.GROQ_API_KEY;
const GROQ_MODEL     = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
// Used automatically instead of GROQ_MODEL whenever the person attaches a
// photo, since the regular text model can't see images. qwen/qwen3.6-27b is
// Groq's current vision-capable chat model (Llama 4 Scout/Maverick were
// deprecated) — override via env if Groq's lineup has moved on since.
const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || "qwen/qwen3.6-27b";
const GROQ_URL       = "https://api.groq.com/openai/v1/chat/completions";
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

    if (!GROQ_API_KEY) {
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
        text: req.body.fileContext.text.toString().slice(0, 12000)
      };
    }

    let urlContext = null;
    if (req.body?.urlContext && typeof req.body.urlContext.content === "string") {
      urlContext = {
        url: (req.body.urlContext.url || "").toString().slice(0, 500),
        title: (req.body.urlContext.title || "").toString().slice(0, 200),
        content: req.body.urlContext.content.toString().slice(0, 8000)
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
        "\n\nThe student has also attached one or more photos to this message — look at them carefully " +
        "(e.g. read handwriting, diagrams, textbook pages, homework problems, or objects/scenes) and use them " +
        "to answer.\n\n" +
        "IMPORTANT — do not guess at real people's identities: you cannot reliably recognize who a specific " +
        "real person in a photo is, and confidently naming the wrong person (or inventing biographical details " +
        "about them) is much worse than saying you're not sure. So if the photo shows a person and the student " +
        "asks who they are: do NOT state a specific name, movie, or biography as fact unless there is " +
        "unmistakable on-image text confirming it (e.g. a name tag, caption, or credits). Otherwise, say plainly " +
        "that you can't reliably identify real people from photos, and instead describe what you *can* see " +
        "(appearance, setting, clothing, mood, any visible text) and offer to help if they tell you who it is. " +
        "Never fabricate a name, film, or backstory to sound more helpful.";
    }

    // Build the final user turn. Plain text when there's no image; an
    // OpenAI-style multimodal content array (text + image_url parts) when
    // there is one, which is what Groq's vision models expect.
    const userTurn = images.length
      ? { role: "user", content: [
            { type: "text", text: question },
            ...images.map(url => ({ type: "image_url", image_url: { url } }))
          ] }
      : { role: "user", content: question };

    const upstream = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + GROQ_API_KEY
      },
      body: JSON.stringify({
        model:       images.length ? GROQ_VISION_MODEL : GROQ_MODEL,
        temperature: 0.3,
        max_tokens:  2000,
        // qwen/qwen3.6-27b (our vision model) is a reasoning model — without
        // this it can return its raw "<think>...</think>" scratch-work as
        // part of the answer, which looked like a wrong/garbled reply.
        // "hidden" makes Groq return only the final answer.
        ...(images.length ? { reasoning_format: "hidden" } : {}),
        messages: [
          { role: "system", content: systemContent },
          // Vision models are pickier about mixed-content history, and a
          // photo's own message already carries all the context it needs,
          // so skip prior turns on image requests to keep it reliable.
          ...(images.length ? [] : history),
          userTurn
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

    // Belt-and-braces: strip any reasoning scratch-work the model still
    // included (e.g. <think>...</think>) even though we asked Groq to hide it,
    // so it never leaks into what the student sees.
    answer = answer.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

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

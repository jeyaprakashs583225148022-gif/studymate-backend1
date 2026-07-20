const express = require("express");
const router = express.Router();

// Only http/https, and blocks obvious attempts to reach internal/private
// network addresses (localhost, 127.0.0.1, link-local, private ranges),
// since this endpoint fetches a URL on the server's behalf.
function isSafeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;

  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local")) return false;

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number);
    if (a === 127 || a === 10 || a === 0) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
  }
  if (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return false;

  return true;
}

// Very small, dependency-free HTML -> plain text extractor. Good enough to
// hand a page's readable content to the AI without pulling in a heavy
// parsing library for a hackathon project.
function htmlToText(html) {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
  return text;
}

// Returns { videoId } if the URL is a YouTube watch/share link, else null.
function getYouTubeVideoId(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    if (host === "youtu.be") {
      const id = u.pathname.slice(1);
      return id ? id : null;
    }
    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      if (u.pathname === "/watch") return u.searchParams.get("v");
      const shortsMatch = u.pathname.match(/^\/shorts\/([^/]+)/);
      if (shortsMatch) return shortsMatch[1];
    }
    return null;
  } catch (e) {
    return null;
  }
}

router.post("/read-url", async (req, res) => {
  try {
    const rawUrl = (req.body?.url || "").toString().trim();
    if (!rawUrl) return res.status(400).json({ error: "Missing 'url' in request body." });
    if (!isSafeUrl(rawUrl)) return res.status(400).json({ error: "That link can't be fetched." });

    // YouTube pages are rendered by JavaScript, so a plain HTML fetch comes
    // back almost empty. Use YouTube's public oEmbed endpoint instead, which
    // reliably returns the title and channel name without needing an API key.
    const videoId = getYouTubeVideoId(rawUrl);
    if (videoId) {
      try {
        const oembedRes = await fetch(
          "https://www.youtube.com/oembed?url=" + encodeURIComponent(rawUrl) + "&format=json",
          { signal: AbortSignal.timeout(8000) }
        );
        if (oembedRes.ok) {
          const info = await oembedRes.json();
          const content =
            `Title: ${info.title || "(unknown)"}\n` +
            `Channel: ${info.author_name || "(unknown)"}\n\n` +
            "Note: only the video's title and channel were available automatically — the full video/transcript " +
            "content could not be read, so answer using this metadata plus your general knowledge, and be upfront " +
            "with the student that you don't have the full video content.";
          return res.json({ title: info.title || "", content, url: rawUrl, isYouTube: true });
        }
      } catch (e) {
        // fall through to the generic error below
      }
      return res.status(422).json({ error: "Couldn't fetch details for that YouTube video." });
    }

    const upstream = await fetch(rawUrl, {
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; StudyMateAI/1.0; +https://studymate.ai)" },
      signal: AbortSignal.timeout(8000)
    });

    if (!upstream.ok) {
      return res.status(502).json({ error: "Couldn't open that link (status " + upstream.status + ")." });
    }

    const contentType = upstream.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
      return res.status(415).json({ error: "That link isn't a readable web page (e.g. it's a file download)." });
    }

    const html = await upstream.text();
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? htmlToText(titleMatch[1]).slice(0, 200) : "";

    const content = htmlToText(html).slice(0, 8000);
    if (!content) return res.status(422).json({ error: "Couldn't find readable text on that page." });

    return res.json({ title, content, url: rawUrl });
  } catch (err) {
    console.error("read-url route error:", err.message);
    return res.status(500).json({ error: "Couldn't fetch that link." });
  }
});

module.exports = router;

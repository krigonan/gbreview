/**
 * GBReview.in — Cloudflare Worker
 *
 * Bindings (wrangler.toml):
 *   R2  DATA    → private bucket (stores businesstrial.json, business.json)
 *
 * Secrets (wrangler secret put ...):
 *   GROQ_API_KEY
 *   ADMIN_PASSWORD
 *
 * API routes (all prefixed /api/):
 *   POST /api/register          → save to businesstrial.json
 *   GET  /api/business?b=xx     → get approved business by shortcode
 *   GET  /api/trials            → list pending (admin, bearer auth)
 *   POST /api/approve           → move trial → approved
 *   POST /api/generate          → generate reviews via Groq
 */

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return preflight();

    const url  = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/register"  && request.method === "POST") return handleRegister(request, env);
    if (path === "/api/business"  && request.method === "GET")  return handleGetBusiness(request, env);
    if (path === "/api/trials"    && request.method === "GET")  return handleTrials(request, env);
    if (path === "/api/approve"   && request.method === "POST") return handleApprove(request, env);
    if (path === "/api/generate"  && request.method === "POST") return handleGenerate(request, env);

    return j({ error: "Not found" }, 404);
  },
};

// ── R2 helpers ─────────────────────────────────────────────

async function r2Read(env, key) {
  const obj = await env.DATA.get(key);
  if (!obj) return [];
  try { return JSON.parse(await obj.text()); } catch { return []; }
}

async function r2Write(env, key, data) {
  await env.DATA.put(key, JSON.stringify(data, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
}

// ── Handlers ───────────────────────────────────────────────

async function handleRegister(request, env) {
  let body;
  try { body = await request.json(); } catch { return j({ error: "Invalid JSON" }, 400); }

  const { businessName, placeId, message, ownerName, ownerContact } = body;
  if (!businessName || !placeId || !ownerName || !ownerContact)
    return j({ error: "businessName, placeId, ownerName and ownerContact are required" }, 400);

  // Check for duplicate Place ID in trials and approved
  const [trials, approved] = await Promise.all([
    r2Read(env, "businesstrial.json"),
    r2Read(env, "business.json"),
  ]);

  const allPids = [...trials, ...approved].map(x => x.pid.toLowerCase());
  if (allPids.includes(placeId.trim().toLowerCase()))
    return j({ error: "This Place ID is already registered." }, 409);

  const b     = randomCode();
  const entry = {
    b,
    businessName : businessName.trim(),
    pid          : placeId.trim(),
    message      : (message || "").trim(),
    ownerName    : ownerName.trim(),
    ownerContact : ownerContact.trim(),
    timestamp    : new Date().toISOString(),
  };

  trials.push(entry);
  await r2Write(env, "businesstrial.json", trials);
  return j({ success: true, b }, 201);
}

async function handleGetBusiness(request, env) {
  const b = new URL(request.url).searchParams.get("b");
  if (!b) return j({ error: "b is required" }, 400);

  const approved = await r2Read(env, "business.json");
  const biz      = approved.find(x => x.b === b);
  if (!biz) return j({ error: "Business not found or not yet approved" }, 404);
  return j(biz);
}

async function handleTrials(request, env) {
  if (!checkAuth(request, env)) return j({ error: "Unauthorized" }, 401);
  return j(await r2Read(env, "businesstrial.json"));
}

async function handleApprove(request, env) {
  let body;
  try { body = await request.json(); } catch { return j({ error: "Invalid JSON" }, 400); }

  const { b, password } = body;
  if (!b)                          return j({ error: "b is required" }, 400);
  if (password !== env.ADMIN_PASSWORD) return j({ error: "Wrong password" }, 401);

  const [trials, approved] = await Promise.all([
    r2Read(env, "businesstrial.json"),
    r2Read(env, "business.json"),
  ]);

  const idx = trials.findIndex(x => x.b === b);
  if (idx === -1) return j({ error: "Not found in pending list" }, 404);

  const [entry] = trials.splice(idx, 1);
  entry.approvedAt = new Date().toISOString();
  approved.push(entry);

  await Promise.all([
    r2Write(env, "businesstrial.json", trials),
    r2Write(env, "business.json", approved),
  ]);

  return j({ success: true, approved: entry });
}

async function handleGenerate(request, env) {
  const key = env.GROQ_API_KEY;
  if (!key?.startsWith("gsk_"))
    return j({ error: "GROQ_API_KEY not configured" }, 500);

  let body;
  try { body = await request.json(); } catch { return j({ error: "Invalid JSON" }, 400); }

  const { businessName, businessType, rating, items, notes } = body;
  if (!businessName || !rating)
    return j({ error: "businessName and rating are required" }, 400);

  const itemsText = Array.isArray(items) && items.length
    ? items.join(", ") : "the services/products";

  const sentiment = {
    1: "very negative, genuinely disappointed",
    2: "mostly negative, below expectations",
    3: "mixed, average experience",
    4: "positive, satisfied",
    5: "very positive, genuinely delighted",
  };

  const prompt = `Generate exactly 4 different Google reviews for "${businessName}", a ${businessType || "business"}.
Customer: ${rating}/5 stars (${sentiment[rating] ?? "average"}), experienced: ${itemsText}. Extra notes: ${notes || "none"}.
Rules: sound like real humans, vary length (2 short 1-2 sentences, 2 medium 3-4 sentences), mention the items naturally, match sentiment to ${rating} stars, no clichés like "hidden gem" or "must visit", different opener for each review.
Return ONLY a valid JSON array of exactly 4 strings. No markdown, no explanation.`;

  let gr;
  try {
    gr = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method  : "POST",
      headers : { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body    : JSON.stringify({
        model       : "llama-3.3-70b-versatile",
        max_tokens  : 1000,
        temperature : 0.85,
        messages    : [
          { role: "system", content: "Return only valid JSON arrays of strings. No markdown, no preamble." },
          { role: "user",   content: prompt },
        ],
      }),
    });
  } catch (e) { return j({ error: "Failed to reach Groq: " + e.message }, 502); }

  if (!gr.ok) {
    const e = await gr.json().catch(() => ({}));
    return j({ error: e?.error?.message || "Groq error" }, gr.status);
  }

  const data  = await gr.json();
  const raw   = data.choices?.[0]?.message?.content?.trim() ?? "";
  const clean = raw.replace(/```json|```/g, "").trim();

  let reviews;
  try {
    reviews = JSON.parse(clean);
    if (!Array.isArray(reviews) || !reviews.length) throw new Error();
  } catch { return j({ error: "Unexpected model response, try again" }, 502); }

  return j({ reviews });
}

// ── Utils ──────────────────────────────────────────────────

function randomCode() {
  const c = "abcdefghijklmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < 6; i++) s += c[Math.floor(Math.random() * 26)];
  return s;
}

function checkAuth(request, env) {
  return request.headers.get("Authorization") === `Bearer ${env.ADMIN_PASSWORD}`;
}

function j(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type"                : "application/json",
      "Access-Control-Allow-Origin" : "*",
    },
  });
}

function preflight() {
  return new Response(null, {
    status  : 204,
    headers : {
      "Access-Control-Allow-Origin"  : "*",
      "Access-Control-Allow-Methods" : "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers" : "Content-Type, Authorization",
    },
  });
}

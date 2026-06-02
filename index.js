require("dotenv").config();

const express = require("express");
const axios   = require("axios");
const crypto  = require("crypto");
const { OpenAI } = require("openai");
const { createClient } = require("@supabase/supabase-js");

const app = express();

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// =========================
// INIT
// =========================

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// =========================
// MEMORY LAYER
// =========================

const rateLimiterMap    = new Map();
const sessionCacheMap   = new Map();
const intentCacheMap    = new Map();
const processedMessages = new Set();

// =========================
// WHATSAPP SENDER
// =========================

async function sendWhatsApp(to, message) {
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: message }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );
  } catch (err) {
    console.error("WHATSAPP_ERROR:", err.response?.data || err.message);
  }
}

// =========================
// SECURITY (HMAC META)
// =========================

function verifySignature(req) {
  const signature = req.headers["x-hub-signature-256"];
  if (!signature || !req.rawBody) return false;

  const expected = `sha256=${crypto
    .createHmac("sha256", process.env.META_APP_SECRET)
    .update(req.rawBody)
    .digest("hex")}`;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}

// =========================
// UTILITIES
// =========================

function cleanPhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

function detectCountry(phone) {
  if (phone.startsWith("593")) return "ECUADOR";
  if (phone.startsWith("52"))  return "MEXICO";
  if (phone.startsWith("1"))   return "USA";
  if (phone.startsWith("57"))  return "COLOMBIA";
  if (phone.startsWith("34"))  return "SPAIN";
  return "GLOBAL";
}

// =========================
// RATE LIMIT (10 req / min)
// =========================

function rateLimit(phone) {
  const now  = Date.now();
  const data = rateLimiterMap.get(phone) || { count: 0, last: now };

  if (now - data.last > 60000) {
    data.count = 0;
    data.last  = now;
  }

  data.count++;
  rateLimiterMap.set(phone, data);

  return data.count <= 10;
}

// =========================
// INTENT ENGINE (CACHED + SAFE)
// =========================

async function getIntent(text) {
  const key = text.trim().toLowerCase().substring(0, 120);

  if (intentCacheMap.has(key)) {
    return intentCacheMap.get(key);
  }

  try {
    const res = await openai.chat.completions.create({
      model:       "gpt-4o-mini",
      temperature: 0,
      max_tokens:  10,
      messages: [
        {
          role:    "system",
          content: "Responde SOLO: FINANCE, INVENTORY, MARKETING o GENERAL"
        },
        { role: "user", content: text }
      ]
    });

    const raw = res.choices[0].message.content
      .trim()
      .toUpperCase()
      .replace(/[^A-Z]/g, "");

    const VALID  = ["FINANCE", "INVENTORY", "MARKETING", "GENERAL"];
    const intent = VALID.includes(raw) ? raw : "GENERAL";

    intentCacheMap.set(key, intent);
    return intent;

  } catch {
    return "GENERAL";
  }
}

// =========================
// SESSION (SUPABASE SOURCE OF TRUTH)
// =========================

async function getSession(phone) {
  if (sessionCacheMap.has(phone)) {
    return sessionCacheMap.get(phone);
  }

  const { data } = await supabase
    .from("session_state")
    .select("*")
    .eq("phone", phone)
    .maybeSingle();

  if (data) {
    sessionCacheMap.set(phone, data);
    return data;
  }

  const { data: created } = await supabase
    .from("session_state")
    .insert({ phone, state: {}, step: "START" })
    .select()
    .single();

  sessionCacheMap.set(phone, created);
  return created;
}

async function updateSession(session, updates) {
  await supabase
    .from("session_state")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", session.id);
}

// =========================
// CRM ENGINE
// =========================

async function updateCRM(phone, message) {
  let score = 0;
  const t   = message.toLowerCase();

  if (t.includes("comprar")) score += 40;
  if (t.includes("precio"))  score += 20;
  if (t.includes("quiero"))  score += 25;
  if (t.includes("info"))    score += 10;

  let stage = "NEW_LEAD";
  if (score > 20) stage = "INTERESTED";
  if (score > 50) stage = "QUALIFIED";
  if (score > 75) stage = "NEGOTIATION";
  if (score > 90) stage = "CLOSED_WON";

  await supabase.from("crm_pipeline").upsert({
    phone,
    score,
    stage,
    last_interaction: message,
    updated_at: new Date().toISOString()
  });

  return stage;
}

// =========================
// CORE ENGINE
// =========================

async function processMessage(msg) {
  const phone     = cleanPhone(msg.from);
  const text      = msg.text?.body || "";
  const messageId = msg.id;

  if (!phone || !text) return;

  // IDEMPOTENCY
  if (processedMessages.has(messageId)) return;
  processedMessages.add(messageId);
  if (processedMessages.size > 10000) processedMessages.clear();

  // RATE LIMIT
  if (!rateLimit(phone)) return;

  const country = detectCountry(phone);
  const session = await getSession(phone);
  const intent  = await getIntent(text);
  const stage   = await updateCRM(phone, text);

  await updateSession(session, {
    last_message: text,
    step:  intent,
    state: { country, intent }
  });

  let response = "";

  switch (intent) {
    case "FINANCE":
      response = "📊 Movimiento financiero registrado.";
      break;
    case "INVENTORY":
      response = "📦 Inventario actualizado.";
      break;
    case "MARKETING":
      response = "🔥 Estrategia generada para tu negocio.";
      break;
    default:
      response = `🤖 Asistente activo\n🌍 ${country}`;
  }

  if (stage === "NEGOTIATION") {
    response += "\n🔥 Cliente listo para cierre.";
  }

  await sendWhatsApp(phone, response);
}

// =========================
// WEBHOOK VERIFY (META)
// =========================

app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// =========================
// WEBHOOK RECEIVE
// =========================

app.post("/webhook", async (req, res) => {
  try {
    if (!verifySignature(req)) {
      return res.sendStatus(401);
    }

    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!msg) return res.sendStatus(200);

    res.sendStatus(200);

    processMessage(msg).catch(err =>
      console.error("PROCESS_ERROR:", err.message)
    );

  } catch (err) {
    console.error("WEBHOOK_ERROR:", err.message);
    res.sendStatus(200);
  }
});

// =========================
// HEALTH
// =========================

app.get("/health", (req, res) => {
  res.json({
    status:  "OK",
    system:  "NoboAPP FINAL PRODUCTION",
    version: "1.0.0",
    stage:   "MVP-READY"
  });
});

// =========================
// START
// =========================

app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 NoboAPP FINAL PRODUCTION RUNNING");
});
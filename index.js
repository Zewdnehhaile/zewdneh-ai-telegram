require("dotenv").config();
const http = require("http");
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");

// ======================================================
// CONFIG
// ======================================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const RENDER_URL = process.env.RENDER_URL || "https://zewdneh-ai-telegram.onrender.com";
const WEBHOOK_PATH = "/webhook";

const openai = new OpenAI({
  apiKey: process.env.GEMINI_API_KEY,
  baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
});

const DOCUMENTS_DIR = path.join(__dirname, "documents");
const KNOWLEDGE_DIR = path.join(__dirname, "knowledge");
const MEMORY_FILE = path.join(__dirname, "memory.json");
const STATE_FILE = path.join(__dirname, "state.json");
const MAX_HISTORY = 20;

const PHONE_REGEX = /^(09\d{8}|\+2519\d{8})$/;

// ======================================================
// LOAD KNOWLEDGE
// ======================================================
function loadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.log(`⚠️ Could not load ${file}:`, e.message);
    return null;
  }
}

const documentsRegistry = loadJson(path.join(KNOWLEDGE_DIR, "documents.json")) || {};
const bankAccounts = loadJson(path.join(KNOWLEDGE_DIR, "bank-accounts.json")) || { accounts: [] };
const paymentRules = loadJson(path.join(KNOWLEDGE_DIR, "payment-rules.json")) || {};
const responses = loadJson(path.join(KNOWLEDGE_DIR, "responses.json")) || {};
const examples = loadJson(path.join(KNOWLEDGE_DIR, "examples.json")) || { examples: [] };

console.log("📚 Loaded knowledge:");
console.log("   - documents:", Object.keys(documentsRegistry).length);
console.log("   - bank accounts:", bankAccounts.accounts.length);
console.log("   - responses:", Object.keys(responses).length);
console.log("   - examples:", examples.examples.length);

// ======================================================
// BUSINESS CONNECTION CACHE
// ======================================================
let businessConnectionCache = null;

async function fetchBusinessConnection(businessConnectionId) {
  if (businessConnectionCache) return businessConnectionCache;
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getBusinessConnection?business_connection_id=${encodeURIComponent(businessConnectionId)}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.ok) {
      businessConnectionCache = data.result;
      console.log(`🔗 Business owner user id: ${data.result.user?.id}, name: ${data.result.user?.first_name}`);
    }
  } catch (e) {
    console.log("⚠️ Could not fetch business connection:", e.message);
  }
  return businessConnectionCache;
}

// ======================================================
// CUSTOMER STATE
// ======================================================
let customerState = {};
if (fs.existsSync(STATE_FILE)) {
  try {
    customerState = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    console.log("🧠 Loaded customer state for", Object.keys(customerState).length, "chats");
  } catch (e) { customerState = {}; }
}

function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(customerState, null, 2)); } catch (e) {}
}

function getState(chatId) {
  const key = String(chatId);
  if (!customerState[key]) {
    customerState[key] = {
      lang: null,
      awaiting: "language",
      tempName: null,
      tempPhone: null,
      blocked: false,
    };
    saveState();
  }
  return customerState[key];
}

function resetState(chatId) {
  const key = String(chatId);
  customerState[key] = {
    lang: null,
    awaiting: "language",
    tempName: null,
    tempPhone: null,
    blocked: false,
  };
  saveState();
}

// ======================================================
// MEMORY
// ======================================================
let memory = {};
if (fs.existsSync(MEMORY_FILE)) {
  try { memory = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8")); } catch (e) { memory = {}; }
}

function saveMemory() {
  try { fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2)); } catch (e) {}
}

function addToHistory(chatId, role, content) {
  const key = String(chatId);
  if (!memory[key]) memory[key] = [];
  memory[key].push({ role, content });
  if (memory[key].length > MAX_HISTORY) {
    memory[key] = memory[key].slice(-MAX_HISTORY);
  }
  saveMemory();
}

function getLastMessages(chatId, count = 5) {
  const key = String(chatId);
  const arr = memory[key] || [];
  return arr.slice(-count);
}

// ======================================================
// LANGUAGE HELPERS
// ======================================================
function tr(lang, key) {
  // key like "ask_name_phone", "invalid_phone", "resend_file", "will_respond_soon"
  const obj = responses[key];
  if (!obj) return "";
  const map = { am: "reply_am", en: "reply_en", om: "reply_om" };
  return obj[map[lang] || "reply_am"] || obj.reply_am || "";
}

// ======================================================
// TELEGRAM HELPERS
// ======================================================
async function sendTelegramMessage(businessConnectionId, chatId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = { chat_id: chatId, text };
  if (businessConnectionId) body.business_connection_id = businessConnectionId;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!result.ok) throw new Error(`Telegram send error: ${JSON.stringify(result)}`);
  return result;
}

async function sendTelegramPhoto(businessConnectionId, chatId, photoUrl, caption = "") {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`;
  const body = { chat_id: chatId, photo: photoUrl };
  if (caption) body.caption = caption;
  if (businessConnectionId) body.business_connection_id = businessConnectionId;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!result.ok) throw new Error(`Telegram sendPhoto error: ${JSON.stringify(result)}`);
  return result;
}

async function sendTelegramDocument(businessConnectionId, chatId, filePath, caption = "") {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`;

  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (businessConnectionId) form.append("business_connection_id", businessConnectionId);
  if (caption) form.append("caption", caption);

  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  const blob = new Blob([fileBuffer], { type: "application/pdf" });
  form.append("document", blob, fileName);

  const response = await fetch(url, { method: "POST", body: form });
  const result = await response.json();
  if (!result.ok) throw new Error(`Telegram sendDocument error: ${JSON.stringify(result)}`);
  return result;
}

async function sendTelegramDocumentByFileId(businessConnectionId, chatId, fileId, caption = "") {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`;
  const body = { chat_id: chatId, document: fileId };
  if (caption) body.caption = caption;
  if (businessConnectionId) body.business_connection_id = businessConnectionId;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!result.ok) throw new Error(`Telegram sendDocument error: ${JSON.stringify(result)}`);
  return result;
}

async function sendToOwner(text) {
  return sendTelegramMessage(null, OWNER_CHAT_ID, text);
}

// ======================================================
// BUILD SYSTEM PROMPT
// ======================================================
function buildSystemPrompt(lang) {
  const docKeys = Object.keys(documentsRegistry);
  const bankList = bankAccounts.accounts
    .map((a) => `${a.bank} → ${a.account}`)
    .join("\n");

  const exampleText = examples.examples
    .map((ex) => `Customer: ${ex.customer}\nIntent: ${ex.intent}\nApproved: ${ex.approved_response}`)
    .join("\n---\n");

  const langName = { am: "Amharic", en: "English", om: "Afaan Oromoo" }[lang] || "Amharic";

  return `You are the official customer-service AI assistant for DIGAF MICRO CREDIT PROVIDER S.C.

CUSTOMER'S CHOSEN LANGUAGE: ${langName}
→ ALWAYS reply in ${langName}, even if the customer writes in another language.

RULES:
- Be polite, professional, helpful — like a trained Digaf employee.
- Keep replies short and clear.
- NEVER invent loan amounts, interest rates, approvals, balances, policies, or bank accounts.
- NEVER promise loan approval.
- NEVER say "forwarding to staff" or "ለሰው ሰራተኛ እናስተላልፋለን".
- If unsure → say "Please wait a moment, we will respond to you soon." (in ${langName})

OUTPUT — valid JSON only:
{
  "intent": "GREETING",
  "document_type": null,
  "reply": "text in ${langName}",
  "escalation_reason": null
}

Allowed intents: GREETING, LOAN_TYPE_SELECTION, PAYDAY_LOAN, SALARY_LOAN, SALARY_ADVANCE, BUSINESS_LOAN, LOAN_REQUIREMENTS, LOAN_60_90_DAYS, PAYMENT_INFORMATION, BANK_ACCOUNT_REQUEST, TELEBIRR_PAYMENT, TELEBIRR_THIRD_PARTY_ACCOUNT, SERVICE_AREA, NON_BANK_INSTITUTION, DOCUMENT_REQUEST, GENERAL_INFORMATION, COMPLAINT, PAYMENT_DISPUTE, ACCOUNT_SPECIFIC_REQUEST, LOAN_APPROVAL_REQUEST, UNKNOWN, HUMAN_ESCALATION

For documents: "intent": "DOCUMENT_REQUEST", "document_type": "<${docKeys.join(", ")}>"

--- RESPONSES ---
${JSON.stringify(responses, null, 2)}

--- PAYMENT RULES ---
${JSON.stringify(paymentRules, null, 2)}

--- BANK ACCOUNTS ---
${bankList}

--- EXAMPLES ---
${exampleText}

Never guess. Never invent. Reply with JSON only.`;
}

// ======================================================
// AI CALL
// ======================================================
async function askAI(chatId, customerMessage, lang) {
  addToHistory(chatId, "user", customerMessage);
  const history = memory[String(chatId)] || [];

  const response = await openai.chat.completions.create({
    model: GEMINI_MODEL,
    messages: [
      { role: "system", content: buildSystemPrompt(lang) },
      ...history,
    ],
    response_format: { type: "json_object" },
  });

  const raw = response.choices[0].message.content;
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) {
    parsed = {
      intent: "UNKNOWN",
      document_type: null,
      reply: "Please wait a moment, we will respond to you soon.",
      escalation_reason: "Invalid AI response",
    };
  }

  if (parsed.document_type && !documentsRegistry[parsed.document_type]) parsed.document_type = null;

  const allowedIntents = [
    "GREETING","LOAN_TYPE_SELECTION","PAYDAY_LOAN","SALARY_LOAN","SALARY_ADVANCE","BUSINESS_LOAN",
    "LOAN_REQUIREMENTS","LOAN_60_90_DAYS","PAYMENT_INFORMATION","BANK_ACCOUNT_REQUEST",
    "TELEBIRR_PAYMENT","TELEBIRR_THIRD_PARTY_ACCOUNT","SERVICE_AREA","NON_BANK_INSTITUTION",
    "DOCUMENT_REQUEST","GENERAL_INFORMATION","COMPLAINT","PAYMENT_DISPUTE",
    "ACCOUNT_SPECIFIC_REQUEST","LOAN_APPROVAL_REQUEST","UNKNOWN","HUMAN_ESCALATION",
  ];
  if (!allowedIntents.includes(parsed.intent)) parsed.intent = "UNKNOWN";

  addToHistory(chatId, "assistant", parsed.reply || "");
  return parsed;
}

// ======================================================
// PENDING ESCALATIONS
// ======================================================
const pendingQuestions = new Map();

// ======================================================
// HANDLE ONE UPDATE
// ======================================================
async function handleUpdate(update) {
  try {
    if (update.business_message) {
      const message = update.business_message;
      const businessConnectionId = message.business_connection_id;

      await fetchBusinessConnection(businessConnectionId);
      const ownerUserId = businessConnectionCache?.user?.id
        ? String(businessConnectionCache.user.id)
        : String(OWNER_CHAT_ID);

      const senderId = String(message.from?.id);
      const isFromOwner = senderId === ownerUserId;
      const customerChatId = message.chat.id;
      const customerName = message.from?.first_name || message.from?.username || "Customer";

      // ===== OWNER MESSAGE =====
      if (isFromOwner) {
        if (message.text) addToHistory(customerChatId, "assistant", message.text);
        console.log(`👤 Owner message stored`);
        return;
      }

      // ===== CUSTOMER MESSAGE =====
      const state = getState(customerChatId);

      if (message.text && message.text.trim() === "/start") {
        resetState(customerChatId);
        delete memory[String(customerChatId)];
        saveMemory();
        await sendTelegramMessage(businessConnectionId, customerChatId, responses.language_menu.reply);
        console.log(`🔄 Reset for ${customerName}`);
        return;
      }

      if (state.blocked) {
        console.log(`🚫 Blocked: ${customerName}`);
        return;
      }

      // ---------- LANGUAGE MENU ----------
      if (state.awaiting === "language") {
        const text = (message.text || "").trim();
        if (text === "1" || /^amharic$|^አማርኛ$/i.test(text)) {
          state.lang = "am"; state.awaiting = null; saveState();
          await sendTelegramMessage(businessConnectionId, customerChatId, "እንኳን በደህና መጡ። እንዴት ልርዳዎት?");
          return;
        }
        if (text === "2" || /^english$|^eng$/i.test(text)) {
          state.lang = "en"; state.awaiting = null; saveState();
          await sendTelegramMessage(businessConnectionId, customerChatId, "Welcome. How can I help you?");
          return;
        }
        if (text === "3" || /^orom|oromifa$/i.test(text)) {
          state.lang = "om"; state.awaiting = null; saveState();
          await sendTelegramMessage(businessConnectionId, customerChatId, "Baga nagaan dhuftan. Akkamittin isin gargaaruu danda'a?");
          return;
        }
        await sendTelegramMessage(businessConnectionId, customerChatId, responses.language_menu.reply);
        return;
      }

      // ---------- NAME + PHONE (any order) ----------
      if (state.awaiting === "name_phone") {
        const text = (message.text || "").trim();
        const phoneMatch = text.match(/(09\d{8}|\+2519\d{8})/);
        const phone = phoneMatch ? phoneMatch[0] : null;
        const namePart = text.replace(phone || "", "").trim();

        // Save whatever we got
        if (phone && PHONE_REGEX.test(phone)) {
          state.tempPhone = phone;
        } else if (phone) {
          // Looks like a phone but wrong format
          await sendTelegramMessage(businessConnectionId, customerChatId, tr(state.lang, "invalid_phone"));
          return;
        }

        if (namePart && namePart.length >= 2) {
          state.tempName = namePart;
        }

        saveState();

        // Check if we have BOTH
        if (state.tempName && state.tempPhone) {
          state.awaiting = "resend_file";
          saveState();
          await sendTelegramMessage(businessConnectionId, customerChatId, tr(state.lang, "resend_file"));
          return;
        }

        // Missing one — ask for what's missing
        if (!state.tempPhone && !state.tempName) {
          await sendTelegramMessage(businessConnectionId, customerChatId, tr(state.lang, "ask_name_phone"));
        } else if (!state.tempPhone) {
          // Have name, need phone
          const msgPhone = { am: "እባክዎ የስልክ ቁጥርዎን (09... ብቻ) ይላኩልን።", en: "Please send your phone number (starting with 09...).", om: "Maaloo lakkoofsa bilbilaa (09... qofa) nuuf ergaa." };
          await sendTelegramMessage(businessConnectionId, customerChatId, msgPhone[state.lang || "am"]);
        } else {
          // Have phone, need name
          const msgName = { am: "እባክዎ ሙሉ ስምዎን ይላኩልን።", en: "Please send your full name.", om: "Maaloo maqaa guutuu nuuf ergaa." };
          await sendTelegramMessage(businessConnectionId, customerChatId, msgName[state.lang || "am"]);
        }
        return;
      }

      // ---------- RESEND FILE ----------
      if (state.awaiting === "resend_file") {
        if (message.document || (message.photo && message.photo.length > 0)) {
          const fileInfo = message.document
            ? `📎 Document: ${message.document.file_name || "file"}`
            : `🖼 Photo`;

          const last5 = getLastMessages(customerChatId, 5)
            .map(m => `${m.role}: ${m.content}`)
            .join("\n");

          const ownerMsg = await sendToOwner(
            `📥 VERIFIED CUSTOMER FILE\n\nName: ${state.tempName}\nPhone: ${state.tempPhone}\nChat ID: ${customerChatId}\n${fileInfo}\n\n📜 Last messages:\n${last5}\n\n✍️ Reply to THIS message.`
          );

          if (message.document) {
            await sendTelegramDocumentByFileId(null, OWNER_CHAT_ID, message.document.file_id, `From ${state.tempName}`);
          } else {
            const fileId = message.photo[message.photo.length - 1].file_id;
            await sendTelegramPhoto(null, OWNER_CHAT_ID, fileId, `From ${state.tempName}`);
          }

          pendingQuestions.set(ownerMsg.result.message_id, {
            businessConnectionId,
            customerChatId,
            customerName: state.tempName,
          });

          state.blocked = true;
          state.awaiting = null;
          saveState();

          await sendTelegramMessage(businessConnectionId, customerChatId, tr(state.lang, "will_respond_soon"));
          return;
        }
        await sendTelegramMessage(businessConnectionId, customerChatId, tr(state.lang, "resend_file"));
        return;
      }

      // ---------- FIRST FILE → ASK IDENTITY ----------
      if (message.document || (message.photo && message.photo.length > 0)) {
        await sendTelegramMessage(businessConnectionId, customerChatId, tr(state.lang, "ask_name_phone"));
        state.awaiting = "name_phone";
        state.tempName = null;
        state.tempPhone = null;
        saveState();
        return;
      }

      // ---------- TEXT ----------
      if (message.text) {
        const incomingText = message.text;

        if (/english|eng/i.test(incomingText)) { state.lang = "en"; saveState(); }
        if (/amharic|አማርኛ/i.test(incomingText)) { state.lang = "am"; saveState(); }
        if (/orom/i.test(incomingText)) { state.lang = "om"; saveState(); }

        console.log(`📩 Customer (${customerName}) [${state.lang}]: ${incomingText}`);

        const ai = await askAI(customerChatId, incomingText, state.lang);
        console.log(`🧠 Intent: ${ai.intent}`);

        if (ai.intent === "DOCUMENT_REQUEST" && ai.document_type) {
          const entry = documentsRegistry[ai.document_type];
          const filePath = path.join(DOCUMENTS_DIR, entry.file);

          if (entry.type === "contract") {
            await sendTelegramMessage(businessConnectionId, customerChatId, ai.reply);
            const ownerMsg = await sendToOwner(
              `📄 CONTRACT REQUEST\n\nCustomer: ${customerName}\nChat ID: ${customerChatId}\nDocument: ${entry.name}\n\n✍️ Reply to THIS message.`
            );
            pendingQuestions.set(ownerMsg.result.message_id, {
              businessConnectionId, customerChatId, customerName,
              requestedDocument: ai.document_type,
            });
            state.blocked = true;
            saveState();
            return;
          }

          const historyLen = (memory[String(customerChatId)] || []).length;
          const isEstablished = historyLen >= 20;

          if (!fs.existsSync(filePath)) {
            await sendTelegramMessage(businessConnectionId, customerChatId, tr(state.lang, "will_respond_soon"));
            return;
          }

          if (!isEstablished) {
            if (ai.reply) await sendTelegramMessage(businessConnectionId, customerChatId, ai.reply);
            await sendTelegramMessage(businessConnectionId, customerChatId, tr(state.lang, "will_respond_soon"));
            const ownerMsg = await sendToOwner(
              `📄 FILE REQUEST (new customer)\n\nCustomer: ${customerName}\nChat ID: ${customerChatId}\nRequested: ${entry.name}\nHistory: ${historyLen} msgs\n\n✍️ Reply to THIS message.`
            );
            pendingQuestions.set(ownerMsg.result.message_id, {
              businessConnectionId, customerChatId, customerName,
              requestedDocument: ai.document_type,
            });
            state.blocked = true;
            saveState();
            return;
          }

          if (ai.reply) await sendTelegramMessage(businessConnectionId, customerChatId, ai.reply);
          await sendTelegramDocument(businessConnectionId, customerChatId, filePath, entry.caption || entry.name);
          return;
        }

        if (ai.intent === "HUMAN_ESCALATION") {
          const last5 = getLastMessages(customerChatId, 5)
            .map(m => `${m.role}: ${m.content}`)
            .join("\n");

          const ownerMsg = await sendToOwner(
            `❓ ESCALATION\n\nCustomer: ${customerName}\nChat ID: ${customerChatId}\n\nLast message:\n"${incomingText}"\n\n📜 Last messages:\n${last5}\n\nReason: ${ai.escalation_reason || "Requires human verification"}\n\n✍️ Reply to THIS message.`
          );
          pendingQuestions.set(ownerMsg.result.message_id, { businessConnectionId, customerChatId, customerName });
          state.blocked = true;
          saveState();

          if (ai.reply) await sendTelegramMessage(businessConnectionId, customerChatId, ai.reply);
          return;
        }

        await sendTelegramMessage(businessConnectionId, customerChatId, ai.reply);
        return;
      }
    }

    // ============ OWNER REPLY ============
    if (update.message) {
      const msg = update.message;
      const fromId = msg.chat.id;
      const replyTo = msg.reply_to_message?.message_id;

      if (String(fromId) !== String(OWNER_CHAT_ID)) return;
      if (!replyTo || !pendingQuestions.has(replyTo)) return;

      const pending = pendingQuestions.get(replyTo);
      const state = getState(pending.customerChatId);

      if (msg.document) {
        await sendTelegramDocumentByFileId(pending.businessConnectionId, pending.customerChatId, msg.document.file_id, msg.caption || "");
      } else if (msg.photo && msg.photo.length > 0) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        await sendTelegramPhoto(pending.businessConnectionId, pending.customerChatId, fileId, msg.caption || "");
      } else if (msg.text) {
        if (pending.requestedDocument) {
          const entry = documentsRegistry[pending.requestedDocument];
          if (entry) {
            const filePath = path.join(DOCUMENTS_DIR, entry.file);
            if (fs.existsSync(filePath)) {
              await sendTelegramDocument(
                pending.businessConnectionId,
                pending.customerChatId,
                filePath,
                entry.caption || entry.name
              );
              console.log(`📄 Auto-sent: ${entry.file}`);
            }
          }
        }
        await sendTelegramMessage(pending.businessConnectionId, pending.customerChatId, msg.text);
      }

      state.blocked = false;
      saveState();
      pendingQuestions.delete(replyTo);
      await sendToOwner(`✅ Sent to ${pending.customerName}`);
      return;
    }
  } catch (error) {
    console.error("❌ Error handling update:", error.message);
  }
}

// ======================================================
// HTTP SERVER
// ======================================================
http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === WEBHOOK_PATH) {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const update = JSON.parse(body);
        await handleUpdate(update);
      } catch (e) {
        console.error("❌ Webhook parse error:", e.message);
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Digaf support bot is alive\n");
}).listen(process.env.PORT || 3000, () => {
  console.log("🌐 Server listening on port", process.env.PORT || 3000);
});

// ======================================================
// SET WEBHOOK
// ======================================================
async function setWebhook() {
  const url = `${RENDER_URL}${WEBHOOK_PATH}`;
  const apiUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${encodeURIComponent(url)}&allowed_updates=${encodeURIComponent(JSON.stringify(["business_message", "message"]))}`;
  try {
    const res = await fetch(apiUrl);
    const data = await res.json();
    console.log("🔗 Webhook set:", JSON.stringify(data));
  } catch (e) {
    console.error("❌ Failed to set webhook:", e.message);
  }
}

setWebhook().then(() => {
  console.log("🏦 Digaf customer-service AI is running (webhook mode)...");
});
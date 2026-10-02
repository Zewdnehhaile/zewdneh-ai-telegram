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
const MAX_HISTORY = 20;

// Phone validation: 09XXXXXXXX  OR  +2519XXXXXXXX
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
// CUSTOMER STATE (per chat)
// ======================================================
// state[chatId] = {
//   lang: "am" | "en" | "om" | null,
//   awaiting: null | "language" | "name_phone" | "resend_file",
//   tempName: string | null,
//   tempPhone: string | null,
//   blocked: boolean  // true if a request is pending owner reply
// }

let customerState = {};

function saveState() {
  try {
    fs.writeFileSync(path.join(__dirname, "state.json"), JSON.stringify(customerState, null, 2));
  } catch (e) {}
}

function loadState() {
  try {
    const f = path.join(__dirname, "state.json");
    if (fs.existsSync(f)) {
      customerState = JSON.parse(fs.readFileSync(f, "utf8"));
      console.log("🧠 Loaded customer state for", Object.keys(customerState).length, "chats");
    }
  } catch (e) {
    customerState = {};
  }
}
loadState();

function getState(chatId) {
  const key = String(chatId);
  if (!customerState[key]) {
    customerState[key] = {
      lang: null,
      awaiting: "language", // first time → must choose language
      tempName: null,
      tempPhone: null,
      blocked: false,
    };
    saveState();
  }
  return customerState[key];
}

// ======================================================
// MEMORY (conversation history)
// ======================================================
let memory = {};
if (fs.existsSync(MEMORY_FILE)) {
  try {
    memory = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
  } catch (e) {
    memory = {};
  }
}

function saveMemory() {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
  } catch (e) {}
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

  return `You are the official customer-service AI assistant for DIGAF MICRO CREDIT PROVIDER S.C. (ድጋፍ ማይክሮ ክሬዲት አቅራቢ አ.ማ).

CUSTOMER'S CHOSEN LANGUAGE: ${langName}
→ ALWAYS reply in ${langName}. If the customer writes in another language, still use ${langName} unless they ask to switch.

IDENTITY RULES:
- You are polite, professional, and helpful — like a trained Digaf employee.
- If a customer asks if you are human, say honestly that you are the Digaf customer-service AI assistant. Do NOT pretend to be a specific human.
- Keep replies short and clear unless detailed info is required.
- NEVER invent: loan amounts, interest rates, approval decisions, account balances, service areas, processing times, bank account numbers, or policies.
- NEVER promise a loan approval.
- NEVER claim you have checked an internal system.
- If unsure → say we will respond soon. NEVER say "forwarding to staff" or "forwarding to a human" or "ለሰው ሰራተኛ እናስተላልፋለን".
- If escalation needed, use: "Please wait a moment, we will respond to you soon." (translated to ${langName})

OUTPUT FORMAT — reply ONLY with valid JSON, no markdown, no extra text:

{
  "intent": "GREETING",
  "document_type": null,
  "reply": "text to send to customer (in ${langName})",
  "escalation_reason": null
}

Allowed intent values:
GREETING, LOAN_TYPE_SELECTION, PAYDAY_LOAN, SALARY_LOAN, SALARY_ADVANCE, BUSINESS_LOAN,
LOAN_REQUIREMENTS, LOAN_60_90_DAYS, PAYMENT_INFORMATION, BANK_ACCOUNT_REQUEST,
TELEBIRR_PAYMENT, TELEBIRR_THIRD_PARTY_ACCOUNT, SERVICE_AREA, NON_BANK_INSTITUTION,
DOCUMENT_REQUEST, GENERAL_INFORMATION, COMPLAINT, PAYMENT_DISPUTE,
ACCOUNT_SPECIFIC_REQUEST, LOAN_APPROVAL_REQUEST, UNKNOWN, HUMAN_ESCALATION

When the customer wants a PDF/document, set:
"intent": "DOCUMENT_REQUEST",
"document_type": "<one of: ${docKeys.join(", ")}>",
"reply": "short friendly message in ${langName}"

When the case needs a human, set:
"intent": "HUMAN_ESCALATION",
"reply": "Please wait a moment, we will respond to you soon. (in ${langName})",
"escalation_reason": "why it needs a human"

==================================================
APPROVED COMPANY KNOWLEDGE
==================================================

--- APPROVED RESPONSES ---
${JSON.stringify(responses, null, 2)}

--- APPROVED PAYMENT RULES ---
${JSON.stringify(paymentRules, null, 2)}

--- APPROVED BANK ACCOUNTS (only these are valid) ---
${bankList}

--- APPROVED CONVERSATION EXAMPLES ---
${exampleText}

Remember: accuracy > creativity. NEVER guess. NEVER invent. Reply with JSON only.`;
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
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    parsed = {
      intent: "UNKNOWN",
      document_type: null,
      reply: "Please wait a moment, we will respond to you soon.",
      escalation_reason: "Invalid AI response",
    };
  }

  if (parsed.document_type && !documentsRegistry[parsed.document_type]) {
    parsed.document_type = null;
  }

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
// PENDING ESCALATIONS (owner replies mapped to customer)
// ======================================================
const pendingQuestions = new Map();

// ======================================================
// HANDLE ONE UPDATE
// ======================================================
async function handleUpdate(update) {
  try {
    // ============ CUSTOMER MESSAGE (business) ============
    if (update.business_message) {
      const message = update.business_message;

      if (String(message.from?.id) === String(OWNER_CHAT_ID)) return;

      const businessConnectionId = message.business_connection_id;
      const customerChatId = message.chat.id;
      const customerName = message.from?.first_name || message.from?.username || "Customer";
      const state = getState(customerChatId);

      // ---------- BLOCK: if a request is pending owner reply ----------
      if (state.blocked) {
        console.log(`🚫 Blocked: ${customerName} has a pending request`);
        return;
      }

      // ---------- LANGUAGE MENU (first time) ----------
      if (state.awaiting === "language") {
        const text = (message.text || "").trim();
        if (text === "1" || /amharic|አማርኛ/i.test(text)) {
          state.lang = "am";
          state.awaiting = null;
          saveState();
          await sendTelegramMessage(businessConnectionId, customerChatId, "እንኳን በደህና መጡ። እንዴት ልርዳዎት?");
          return;
        }
        if (text === "2" || /english|eng/i.test(text)) {
          state.lang = "en";
          state.awaiting = null;
          saveState();
          await sendTelegramMessage(businessConnectionId, customerChatId, "Welcome. How can I help you?");
          return;
        }
        if (text === "3" || /orom/i.test(text)) {
          state.lang = "om";
          state.awaiting = null;
          saveState();
          await sendTelegramMessage(businessConnectionId, customerChatId, "Baga nagaan dhuftan. Akkamittin isin gargaaruu danda'a?");
          return;
        }
        // didn't pick → show menu again
        await sendTelegramMessage(businessConnectionId, customerChatId, responses.language_menu.reply);
        return;
      }

      // ---------- AWAITING NAME + PHONE ----------
      if (state.awaiting === "name_phone") {
        const text = (message.text || "").trim();
        const parts = text.split(/\s+/);

        // Look for phone
        const phoneMatch = text.match(/(09\d{8}|\+2519\d{8})/);
        const phone = phoneMatch ? phoneMatch[0] : null;

        // Name = everything except the phone, must have at least 2 chars
        const namePart = text.replace(phone || "", "").trim();

        if (!phone || !PHONE_REGEX.test(phone)) {
          await sendTelegramMessage(
            businessConnectionId, customerChatId,
            responses.invalid_phone[`reply_${state.lang || "am"}`] || responses.invalid_phone.reply_am
          );
          return;
        }

        if (!namePart || namePart.length < 2) {
          await sendTelegramMessage(
            businessConnectionId, customerChatId,
            responses.ask_name_phone[`reply_${state.lang || "am"}`] || responses.ask_name_phone.reply_am
          );
          return;
        }

        // Save
        state.tempName = namePart;
        state.tempPhone = phone;
        state.awaiting = "resend_file";
        saveState();

        await sendTelegramMessage(
          businessConnectionId, customerChatId,
          responses.resend_file[`reply_${state.lang || "am"}`] || responses.resend_file.reply_am
        );
        return;
      }

      // ---------- AWAITING RESEND OF FILE ----------
      if (state.awaiting === "resend_file") {
        if (message.document || (message.photo && message.photo.length > 0)) {
          // Good — forward to owner
          const fileInfo = message.document
            ? `📎 Document: ${message.document.file_name || "file"}`
            : `🖼 Photo`;

          const ownerMsg = await sendToOwner(
            `📥 VERIFIED CUSTOMER FILE\n\nName: ${state.tempName}\nPhone: ${state.tempPhone}\nChat ID: ${customerChatId}\n${fileInfo}\n\n✍️ Reply to THIS message with what to send to the customer.`
          );

          // Forward the file to owner
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

          await sendTelegramMessage(
            businessConnectionId, customerChatId,
            responses.will_respond_soon[`reply_${state.lang || "am"}`] || responses.will_respond_soon.reply_am
          );
          return;
        }

        await sendTelegramMessage(
          businessConnectionId, customerChatId,
          responses.resend_file[`reply_${state.lang || "am"}`] || responses.resend_file.reply_am
        );
        return;
      }

      // ---------- FIRST FILE, needs identity ----------
      if (message.document || (message.photo && message.photo.length > 0)) {
        // Reject and ask for info
        const ask = responses.ask_name_phone[`reply_${state.lang || "am"}`] || responses.ask_name_phone.reply_am;
        await sendTelegramMessage(businessConnectionId, customerChatId, ask);
        state.awaiting = "name_phone";
        saveState();
        //   console.log(`🛡 Rejected file from ${customerName} — waiting for identity`);
        return;
      }

      // ---------- TEXT MESSAGE ----------
      if (message.text) {
        const incomingText = message.text;

        // Allow customer to switch language anytime
        if (/english|eng/i.test(incomingText)) { state.lang = "en"; saveState(); }
        if (/amharic|አማርኛ/i.test(incomingText)) { state.lang = "am"; saveState(); }
        if (/orom/i.test(incomingText)) { state.lang = "om"; saveState(); }

        //   console.log(`📩 Customer (${customerName}) [${state.lang}]: ${incomingText}`);

        const ai = await askAI(customerChatId, incomingText, state.lang);
        //   console.log(`🧠 Intent: ${ai.intent}`);

        // DOCUMENT REQUEST
        if (ai.intent === "DOCUMENT_REQUEST" && ai.document_type) {
          const entry = documentsRegistry[ai.document_type];
          const filePath = path.join(DOCUMENTS_DIR, entry.file);

          // Contract type → escalate to owner
          if (entry.type === "contract") {
            await sendTelegramMessage(businessConnectionId, customerChatId, ai.reply);
            const ownerMsg = await sendToOwner(
              `📄 CONTRACT REQUEST\n\nCustomer: ${customerName}\nChat ID: ${customerChatId}\nDocument: ${entry.name}\n\n✍️ Reply to THIS message to send the file (or a message) to the customer.`
            );
            pendingQuestions.set(ownerMsg.result.message_id, {
              businessConnectionId,
              customerChatId,
              customerName,
            });
            state.blocked = true;
            saveState();
            //   console.log(`📨 Contract escalated to owner`);
            return;
          }

          // Public → send automatically
                  // Public file — send only if the customer is established (≥ 20 messages)
          const historyLen = (memory[String(customerChatId)] || []).length;
          const isEstablished = historyLen >= 20;

          if (!fs.existsSync(filePath)) {
            await sendTelegramMessage(
              businessConnectionId, customerChatId,
              responses.will_respond_soon[`reply_${state.lang || "am"}`] || responses.will_respond_soon.reply_am
            );
            return;
          }

          if (!isEstablished) {
            // First-time / short chat → do NOT auto-send. Reply politely + escalate to owner.
            if (ai.reply) {
              await sendTelegramMessage(businessConnectionId, customerChatId, ai.reply);
            }
            await sendTelegramMessage(
              businessConnectionId, customerChatId,
              responses.will_respond_soon[`reply_${state.lang || "am"}`] || responses.will_respond_soon.reply_am
            );

            const ownerMsg = await sendToOwner(
              `📄 FILE REQUEST (new customer)\n\nCustomer: ${customerName}\nChat ID: ${customerChatId}\nRequested: ${entry.name}\nHistory: ${historyLen} msgs\n\n✍️ Reply to THIS message to send the file (or a message) to the customer.`
            );
            pendingQuestions.set(ownerMsg.result.message_id, {
              businessConnectionId,
              customerChatId,
              customerName,
            });
            state.blocked = true;
            saveState();
         //   console.log(`📨 New-customer file request escalated to owner`);
            return;
          }

          // Established customer → send file directly
          if (ai.reply) {
            await sendTelegramMessage(businessConnectionId, customerChatId, ai.reply);
          }
          await sendTelegramDocument(businessConnectionId, customerChatId, filePath, entry.caption || entry.name);
         //   console.log(`📄 Sent public document: ${entry.file}`);
          return;

        // HUMAN ESCALATION
        if (ai.intent === "HUMAN_ESCALATION") {
          const ownerMsg = await sendToOwner(
            `❓ ESCALATION\n\nCustomer: ${customerName}\nChat ID: ${customerChatId}\n\nMessage:\n"${incomingText}"\n\nReason: ${ai.escalation_reason || "Requires human verification"}\n\n✍️ Reply to THIS message.`
          );
          pendingQuestions.set(ownerMsg.result.message_id, {
            businessConnectionId,
            customerChatId,
            customerName,
          });
          state.blocked = true;
          saveState();

          if (ai.reply) {
            await sendTelegramMessage(businessConnectionId, customerChatId, ai.reply);
          }
          return;
        }

        // NORMAL REPLY
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
        await sendTelegramDocumentByFileId(
          pending.businessConnectionId, pending.customerChatId,
          msg.document.file_id, msg.caption || ""
        );
      } else if (msg.photo && msg.photo.length > 0) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        await sendTelegramPhoto(
          pending.businessConnectionId, pending.customerChatId,
          fileId, msg.caption || ""
        );
      } else if (msg.text) {
        await sendTelegramMessage(
          pending.businessConnectionId, pending.customerChatId, msg.text
        );
      }

      // Unblock customer
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
// HTTP SERVER (webhook + health check)
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
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

const openai = new OpenAI({
  apiKey: process.env.GEMINI_API_KEY,
  baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
});

const DOCUMENTS_DIR = path.join(__dirname, "documents");
const KNOWLEDGE_DIR = path.join(__dirname, "knowledge");
const MEMORY_FILE = path.join(__dirname, "memory.json");
const MAX_HISTORY = 20;

// ======================================================
// DUMMY WEB SERVER (Render free tier needs a port)
// ======================================================
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Digaf support bot is alive\n");
}).listen(process.env.PORT || 3000, () => {
  console.log("🌐 Dummy web server listening on port", process.env.PORT || 3000);
});

// ======================================================
// LOAD KNOWLEDGE FILES
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
// MEMORY
// ======================================================
let memory = {};
if (fs.existsSync(MEMORY_FILE)) {
  try {
    memory = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
    console.log("🧠 Loaded memory for", Object.keys(memory).length, "chats");
  } catch (e) {
    console.log("⚠️ Could not load memory:", e.message);
    memory = {};
  }
}

function saveMemory() {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
  } catch (e) {
    console.log("⚠️ Could not save memory:", e.message);
  }
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
async function getTelegramUpdates(offset = 0) {
  const url =
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates` +
    `?offset=${offset}&timeout=30` +
    `&allowed_updates=${encodeURIComponent(
      JSON.stringify(["business_message", "message"])
    )}`;
  const response = await fetch(url);
  return response.json();
}

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
function buildSystemPrompt() {
  const docKeys = Object.keys(documentsRegistry);
  const bankList = bankAccounts.accounts
    .map((a) => `${a.bank} → ${a.account}`)
    .join("\n");

  const exampleText = examples.examples
    .map((ex) => `Customer: ${ex.customer}\nIntent: ${ex.intent}\nApproved: ${ex.approved_response}`)
    .join("\n---\n");

  return `You are the official customer-service AI assistant for DIGAF MICRO CREDIT PROVIDER S.C. (ድጋፍ ማይክሮ ክሬዲት አቅራቢ አ.ማ).

IDENTITY RULES:
- You are polite, professional, and helpful — like a trained Digaf employee.
- If a customer asks if you are human, say honestly that you are the Digaf customer-service AI assistant. Do NOT pretend to be a specific human.
- Reply in the SAME language the customer uses: Amharic, English, or mixed.
- Keep replies short and clear unless detailed info is required.
- NEVER invent: loan amounts, interest rates, approval decisions, account balances, service areas, processing times, bank account numbers, or policies.
- NEVER promise a loan approval.
- NEVER claim you have checked an internal system.
- If unsure → escalate to a human, do NOT guess.

OUTPUT FORMAT — reply ONLY with valid JSON, no markdown, no extra text:

{
  "intent": "GREETING",
  "document_type": null,
  "reply": "text to send to customer",
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
"reply": "short friendly message like 'እነሆ ፋይሉ 📄' or 'Here is the file 📄'"

When the case needs a human, set:
"intent": "HUMAN_ESCALATION",
"reply": "short polite holding message for the customer",
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

==================================================
ESCALATE TO HUMAN when:
- Loan approval status
- Account-specific balances
- Payment disputes
- Complaints
- Anything requiring internal systems
- Any question NOT covered by approved knowledge above

Remember: accuracy > creativity. NEVER guess. NEVER invent. Reply with JSON only.`;
}

// ======================================================
// AI CALL
// ======================================================
async function askAI(chatId, customerMessage) {
  addToHistory(chatId, "user", customerMessage);

  const history = memory[String(chatId)] || [];

  const response = await openai.chat.completions.create({
    model: GEMINI_MODEL,
    messages: [
      { role: "system", content: buildSystemPrompt() },
      ...history,
    ],
    response_format: { type: "json_object" },
  });

  const raw = response.choices[0].message.content;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.log("⚠️ Gemini returned non-JSON:", raw);
    parsed = {
      intent: "UNKNOWN",
      document_type: null,
      reply: "ይቅርታ፣ ጥያቄዎን ለሰው ሰራተኛ እናስተላልፋለን።\nSorry, forwarding your message to a staff member.",
      escalation_reason: "Invalid AI response",
    };
  }

  if (parsed.document_type && !documentsRegistry[parsed.document_type]) {
    console.log(`⚠️ Invalid document_type from AI: ${parsed.document_type}`);
    parsed.document_type = null;
  }

  const allowedIntents = [
    "GREETING","LOAN_TYPE_SELECTION","PAYDAY_LOAN","SALARY_LOAN","SALARY_ADVANCE","BUSINESS_LOAN",
    "LOAN_REQUIREMENTS","LOAN_60_90_DAYS","PAYMENT_INFORMATION","BANK_ACCOUNT_REQUEST",
    "TELEBIRR_PAYMENT","TELEBIRR_THIRD_PARTY_ACCOUNT","SERVICE_AREA","NON_BANK_INSTITUTION",
    "DOCUMENT_REQUEST","GENERAL_INFORMATION","COMPLAINT","PAYMENT_DISPUTE",
    "ACCOUNT_SPECIFIC_REQUEST","LOAN_APPROVAL_REQUEST","UNKNOWN","HUMAN_ESCALATION",
  ];
  if (!allowedIntents.includes(parsed.intent)) {
    parsed.intent = "UNKNOWN";
  }

  addToHistory(chatId, "assistant", parsed.reply || "");
  return parsed;
}

// ======================================================
// PENDING ESCALATIONS
// ======================================================
const pendingQuestions = new Map();

// ======================================================
// MAIN LOOP
// ======================================================
async function main() {
  console.log("🏦 Digaf customer-service AI is running...");
  console.log("📡 Waiting for messages...");

  let offset = 0;

  while (true) {
    try {
      const data = await getTelegramUpdates(offset);
      if (!data.ok) {
        console.log("Telegram error:", data);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }

      for (const update of data.result) {
        offset = update.update_id + 1;

        // ============ CUSTOMER MESSAGE (business) ============
        if (update.business_message) {
          const message = update.business_message;

          // Ignore messages sent BY the owner
          if (String(message.from?.id) === String(OWNER_CHAT_ID)) {
            console.log(`↩️ Skipping owner's own outgoing message`);
            continue;
          }

          const businessConnectionId = message.business_connection_id;
          const customerChatId = message.chat.id;
          const customerName =
            message.from?.first_name || message.from?.username || "Customer";

          // ---------- 1) Customer sent a DOCUMENT ----------
          if (message.document) {
            console.log(`📎 Customer (${customerName}) sent a document: ${message.document.file_name || "file"}`);

            await sendTelegramMessage(
              businessConnectionId,
              customerChatId,
              "ሰነዱን ተቀብለናል፣ በመመርመር ላይ ነን።\nWe received your document and are checking it."
            );

            const sent = await sendToOwner(
              `📎 CUSTOMER DOCUMENT\n\nCustomer: ${customerName}\nChat ID: ${customerChatId}\nFile: ${message.document.file_name || "document"}\n${message.caption ? `Caption: ${message.caption}` : ""}\n\n✍️ Reply to THIS message with what to send to the customer.`
            );

            await sendTelegramDocumentByFileId(
              null,
              OWNER_CHAT_ID,
              message.document.file_id,
              `From ${customerName}`
            );

            pendingQuestions.set(sent.result.message_id, {
              businessConnectionId,
              customerChatId,
              customerName,
            });

            console.log(`📨 Document forwarded to owner (msg ${sent.result.message_id})`);
            continue;
          }

          // ---------- 2) Customer sent a PHOTO ----------
          if (message.photo && message.photo.length > 0) {
            console.log(`🖼 Customer (${customerName}) sent a photo`);

            await sendTelegramMessage(
              businessConnectionId,
              customerChatId,
              "ፎቶውን ተቀብለናል፣ በመመርመር ላይ ነን።\nWe received your photo and are checking it."
            );

            const sent = await sendToOwner(
              `🖼 CUSTOMER PHOTO\n\nCustomer: ${customerName}\nChat ID: ${customerChatId}\n${message.caption ? `Caption: ${message.caption}` : ""}\n\n✍️ Reply to THIS message with what to send to the customer.`
            );

            const fileId = message.photo[message.photo.length - 1].file_id;
            await sendTelegramPhoto(null, OWNER_CHAT_ID, fileId, `From ${customerName}`);

            pendingQuestions.set(sent.result.message_id, {
              businessConnectionId,
              customerChatId,
              customerName,
            });

            console.log(`📨 Photo forwarded to owner (msg ${sent.result.message_id})`);
            continue;
          }

          // ---------- 3) Customer sent TEXT ----------
          if (message.text) {
            const incomingText = message.text;
            console.log(`📩 Customer (${customerName}): ${incomingText}`);

            const ai = await askAI(customerChatId, incomingText);
            console.log(`🧠 Intent: ${ai.intent}`);
            console.log(`🤖 AI reply: ${ai.reply}`);

            // --- DOCUMENT REQUEST ---
            if (ai.intent === "DOCUMENT_REQUEST" && ai.document_type) {
              const entry = documentsRegistry[ai.document_type];
              const filePath = path.join(DOCUMENTS_DIR, entry.file);

              if (!fs.existsSync(filePath)) {
                console.log(`❌ Missing file: ${filePath}`);
                await sendTelegramMessage(
                  businessConnectionId, customerChatId,
                  "ይቅርታ፣ ፋይሉ ለጊዜው አልተገኘም። ለሰው ሰራተኛ እናስተላልፋለን።\nSorry, the file is unavailable. Forwarding to staff."
                );
                await sendToOwner(`⚠️ Missing document file: ${entry.file} (requested by ${customerName})`);
                continue;
              }

              if (ai.reply) {
                await sendTelegramMessage(businessConnectionId, customerChatId, ai.reply);
              }
              await sendTelegramDocument(businessConnectionId, customerChatId, filePath, entry.caption || entry.name);
              console.log(`📄 Sent document: ${entry.file}`);
              continue;
            }

            // --- HUMAN ESCALATION ---
            if (ai.intent === "HUMAN_ESCALATION") {
              const sent = await sendToOwner(
                `❓ HUMAN ESCALATION\n\nCustomer: ${customerName}\nChat ID: ${customerChatId}\n\nMessage:\n"${incomingText}"\n\nReason:\n${ai.escalation_reason || "Requires human verification"}\n\n✍️ Reply to THIS message with the response to send to the customer.`
              );

              pendingQuestions.set(sent.result.message_id, {
                businessConnectionId,
                customerChatId,
                customerName,
              });

              if (ai.reply) {
                await sendTelegramMessage(businessConnectionId, customerChatId, ai.reply);
              }

              console.log(`📨 Escalated to owner (msg ${sent.result.message_id})`);
              continue;
            }

            // --- NORMAL REPLY ---
            await sendTelegramMessage(businessConnectionId, customerChatId, ai.reply);
            console.log("✅ Reply sent to customer");
            continue;
          }

          // ---------- 4) Unsupported ----------
          console.log(`ℹ️ Unsupported customer message type from ${customerName}`);
          continue;
        }

        // ============ OWNER REPLY (private chat) ============
        if (update.message) {
          const msg = update.message;
          const fromId = msg.chat.id;
          const replyTo = msg.reply_to_message?.message_id;

          if (String(fromId) !== String(OWNER_CHAT_ID)) continue;
          if (!replyTo || !pendingQuestions.has(replyTo)) {
            console.log("ℹ️ Owner message ignored (no pending escalation)");
            continue;
          }

          const pending = pendingQuestions.get(replyTo);

          // Owner replied with a DOCUMENT
          if (msg.document) {
            await sendTelegramDocumentByFileId(
              pending.businessConnectionId,
              pending.customerChatId,
              msg.document.file_id,
              msg.caption || ""
            );
            addToHistory(pending.customerChatId, "assistant", `[document] ${msg.caption || ""}`);
            pendingQuestions.delete(replyTo);
            await sendToOwner(`✅ Document sent to ${pending.customerName}`);
            console.log(`✅ Owner document forwarded to ${pending.customerName}`);
            continue;
          }

          // Owner replied with a PHOTO
          if (msg.photo && msg.photo.length > 0) {
            const fileId = msg.photo[msg.photo.length - 1].file_id;
            await sendTelegramPhoto(
              pending.businessConnectionId,
              pending.customerChatId,
              fileId,
              msg.caption || ""
            );
            addToHistory(pending.customerChatId, "assistant", `[photo] ${msg.caption || ""}`);
            pendingQuestions.delete(replyTo);
            await sendToOwner(`✅ Photo sent to ${pending.customerName}`);
            console.log(`✅ Owner photo forwarded to ${pending.customerName}`);
            continue;
          }

          // Owner replied with TEXT
          if (msg.text) {
            await sendTelegramMessage(
              pending.businessConnectionId,
              pending.customerChatId,
              msg.text
            );
            addToHistory(pending.customerChatId, "assistant", msg.text);
            pendingQuestions.delete(replyTo);
            await sendToOwner(`✅ Sent to ${pending.customerName}`);
            console.log(`✅ Owner text forwarded to ${pending.customerName}`);
            continue;
          }
        }
      }
    } catch (error) {
      console.error("❌ Error:", error.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

main();
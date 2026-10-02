require("dotenv").config();
const http = require("http");
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");

const openai = new OpenAI({
  apiKey: process.env.GEMINI_API_KEY,
  baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
});

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;

// ---------- Dummy web server (Render free tier needs a port) ----------
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Zewdneh bot is alive\n");
}).listen(process.env.PORT || 3000, () => {
  console.log("🌐 Dummy web server listening on port", process.env.PORT || 3000);
});

// ---------- Memory storage ----------
const MEMORY_FILE = path.join(__dirname, "memory.json");
const MAX_HISTORY = 100;

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

// ---------- Telegram helpers ----------

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
  if (businessConnectionId) {
    body.business_connection_id = businessConnectionId;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const result = await response.json();
  if (!result.ok) {
    throw new Error(`Telegram send error: ${JSON.stringify(result)}`);
  }
  return result;
}

// ---------- Send a PHOTO to a chat ----------
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
  if (!result.ok) {
    throw new Error(`Telegram sendPhoto error: ${JSON.stringify(result)}`);
  }
  return result;
}

async function sendToOwner(text) {
  return sendTelegramMessage(null, OWNER_CHAT_ID, text);
}

// ---------- AI (text reply) ----------

async function askAI(chatId, message) {
  addToHistory(chatId, "user", message);

  const history = memory[String(chatId)] || [];

  const response = await openai.chat.completions.create({
    model: "gemini-3.5-flash-lite",
    messages: [
      {
        role: "system",
        content:
          "You ARE Zewdneh. You are replying to Zewdneh's friends on Telegram as Zewdneh himself. " +
          "Never say you are an AI, bot, program, or assistant. Never break character. " +
          "Reply naturally, casually, and briefly — like a real friend texting on Telegram. " +
          "Match the language the friend uses (Amharic, English, or mixed). " +
          "Use casual, friendly tone. It's okay to use emojis sometimes. " +
          "DEFAULT BEHAVIOR: just reply normally as Zewdneh would. Do NOT ask Zewdneh for permission for normal chat. " +
          "ONLY use the ASK_ZEWDNEH format when the message is about: " +
          "money, sending/receiving payments, meeting up in person, love/relationship, " +
          "secrets, family issues, or something ONLY the real Zewdneh would know. " +
          "Greetings, small talk, jokes, 'how are you', 'what's up', and casual chat MUST be answered directly without asking. " +
          "When you DO need to ask, reply with exactly: " +
          "[ASK_ZEWDNEH]: <the friend's message> — what should I reply?",
      },
      ...history,
    ],
  });

  const answer = response.choices[0].message.content;
  addToHistory(chatId, "assistant", answer);
  return answer;
}

// ---------- Pending questions ----------
const pendingQuestions = new Map();

// ---------- Main loop ----------

async function main() {
  console.log("🤖 Zewdneh AI assistant is running...");
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

        // ============ 1) Friend message (business) ============
        if (update.business_message && update.business_message.text) {
          const message = update.business_message;
          const businessConnectionId = message.business_connection_id;
          const chatId = message.chat.id;
          const incomingText = message.text;

          console.log(`📩 Friend: ${incomingText}`);

          const answer = await askAI(chatId, incomingText);
          console.log(`🤖 AI: ${answer}`);

          if (answer.trim().startsWith("[ASK_ZEWDNEH]")) {
            const friendName =
              message.from?.first_name || message.from?.username || "Friend";

            const sent = await sendToOwner(
              `❓ ${friendName} asked:\n"${incomingText}"\n\n✍️ Reply to THIS message with what I should send.`
            );

            pendingQuestions.set(sent.result.message_id, {
              businessConnectionId,
              friendChatId: chatId,
              friendName,
            });

            console.log(`📨 Forwarded question to owner (msg ${sent.result.message_id})`);
            continue;
          }

          await sendTelegramMessage(businessConnectionId, chatId, answer);
          console.log("✅ Reply sent to friend");
          continue;
        }

        // ============ 2) Owner reply (private chat) ============
        if (update.message && update.message.text) {
          const msg = update.message;
          const fromId = msg.chat.id;
          const replyTo = msg.reply_to_message?.message_id;

          if (String(fromId) !== String(OWNER_CHAT_ID)) continue;

          // ----- 2a) Owner sends a PHOTO to forward to a friend -----
          if (
            replyTo &&
            pendingQuestions.has(replyTo) &&
            msg.photo &&
            msg.photo.length > 0
          ) {
            const pending = pendingQuestions.get(replyTo);
            // get largest photo
            const fileId = msg.photo[msg.photo.length - 1].file_id;
            const caption = msg.caption || "";

            await sendTelegramPhoto(
              pending.businessConnectionId,
              pending.friendChatId,
              fileId,
              caption
            );

            addToHistory(pending.friendChatId, "assistant", `[photo] ${caption}`);
            pendingQuestions.delete(replyTo);

            await sendToOwner(`✅ Photo sent to ${pending.friendName}`);
            console.log(`✅ Owner photo forwarded to ${pending.friendName}`);
            continue;
          }

          // ----- 2b) Owner sends TEXT reply -----
          if (!replyTo || !pendingQuestions.has(replyTo)) {
            console.log("ℹ️ Owner message ignored (no pending question)");
            continue;
          }

          const pending = pendingQuestions.get(replyTo);
          pendingQuestions.delete(replyTo);

          await sendTelegramMessage(
            pending.businessConnectionId,
            pending.friendChatId,
            msg.text
          );

          addToHistory(pending.friendChatId, "assistant", msg.text);

          await sendToOwner(`✅ Sent to ${pending.friendName}`);
          console.log(`✅ Owner reply forwarded to ${pending.friendName}`);
          continue;
        }
      }
    } catch (error) {
      console.error("❌ Error:", error.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

main();
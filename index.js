require("dotenv").config();
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");

const openai = new OpenAI({
  apiKey: process.env.GEMINI_API_KEY,
  baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
});

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;

// ---------- Memory storage ----------
const MEMORY_FILE = path.join(__dirname, "memory.json");
const MAX_HISTORY = 100; // last 100 messages per friend

let memory = {}; // { [friendChatId]: [ {role, content}, ... ] }

// Load memory from disk
if (fs.existsSync(MEMORY_FILE)) {
  try {
    memory = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
    console.log("🧠 Loaded memory for", Object.keys(memory).length, "chats");
  } catch (e) {
    console.log("⚠️ Could not load memory:", e.message);
    memory = {};
  }
}

// Save memory to disk
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

async function sendToOwner(text) {
  return sendTelegramMessage(null, OWNER_CHAT_ID, text);
}

// ---------- AI ----------

async function askAI(chatId, message) {
  // Save the friend's new message to memory
  addToHistory(chatId, "user", message);

  const history = memory[String(chatId)] || [];

  const response = await openai.chat.completions.create({
    model: "gemini-3.5-flash-lite",
    messages: [
      {
        role: "system",
        content:
          "You ARE Zewdneh. You are replying to Zewdneh's friends on Telegram as Zewdneh himself. " +
          "Never say you are an AI, a bot, a program, or an assistant. " +
          "Never break character. " +
          "Reply naturally, casually, and briefly, like a real friend texting. " +
          "You remember the conversation history with each friend. " +
          "Answer in the same language the friend uses. " +
          "If you are not sure how Zewdneh would reply, or the message is sensitive, personal, about plans, money, love, or something only Zewdneh would know, " +
          "then reply with exactly this format and nothing else: " +
          "[ASK_ZEWDNEH]: <the friend's message> — what should I reply?",
      },
      ...history,
    ],
  });

  const answer = response.choices[0].message.content;

  // Save AI reply to memory too (so it remembers what it said)
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
              message.from?.first_name ||
              message.from?.username ||
              "Friend";

            const sent = await sendToOwner(
              `❓ ${friendName} asked:\n"${incomingText}"\n\n✍️ Reply to THIS message with what I should send.`
            );

            const ownerMsgId = sent.result.message_id;

            pendingQuestions.set(ownerMsgId, {
              businessConnectionId,
              friendChatId: chatId,
              friendName,
            });

            console.log(
              `📨 Forwarded question to owner (msg ${ownerMsgId})`
            );
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

          // Save your manual reply into that friend's memory too
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
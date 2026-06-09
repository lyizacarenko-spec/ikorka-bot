import TelegramBot from "node-telegram-bot-api";
import pkg from "pg";
import Groq from "groq-sdk";
import * as cron from "node-cron";

const { Pool } = pkg;

// ─── ENV ─────────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const GROQ_API_KEY = process.env.GROQ_API_KEY!;
const DATABASE_URL = process.env.DATABASE_URL!;
import fs from "fs";
const WELCOME_PHOTO_PATH = "./welcome.png";
const WELCOME_PHOTO_FALLBACK = "https://i.postimg.cc/K8cGfryZ/2024-02-10-0342.jpg";
function getWelcomePhoto(): string | fs.ReadStream {
  if (fs.existsSync(WELCOME_PHOTO_PATH)) return fs.createReadStream(WELCOME_PHOTO_PATH);
  return WELCOME_PHOTO_FALLBACK;
}

// ─── DB ──────────────────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id TEXT PRIMARY KEY,
      first_name TEXT,
      username TEXT,
      quiz_score INT DEFAULT 0,
      quiz_total INT DEFAULT 0,
      roleplay_count INT DEFAULT 0,
      notifications_enabled BOOLEAN DEFAULT true,
      notify_hour_utc INT DEFAULT 6,
      last_active_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      telegram_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      state JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS weekly_scores (
      id SERIAL PRIMARY KEY,
      telegram_id TEXT NOT NULL,
      first_name TEXT,
      username TEXT,
      week_start DATE NOT NULL,
      score INT DEFAULT 0,
      total INT DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(telegram_id, week_start)
    );
    CREATE TABLE IF NOT EXISTS daily_challenges (
      id SERIAL PRIMARY KEY,
      date TEXT UNIQUE NOT NULL,
      question TEXT NOT NULL,
      options JSONB NOT NULL,
      correct_index INT NOT NULL,
      explanation TEXT NOT NULL,
      topic TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS daily_responses (
      id SERIAL PRIMARY KEY,
      telegram_id TEXT NOT NULL,
      first_name TEXT,
      username TEXT,
      challenge_date TEXT NOT NULL,
      correct BOOLEAN NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(telegram_id, challenge_date)
    );
    CREATE TABLE IF NOT EXISTS access_requests (
      telegram_id TEXT PRIMARY KEY,
      first_name TEXT,
      username TEXT,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ DEFAULT NOW();
  `);
  console.log("✅ DB initialized");
}

async function getOrCreateUser(telegramId: string, firstName?: string, username?: string) {
  const res = await pool.query(
    `INSERT INTO users (telegram_id, first_name, username, last_active_at) VALUES ($1, $2, $3, NOW())
     ON CONFLICT (telegram_id) DO UPDATE SET
       first_name = COALESCE($2, users.first_name),
       username = COALESCE($3, users.username),
       last_active_at = NOW()
     RETURNING *`,
    [telegramId, firstName ?? null, username ?? null]
  );
  return res.rows[0];
}

async function getUser(telegramId: string) {
  const res = await pool.query("SELECT * FROM users WHERE telegram_id = $1", [telegramId]);
  return res.rows[0] ?? null;
}

async function updateLastActive(telegramId: string) {
  await pool.query("UPDATE users SET last_active_at = NOW() WHERE telegram_id = $1", [telegramId]);
}

async function incrementQuizScore(telegramId: string, correct: boolean) {
  await pool.query(
    `UPDATE users SET quiz_score = quiz_score + $1, quiz_total = quiz_total + 1, updated_at = NOW() WHERE telegram_id = $2`,
    [correct ? 1 : 0, telegramId]
  );
}

async function incrementRoleplayCount(telegramId: string) {
  await pool.query("UPDATE users SET roleplay_count = roleplay_count + 1, updated_at = NOW() WHERE telegram_id = $1", [telegramId]);
}

async function getActiveSession(telegramId: string) {
  const res = await pool.query("SELECT * FROM sessions WHERE telegram_id = $1", [telegramId]);
  return res.rows[0] ?? null;
}

async function upsertSession(telegramId: string, mode: string, state: object) {
  await pool.query(
    `INSERT INTO sessions (telegram_id, mode, state) VALUES ($1, $2, $3)
     ON CONFLICT (telegram_id) DO UPDATE SET mode = $2, state = $3, updated_at = NOW()`,
    [telegramId, mode, JSON.stringify(state)]
  );
}

async function deleteSession(telegramId: string) {
  await pool.query("DELETE FROM sessions WHERE telegram_id = $1", [telegramId]);
}

async function toggleNotifications(telegramId: string): Promise<boolean> {
  const res = await pool.query(
    "UPDATE users SET notifications_enabled = NOT notifications_enabled, updated_at = NOW() WHERE telegram_id = $1 RETURNING notifications_enabled",
    [telegramId]
  );
  return res.rows[0]?.notifications_enabled ?? false;
}

async function setNotifyHour(telegramId: string, hourUtc: number) {
  await pool.query("UPDATE users SET notify_hour_utc = $1, updated_at = NOW() WHERE telegram_id = $2", [hourUtc, telegramId]);
}

function getCurrentWeekStart(): string {
  const now = new Date();
  const day = now.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() + diff);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.toISOString().slice(0, 10);
}

async function upsertWeeklyScore(telegramId: string, firstName: string | null, username: string | null, correct: boolean) {
  const weekStart = getCurrentWeekStart();
  await pool.query(
    `INSERT INTO weekly_scores (telegram_id, first_name, username, week_start, score, total)
     VALUES ($1, $2, $3, $4, $5, 1)
     ON CONFLICT (telegram_id, week_start) DO UPDATE SET
       score = weekly_scores.score + $5,
       total = weekly_scores.total + 1,
       first_name = COALESCE($2, weekly_scores.first_name),
       username = COALESCE($3, weekly_scores.username),
       updated_at = NOW()`,
    [telegramId, firstName, username, weekStart, correct ? 1 : 0]
  );
}

async function getLeaderboard(limit = 10) {
  const res = await pool.query(
    "SELECT * FROM users WHERE quiz_total > 0 ORDER BY quiz_score DESC, quiz_total DESC LIMIT $1",
    [limit]
  );
  return res.rows.map((u: any) => ({
    telegramId: u.telegram_id,
    firstName: u.first_name,
    username: u.username,
    quizScore: u.quiz_score,
    quizTotal: u.quiz_total,
    pct: Math.round((u.quiz_score / u.quiz_total) * 100),
  }));
}

async function getWeeklyLeaderboard(limit = 10) {
  const weekStart = getCurrentWeekStart();
  const res = await pool.query(
    "SELECT * FROM weekly_scores WHERE week_start = $1 AND total > 0 ORDER BY score DESC, total DESC LIMIT $2",
    [weekStart, limit]
  );
  return res.rows.map((r: any) => ({
    telegramId: r.telegram_id,
    firstName: r.first_name,
    username: r.username,
    score: r.score,
    total: r.total,
    pct: Math.round((r.score / r.total) * 100),
  }));
}

function getTodayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

async function getOrCreateDailyChallenge(generateFn: () => Promise<any>) {
  const date = getTodayDate();
  const res = await pool.query("SELECT * FROM daily_challenges WHERE date = $1", [date]);
  if (res.rows.length > 0) return res.rows[0];
  const data = await generateFn();
  const ins = await pool.query(
    "INSERT INTO daily_challenges (date, question, options, correct_index, explanation, topic) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
    [date, data.question, JSON.stringify(data.options), data.correctIndex, data.explanation, data.topic]
  );
  return ins.rows[0];
}

async function getDailyChallengeById(id: number) {
  const res = await pool.query("SELECT * FROM daily_challenges WHERE id = $1", [id]);
  return res.rows[0] ?? null;
}

async function getDailyResponse(telegramId: string, date: string) {
  const res = await pool.query(
    "SELECT * FROM daily_responses WHERE telegram_id = $1 AND challenge_date = $2",
    [telegramId, date]
  );
  return res.rows[0] ?? null;
}

async function saveDailyResponse(telegramId: string, firstName: string | null, username: string | null, date: string, correct: boolean) {
  await pool.query(
    "INSERT INTO daily_responses (telegram_id, first_name, username, challenge_date, correct) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
    [telegramId, firstName, username, date, correct]
  );
}

async function getDailyStats(date: string) {
  const res = await pool.query("SELECT * FROM daily_responses WHERE challenge_date = $1", [date]);
  const rows = res.rows;
  const totalAnswered = rows.length;
  const totalCorrect = rows.filter((r: any) => r.correct).length;
  const correctPct = totalAnswered > 0 ? Math.round((totalCorrect / totalAnswered) * 100) : 0;
  const topCorrect = rows.filter((r: any) => r.correct).slice(0, 5).map((r: any) => ({ firstName: r.first_name, username: r.username }));
  return { totalAnswered, totalCorrect, correctPct, topCorrect };
}

async function getUsersForNotification(hourUtc: number) {
  const res = await pool.query(
    "SELECT telegram_id, first_name FROM users WHERE notifications_enabled = true AND notify_hour_utc = $1",
    [hourUtc]
  );
  return res.rows;
}

// Отримати користувачів які не були активні більше 24 годин (для нагадувань)
async function getInactiveUsers(hoursInactive = 24) {
  const res = await pool.query(
    `SELECT telegram_id, first_name, quiz_total, roleplay_count
     FROM users
     WHERE notifications_enabled = true
       AND last_active_at < NOW() - INTERVAL '${hoursInactive} hours'
       AND created_at < NOW() - INTERVAL '1 hour'`,
  );
  return res.rows;
}

// ─── ACCESS CONTROL ───────────────────────────────────────────────────────────
const ADMIN_ID = "620838766";

async function getAccessStatus(telegramId: string): Promise<string | null> {
  const res = await pool.query("SELECT status FROM access_requests WHERE telegram_id = $1", [telegramId]);
  return res.rows[0]?.status ?? null;
}

async function upsertAccessRequest(telegramId: string, firstName: string | null, username: string | null) {
  await pool.query(
    `INSERT INTO access_requests (telegram_id, first_name, username, status)
     VALUES ($1, $2, $3, 'pending')
     ON CONFLICT (telegram_id) DO UPDATE SET
       first_name = COALESCE($2, access_requests.first_name),
       username = COALESCE($3, access_requests.username),
       updated_at = NOW()`,
    [telegramId, firstName, username]
  );
}

async function setAccessStatus(telegramId: string, status: string) {
  await pool.query(
    "UPDATE access_requests SET status = $1, updated_at = NOW() WHERE telegram_id = $2",
    [status, telegramId]
  );
}

// ─── RATE LIMITER ─────────────────────────────────────────────────────────────
class RequestQueue {
  private queue: Array<() => Promise<any>> = [];
  private running = 0;
  private maxConcurrent: number;
  private minDelayMs: number;

  constructor(maxConcurrent = 2, minDelayMs = 500) {
    this.maxConcurrent = maxConcurrent;
    this.minDelayMs = minDelayMs;
  }

  async add<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (err) {
          reject(err);
        }
      });
      this.process();
    });
  }

  private async process() {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) return;
    this.running++;
    const fn = this.queue.shift()!;
    await fn();
    await new Promise(r => setTimeout(r, this.minDelayMs));
    this.running--;
    this.process();
  }
}

const groqQueue = new RequestQueue(2, 600);

// ─── RETRY HELPER ─────────────────────────────────────────────────────────────
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3, delayMs = 2000): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const isRateLimit = err?.status === 429 || err?.message?.includes("rate limit") || err?.message?.includes("Rate limit");
      const isTimeout = err?.message?.includes("timeout") || err?.code === "ETIMEDOUT";
      if ((isRateLimit || isTimeout) && attempt < maxAttempts) {
        const waitMs = delayMs * attempt;
        console.warn(`⚠️ Groq error (attempt ${attempt}/${maxAttempts}), retrying in ${waitMs}ms...`, err?.message);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Max retry attempts reached");
}

// ─── GROQ ─────────────────────────────────────────────────────────────────────
const groq = new Groq({ apiKey: GROQ_API_KEY });

function sanitizeUkrainian(text: string): string {
  return text
    .replace(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g, "")
    .replace(/[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function geminiChat(systemPrompt: string, userMessage: string, maxTokens = 1024): Promise<string> {
  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
  });
  return response.choices[0]?.message?.content ?? "";
}

async function geminiChatWithHistory(systemPrompt: string, history: Array<{role: string, content: string}>, userMessage: string, maxTokens = 300): Promise<string> {
  const messages = [
    { role: "system" as const, content: systemPrompt },
    ...history.map((m: any) => ({ role: m.role as "user" | "assistant", content: m.content })),
    { role: "user" as const, content: userMessage },
  ];
  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    max_tokens: maxTokens,
    messages,
  });
  return response.choices[0]?.message?.content ?? "";
}

// ─── KNOWLEDGE BASE ───────────────────────────────────────────────────────────
const IKORKA_KNOWLEDGE = `
Ти — експерт з продуктів магазину Ikorka Shop. Всі відповіді тільки українською мовою.

АСОРТИМЕНТ ТА ЦІНИ (грн) — ТОЧНІ ДАНІ:

═══ ІКРА — СКЛО ═══
- Щука скло 500г: 429 грн
- Щука Преміум скло 500г: 489 грн
- Горбуша скло 440г: 449 грн
- Горбуша Преміум скло 500г: 569 грн
- Форель скло 440г: 459 грн
- Лосось скло 500г: 509 грн
- Кижуч скло 500г: 509 грн
- Кета скло 500г: 539 грн
- Кета Преміум скло 500г: 609 грн
- Веслонос скло 500г: 559 грн
- Осетер скло 440г: 549 грн
- Осетер Преміум скло 500г: 629 грн

═══ ІКРА — ПЛАСТИК (всі 500г) ═══
- Щука пластик 500г: 379 грн
- Горбуша пластик 500г: 399 грн
- Горбуша Преміум пластик 500г: 549 грн
- Форель пластик 500г: 409 грн
- Лосось пластик 500г: 459 грн
- Кижуч пластик 500г: 459 грн
- Кета пластик 500г: 499 грн
- Веслонос пластик 500г: 509 грн
- Осетер пластик 500г: 529 грн
- Осетер Преміум пластик 500г: 589 грн

ВАЖЛИВО: Щука Преміум — тільки скло 500г (пластик відсутній).
Горбуша в СКЛІ — 440г, в ПЛАСТИКУ — 500г. Форель в СКЛІ — 440г, в ПЛАСТИКУ — 500г. Осетер в СКЛІ — 440г, в ПЛАСТИКУ — 500г.

═══ РИБА (слабосолена) ═══
- Риба 300г: 369 грн (зі знижкою кожна 2-га: 339 грн)
- Риба 500г: 499 грн (зі знижкою кожна 2-га: 449 грн)
АКЦІЯ НА РИБУ: кожна друга упаковка зі знижкою (300г: 339 грн, 500г: 449 грн)

═══ КРЕМ-СИР PHILADELPHIA ═══
⚠️ ПРОДАЄТЬСЯ ТІЛЬКИ як доповнення до ікри або риби. Окремо НЕ відправляємо!
- Philadelphia Balance 195г: 115 грн
  (знижений вміст жиру -30%, ніжний вершковий смак, ідеально до ікри та риби)
- Philadelphia з зеленню 195г: 115 грн
  (з ароматними травами, ресторанний смак, до риби, ікри, овочів)
- Philadelphia з зеленою цибулею 175г: 125 грн
  (пікантний смак, до слабосоленої риби, бутербродів)

РОЗМІР ЗЕРНА (від меншого до більшого):
- Веслонос: 1.5-2 мм (найменше)
- Осетер: 2.5-3 мм (чорна ікра!)
- Щука: 2-3.5 мм
- Щука Преміум: 3-4 мм (більше зерно ніж звичайна щука)
- Форель: 4-4.5 мм
- Горбуша: 4-5 мм
- Лосось: 5-6 мм
- Кижуч: 5-5.5 мм
- Кета: 5-7 мм

✨ ПРЕМІУМ ЛІНІЙКА:
- Щука Преміум: 3-4 мм (тільки скло)
- Горбуша Преміум: 5-6 мм
- Осетер Преміум: 3-3.5 мм
- Кета Преміум: 6-8 мм (НАЙБІЛЬШЕ зерно!)

АКЦІЇ НА ІКРУ:
- 1+1=3: купуєш 2 банки — 3-тя безкоштовно (без знижки на інші банки)
- 3=4 + безкоштовна доставка: купуєш 3 — 4-та безкоштовно
- 4=6 + безкоштовна доставка: купуєш 4 — отримуєш 6 (НАЙВИГІДНІША!)
- 3=5: повна ціна, доставка за рахунок клієнта
- ХХЛ 1.5кг: 1299 грн (1=2)

РЕКОМЕНДАЦІЇ ДЛЯ ПОДАРУНКУ:
- Для подарунку ЗАВЖДИ рекомендуй СКЛО — виглядає презентабельно
- Найкращі варіанти для подарунку: Кета Преміум, Осетер Преміум, Лосось, Горбуша Преміум, Щука Преміум
- До подарунку з ікрою можна додати Philadelphia — виглядає як готовий делікатесний набір!
- Акції для подарунку: 3=4 або 4=6 з безкоштовною доставкою — найвигідніше для кількох подарунків

КОМБО-ПРОПОЗИЦІЇ (рекомендуй активно!):
- Ікра + Philadelphia Balance: класичний делікатес
- Ікра + Philadelphia з зеленню: ресторанна подача
- Риба + Philadelphia: ідеальний сніданок
- Риба + Ікра + Philadelphia: повний делікатесний набір

ЗБЕРІГАННЯ: ікра закрита — 3 місяці при 0-5°C; після відкриття — 14 діб у холодильнику.
КОМІСІЯ НП: 2% від суми + 20 грн — завжди попереджай клієнта!
ФОТО ПРОДУКТІВ: https://t.me/+KPwmfo_kSy83Yjhi
`;

const IKORKA_TOPICS = [
  "види ікри в асортименті Ikorka Shop",
  "ціни на ікру Ikorka Shop",
  "Щука Преміум — характеристики та ціна",
  "акція 1+1=3 на ікру",
  "акція 3=5 на ікру",
  "скляна упаковка ікри",
  "пластикова упаковка ікри",
  "розмір зерна різних видів ікри",
  "смакові характеристики ікри",
  "умови зберігання ікри",
  "робота із запереченнями при продажу ікри",
  "як запропонувати ікру як подарунок",
  "крем-сир Philadelphia — види та ціни",
  "крем-сир Philadelphia Balance — характеристики",
  "комбо ікра + Philadelphia",
  "слабосолена риба — ціни та акції",
  "комбо риба + крем-сир",
  "правила продажу Philadelphia (тільки з ікрою або рибою)",
];

async function generateQuizQuestion(previousTopics: string[] = [], previousQuestions: string[] = [], attempt = 0): Promise<any> {
  if (attempt >= 5) {
    throw new Error("Не вдалося згенерувати питання після 5 спроб");
  }

  const available = IKORKA_TOPICS.filter(t => !previousTopics.includes(t));
  const topic = available.length > 0
    ? available[Math.floor(Math.random() * available.length)]
    : IKORKA_TOPICS[Math.floor(Math.random() * IKORKA_TOPICS.length)];

  const prevQuestionsNote = previousQuestions.length > 0
    ? `\n\nВЖЕ ВИКОРИСТАНІ ПИТАННЯ (не повторювати):\n${previousQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`
    : "";

  const systemPrompt = `${IKORKA_KNOWLEDGE}${prevQuestionsNote}

Створи питання для тесту менеджера з продажу на тему: "${topic}".

СУВОРІ ПРАВИЛА ФОРМАТУ:
1. Поверни ТІЛЬКИ валідний JSON, без markdown-блоків
2. Формат варіантів відповідей: ["А) текст", "Б) текст", "В) текст", "Г) текст"]
3. ЗАБОРОНЕНО виділяти правильну відповідь — всі 4 варіанти однаково
4. correctIndex — індекс правильної відповіді (0–3)
5. Весь текст ТІЛЬКИ українською мовою — жодних польських, англійських чи інших слів!
6. ЗАБОРОНЕНО дублювати варіанти відповідей — всі 4 варіанти мають бути різними числами або текстами
7. Використовуй точні дані з бази знань — не вигадуй ціни чи розміри зерна
8. ВАЖЛИВО щодо акції 1+1=3: це означає купуєш 2 банки — 3-тя безкоштовно. БЕЗ обов'язкової знижки -5% на інші банки.

JSON:
{
  "question": "текст питання",
  "options": ["А) варіант1", "Б) варіант2", "В) варіант3", "Г) варіант4"],
  "correctIndex": 0,
  "explanation": "коротке пояснення з точними даними",
  "topic": "${topic}"
}`;

  const content = await groqQueue.add(() =>
    withRetry(() => geminiChat(systemPrompt, "Створи питання для квізу.", 1024))
  );

  let parsed: any;
  try {
    let cleaned = content.replace(/```json\n?|\n?```/g, "").trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) cleaned = jsonMatch[0];
    parsed = JSON.parse(cleaned);
  } catch {
    console.warn(`Quiz JSON parse failed (attempt ${attempt}), raw:`, content.slice(0, 200));
    return generateQuizQuestion(previousTopics, previousQuestions, attempt + 1);
  }

  if (!parsed?.question || !Array.isArray(parsed?.options) || parsed.options.length < 4 || parsed.correctIndex === undefined) {
    console.warn(`Quiz invalid structure (attempt ${attempt}):`, JSON.stringify(parsed).slice(0, 200));
    return generateQuizQuestion(previousTopics, previousQuestions, attempt + 1);
  }

  parsed.options = parsed.options.map((opt: string) =>
    opt.replace(/\*\*/g, "").replace(/\*/g, "").replace(/__/g, "").replace(/_/g, "")
  );

  const uniqueOptions = new Set(parsed.options.map((o: string) => o.replace(/^[А-Г]\) /, "").trim()));
  if (uniqueOptions.size < 4) {
    return generateQuizQuestion(previousTopics, previousQuestions, attempt + 1);
  }

  parsed.question = sanitizeUkrainian(parsed.question);
  parsed.explanation = sanitizeUkrainian(parsed.explanation);
  parsed.options = parsed.options.map((o: string) => sanitizeUkrainian(o));
  return parsed;
}

// ─── ROLEPLAY ─────────────────────────────────────────────────────────────────
const SCENARIOS = [
  {
    title: "Вибір подарунка",
    context: "Клієнт хоче купити ікру в подарунок на день народження.",
    customerPersona: `Ти граєш роль КЛІЄНТА на ім'я Наталія, 38 років. Ти хочеш купити ікру в подарунок колезі на ювілей, бюджет 1000-1500 грн. Ти НЕ розбираєшся в ікрі і не знаєш різниці між видами. Тебе лякають ціни, думаєш що краще купити цукерки. Говори тільки українською. ВАЖЛИВО: ти КЛІЄНТ — задаєш питання, сумніваєшся, не знаєш продукт. НЕ продавай ікру, НЕ давай поради як менеджер!`,
    objective: "Допомогти клієнту обрати ікру в подарунок, запропонувати скляну упаковку, акцію 3=4 або 4=6, і Philadelphia як доповнення до подарунку",
  },
  {
    title: "Заперечення по ціні",
    context: "Клієнт вважає ікру дорогою і порівнює з супермаркетом.",
    customerPersona: `Ти граєш роль КЛІЄНТА на ім'я Сергій, 45 років. Ти купуєш ікру в АТБ за 200 грн і вважаєш 449 грн занадто дорого. Ти прямий і скептичний. Говори тільки українською. ВАЖЛИВО: ти КЛІЄНТ — заперечуєш, порівнюєш ціни, сумніваєшся. НЕ продавай ікру!`,
    objective: "Обґрунтувати різницю у якості та запропонувати акцію",
  },
  {
    title: "Корпоративне замовлення",
    context: "Представник компанії хоче закупити ікру для 20 співробітників.",
    customerPersona: `Ти граєш роль КЛІЄНТА на ім'я Андрій, офіс-менеджер. Тобі потрібно 20 подарунків, бюджет до 15000 грн. Ти торгуєшся і шукаєш знижку. Говори тільки українською. ВАЖЛИВО: ти КЛІЄНТ — торгуєшся, питаєш про знижки. НЕ продавай ікру!`,
    objective: "Закрити на акцію та оформити велике замовлення, запропонувати додати Philadelphia до кожного подарункового набору",
  },
  {
    title: "Новачок, вперше купує ікру",
    context: "Молодий клієнт ніколи не купував ікру в спеціалізованому магазині.",
    customerPersona: `Ти граєш роль КЛІЄНТА на ім'я Кирило, 24 роки. Ти ніколи не їв ікру, все незнайоме. Ставиш наївні питання. Говори тільки українською. ВАЖЛИВО: ти КЛІЄНТ — не знаєш нічого про ікру, питаєш. НЕ продавай ікру!`,
    objective: "Навчити клієнта та продати ікру як оптимальний старт, запропонувати Philadelphia або рибу для повноцінного сніданку",
  },
  {
    title: "Клієнт іде до конкурента",
    context: "Постійний клієнт знайшов дешевше в іншому місці.",
    customerPersona: `Ти граєш роль КЛІЄНТА на ім'я Олена, 50 років. Ти знайшла ікру дешевше на маркетплейсі на 15%. Ти ввічлива але тверда. Говори тільки українською. ВАЖЛИВО: ти КЛІЄНТ — хочеш піти, потрібен вагомий аргумент щоб залишитись. НЕ продавай ікру!`,
    objective: "Утримати клієнта та запропонувати акцію, додати цінність через нові продукти (Philadelphia, риба)",
  },
  {
    title: "Продаж крем-сиру та риби",
    context: "Клієнт вже замовив ікру і менеджер пропонує доповнення.",
    customerPersona: `Ти граєш роль КЛІЄНТА на ім'я Марина, 35 років. Ти вже обрала ікру горбушу 2 банки. Не знаєш про Philadelphia і рибу в магазині. Говори тільки українською. ВАЖЛИВО: ти КЛІЄНТ — не знаєш про нові продукти, можеш зацікавитися якщо правильно запропонують. НЕ продавай ікру!`,
    objective: "Допродати Philadelphia та/або рибу до замовлення ікри. Пояснити що Philadelphia продається тільки з ікрою/рибою.",
  },
];

async function getRoleplayResponse(scenario: any, history: any[], userMessage: string) {
  const systemPrompt = `${scenario.customerPersona}

Правила гри:
- Ти КЛІЄНТ, користувач — МЕНЕДЖЕР з продажу ікри
- Відповідай коротко (1-3 речення) як реальний клієнт
- Будь реалістичним — не надто легким клієнтом
- Після 5-7 обмінів, якщо менеджер грамотно працює — показуй готовність купити
- НІКОЛИ не виходь з ролі клієнта
- НЕ продавай ікру, НЕ давай поради як менеджер
- Відповідай ТІЛЬКИ українською мовою`;

  const result = await groqQueue.add(() =>
    withRetry(() => geminiChatWithHistory(systemPrompt, history, userMessage, 300))
  );
  return result ?? "Зрозуміло. Розкажіть детальніше.";
}

async function getRoleplayFeedback(scenario: any, history: any[]) {
  const transcript = history.map((m: any) => `${m.role === "user" ? "Менеджер" : "Клієнт"}: ${m.content}`).join("\n");
  const systemPrompt = `Ти — тренер з продажів Ikorka Shop. Проаналізуй діалог. Сценарій: ${scenario.title}. Мета: ${scenario.objective}.\n${IKORKA_KNOWLEDGE}\n\nФормат:\n**Загальна оцінка**: [Відмінно/Добре/Потребує покращення]\n**Що вийшло добре**: [2-3 моменти]\n**Над чим попрацювати**: [2-3 рекомендації]\n**Ключовий прийом**: [одна порада]`;
  const result = await groqQueue.add(() =>
    withRetry(() => geminiChat(systemPrompt, `Транскрипт:\n\n${transcript}\n\nДай зворотний зв'язок.`, 1024))
  );
  return result ?? "Гарна спроба! Продовжуйте практикуватися.";
}

// ─── SCRIPTS ──────────────────────────────────────────────────────────────────
const SCRIPTS: Record<string, string> = {
  doroho: `💰 *Скрипт: Робота з "Дорого"*

1️⃣ *Приєднайся*
"Розумію вас, ціна важлива. Давайте подивимось разом..."

2️⃣ *Порахуй вартість порції*
"Банка 500г — це 10-15 бутербродів. Виходить ~30-40 грн за порцію. Це дешевше ніж суші чи ресторан 🍣"

3️⃣ *Порівняй з магазином*
"В АТБ ікра з консервантами, термін — роки. Наша: ікра + сіль + олія. Різниця відчувається одразу!"

4️⃣ *Запропонуй вигоду*
"Зараз є акція 4=6 з безкоштовною доставкою — фактично 2 банки у подарунок!"

5️⃣ *Закрий*
"Оформлюємо на завтра чи на п'ятницю?"`,

  zakryttia: `📦 *Скрипт: Закриття на замовлення*

1️⃣ *Підсумуй вибір*
"Отже, ви обрали [вид ікри], [упаковка], [кількість]. Правильно?"

2️⃣ *Запропонуй доп. продаж*
"До цього замовлення чудово підійде Philadelphia або слабосолена риба — готовий делікатесний набір! Додаємо?"

3️⃣ *Уточни доставку*
"Доставка Новою Поштою. При накладеному платежі комісія НП: 2% + 20 грн."

4️⃣ *Закрий питанням*
"Оплата карткою чи накладеним? Доставка на завтра чи після завтра?"

5️⃣ *Підтвердження*
"Чудово! Записую замовлення. Номер телефону для НП?"`,

  teplyi: `🤝 *Скрипт: Теплий дзвінок*

1️⃣ *Привітання*
"Добрий день, [ім'я]! Це [ваше ім'я] з Ikorka Shop. Ви у нас купували [вид ікри] — сподобалось?"

2️⃣ *Причина дзвінка*
"Телефоную, бо з'явились новинки — крем-сир Philadelphia і слабосолена риба! Плюс акція 4=6 з безкоштовною доставкою 🎉"

3️⃣ *Згадай попереднє замовлення*
"Минулого разу брали горбушу — хочете знову чи спробуємо щось нове? До ікри зараз дуже добре йде Philadelphia Balance!"

4️⃣ *Запропонуй вигоду*
"При замовленні від 4 банок ікри — доставка безкоштовна. А Philadelphia і рибу відправляємо тільки разом з ікрою!"

5️⃣ *Закрий*
"Оформлюємо? Доставка на завтра ще є — встигаємо!"`,

  philadelphia: `🧀 *Скрипт: Продаж Philadelphia*

⚠️ *ВАЖЛИВО: Philadelphia продається ТІЛЬКИ з ікрою або рибою!*

1️⃣ *Запропонуй після вибору ікри/риби*
"До вашого замовлення у нас є крем-сир Philadelphia — ідеально поєднується з ікрою!"

2️⃣ *Презентуй вибір*
"У нас 3 види:
• Balance 195г — 115 грн (класичний, менше жиру)
• З зеленню 195г — 115 грн (ароматний, ресторанний смак)
• З зеленою цибулею 175г — 125 грн (пікантний)"

3️⃣ *Поясни цінність*
"Ікра + Philadelphia на хрусткому хлібці — це ресторанний делікатес вдома за копійки!"

4️⃣ *Нагадай умову*
"Беремо? Нагадую — Philadelphia тільки разом з ікрою або рибою, окремо не відправляємо."`,

  ryba: `🐟 *Скрипт: Продаж риби*

1️⃣ *Запропонуй до ікри*
"До вашої ікри є чудове доповнення — слабосолена риба!"

2️⃣ *Презентуй*
"Маємо два формати:
• 300г — 369 грн (кожна 2-га по 339 грн!)
• 500г — 499 грн (кожна 2-га по 449 грн!)"

3️⃣ *Комбо-пропозиція*
"Риба + Philadelphia + ікра — повний делікатесний набір для сімейного сніданку або подарунку!"

4️⃣ *Закрий*
"Берете 2 упаковки риби — одразу отримуєте знижку на другу. Додаємо?"`,
};

function calcDiscount(price: number, pct: number): number {
  return Math.round(price * (1 - pct / 100));
}

// ─── MESSAGES ─────────────────────────────────────────────────────────────────
const MAIN_MENU_KEYBOARD = {
  reply_markup: {
    keyboard: [
      [{ text: "🧠 Квіз" }, { text: "🎭 Рольова гра" }],
      [{ text: "📅 Виклик дня" }, { text: "🏆 Лідерборд" }],
      [{ text: "🗓 Тижень" }, { text: "📊 Моя статистика" }],
      [{ text: "🧮 Калькулятор акцій" }, { text: "💰 Калькулятор цін" }],
      [{ text: "📜 Скрипти" }, { text: "ℹ️ Допомога" }],
    ],
    resize_keyboard: true,
    persistent: true,
  },
};

const NOTIFY_TIME_KEYBOARD = {
  reply_markup: {
    keyboard: [
      [{ text: "⏰ 7:00 Київ" }, { text: "⏰ 8:00 Київ" }, { text: "⏰ 9:00 Київ" }],
      [{ text: "⏰ 10:00 Київ" }, { text: "⏰ 11:00 Київ" }, { text: "⏰ 12:00 Київ" }],
      [{ text: "🏠 Головне меню" }],
    ],
    resize_keyboard: true,
    one_time_keyboard: true,
  },
};

const WELCOME_MESSAGE = `👋 Ласкаво просимо до *тренажера продажів Ikorka Shop*!

🧠 *Квіз* — перевірте знання видів ікри, цін та акцій.
🎭 *Рольові ігри* — попрактикуйтеся з реальними клієнтами.
📅 *Виклик дня* — одне питання для всієї команди щоранку.
📊 *Статистика* — відстежуйте свій прогрес.

Оберіть режим:`;

// ─── BOT ──────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

async function sendMain(chatId: number | string, text: string) {
  await bot.sendMessage(chatId, text, { parse_mode: "Markdown", ...MAIN_MENU_KEYBOARD });
}

const processingUsers = new Set<string>();

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from?.id ?? chatId);
  const text = msg.text?.trim() ?? "";
  if (!text) return;

  if (processingUsers.has(telegramId)) {
    return;
  }
  processingUsers.add(telegramId);

  try {
    // ─── ACCESS CONTROL CHECK ────────────────────────────────────────────────
    if (telegramId !== ADMIN_ID) {
      const accessStatus = await getAccessStatus(telegramId);

      if (accessStatus === null) {
        await upsertAccessRequest(telegramId, msg.from?.first_name ?? null, msg.from?.username ?? null);
        await bot.sendMessage(chatId,
          "🔒 *Доступ закрито*\n\nВаш запит на доступ відправлено адміністратору. Очікуйте підтвердження.",
          { parse_mode: "Markdown" }
        );
        const displayName = msg.from?.first_name ?? msg.from?.username ?? "Невідомий";
        const usernameStr = msg.from?.username ? `@${msg.from.username}` : "немає username";
        await bot.sendMessage(ADMIN_ID,
          `🔔 *Новий запит на доступ*\n\n👤 Ім'я: ${displayName}\n🔗 Username: ${usernameStr}\n🆔 ID: \`${telegramId}\``,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[
                { text: "✅ Схвалити", callback_data: `approve_${telegramId}` },
                { text: "❌ Відхилити", callback_data: `reject_${telegramId}` },
              ]],
            },
          }
        );
        return;
      }

      if (accessStatus === "pending") {
        await bot.sendMessage(chatId, "⏳ Ваш запит ще розглядається. Очікуйте відповіді адміністратора.");
        return;
      }

      if (accessStatus === "rejected") {
        await bot.sendMessage(chatId, "🚫 Ваш запит відхилено. Зверніться до адміністратора.");
        return;
      }
    }

    // Оновлюємо час активності
    await updateLastActive(telegramId);

    const user = await getOrCreateUser(telegramId, msg.from?.first_name, msg.from?.username);
    const session = await getActiveSession(telegramId);
    const state = session?.state ?? null;

    // START
    if (text === "/start" || text === "🏠 Головне меню") {
      await deleteSession(telegramId);
      await bot.sendPhoto(chatId, getWelcomePhoto() as any);
      await sendMain(chatId, WELCOME_MESSAGE);
      return;
    }

    // HELP
    if (text === "ℹ️ Допомога" || text === "/help") {
      await bot.sendMessage(chatId, `ℹ️ *Як користуватися ботом*\n\n🧠 *Квіз* — відповідайте А, Б, В або Г\n🎭 *Рольові ігри* — /feedback для порад, /end для завершення\n📅 *Виклик дня* — одна відповідь на день\n🔔 /notifications — сповіщення вкл/викл\n⏰ /settime — час сповіщень`, { parse_mode: "Markdown", ...MAIN_MENU_KEYBOARD });
      return;
    }

    // STATS
    if (text === "📊 Моя статистика" || text === "/stats") {
      if (telegramId === ADMIN_ID) {
        const allUsers = await pool.query(
          "SELECT * FROM users WHERE quiz_total > 0 ORDER BY quiz_score DESC, quiz_total DESC"
        );
        const rows = allUsers.rows;
        if (rows.length === 0) {
          await sendMain(chatId, "📊 Поки ніхто не проходив квіз.");
          return;
        }
        const totalUsers = rows.length;
        const avgPct = Math.round(rows.reduce((sum: number, u: any) => sum + (u.quiz_score / u.quiz_total) * 100, 0) / totalUsers);
        const totalQuestions = rows.reduce((sum: number, u: any) => sum + u.quiz_total, 0);
        const medals = ["🥇", "🥈", "🥉"];
        const userLines = rows.map((u: any, i: number) => {
          const pct = Math.round((u.quiz_score / u.quiz_total) * 100);
          const level = pct >= 80 ? "🏆" : pct >= 60 ? "📈" : pct >= 40 ? "📚" : "🌱";
          const name = u.first_name ?? u.username ?? `ID:${u.telegram_id}`;
          return `${medals[i] ?? `${i + 1}.`} ${level} *${name}* — ${u.quiz_score}/${u.quiz_total} (${pct}%) | 🎭 ${u.roleplay_count}`;
        });
        const summary = `📊 *Статистика команди*\n\n👥 Учасників: ${totalUsers}\n📝 Всього питань: ${totalQuestions}\n📈 Середній результат: ${avgPct}%\n\n${userLines.join("\n")}`;
        await bot.sendMessage(chatId, summary, { parse_mode: "Markdown", ...MAIN_MENU_KEYBOARD });
      } else {
        const pct = user.quiz_total > 0 ? Math.round((user.quiz_score / user.quiz_total) * 100) : 0;
        const level = pct >= 80 ? "🏆 Експерт" : pct >= 60 ? "📈 Середній" : pct >= 40 ? "📚 Навчається" : "🌱 Початківець";
        await bot.sendMessage(chatId, `📊 *Моя статистика: ${user.first_name ?? "Менеджер"}*\n\n🧠 Квіз: ${user.quiz_score}/${user.quiz_total} (${pct}%) — ${level}\n🎭 Рольових ігор: ${user.roleplay_count}`, { parse_mode: "Markdown", ...MAIN_MENU_KEYBOARD });
      }
      return;
    }

    // NOTIFICATIONS
    if (text === "/notifications") {
      const newState = await toggleNotifications(telegramId);
      const u = await getUser(telegramId);
      const kyivHour = ((u?.notify_hour_utc ?? 6) + 3) % 24;
      await bot.sendMessage(chatId, `${newState ? "🔔" : "🔕"} Сповіщення ${newState ? "увімкнені" : "вимкнені"}\nЧас: ${kyivHour}:00 Київ`, { parse_mode: "Markdown", ...MAIN_MENU_KEYBOARD });
      return;
    }

    if (text === "/settime") {
      await bot.sendMessage(chatId, "Оберіть час для сповіщень:", { ...NOTIFY_TIME_KEYBOARD });
      return;
    }

    const timeMatch = text.match(/^⏰ (\d+):00 Київ$/);
    if (timeMatch) {
      const kyivHour = parseInt(timeMatch[1], 10);
      const hourUtc = (kyivHour - 3 + 24) % 24;
      await setNotifyHour(telegramId, hourUtc);
      await sendMain(chatId, `✅ Час встановлено: ${kyivHour}:00 Київ`);
      return;
    }

    // LEADERBOARD
    if (text === "🏆 Лідерборд" || text === "/leaderboard") {
      const top = await getLeaderboard(10);
      if (top.length === 0) { await sendMain(chatId, "🏆 Таблиця лідерів порожня. Пройдіть квіз першим!"); return; }
      const medals = ["🥇", "🥈", "🥉"];
      const rows = top.map((e, i) => `${medals[i] ?? `${i + 1}.`} *${e.firstName ?? e.username ?? "Анонім"}* — ${e.quizScore}/${e.quizTotal} (${e.pct}%)`);
      await bot.sendMessage(chatId, `🏆 *Топ ${top.length}*\n\n${rows.join("\n")}`, { parse_mode: "Markdown", ...MAIN_MENU_KEYBOARD });
      return;
    }

    // WEEKLY
    if (text === "🗓 Тижень" || text === "/weekly") {
      const top = await getWeeklyLeaderboard(10);
      if (top.length === 0) { await sendMain(chatId, "🗓 Тижневий рейтинг порожній. Пройдіть квіз!"); return; }
      const medals = ["🥇", "🥈", "🥉"];
      const rows = top.map((e, i) => `${medals[i] ?? `${i + 1}.`} *${e.firstName ?? e.username ?? "Анонім"}* — ${e.score}/${e.total} (${e.pct}%)`);
      await bot.sendMessage(chatId, `🗓 *Рейтинг тижня*\n\n${rows.join("\n")}`, { parse_mode: "Markdown", ...MAIN_MENU_KEYBOARD });
      return;
    }

    // DAILY
    if (text === "📅 Виклик дня" || text === "/daily") {
      const date = getTodayDate();
      const existing = await getDailyResponse(telegramId, date);
      if (existing) {
        const stats = await getDailyStats(date);
        await bot.sendMessage(chatId, `${existing.correct ? "✅" : "❌"} Ви вже відповіли сьогодні — ${existing.correct ? "правильно" : "неправильно"}.\n\n📊 Команда: ${stats.totalAnswered} відповіли, ${stats.totalCorrect} правильно (${stats.correctPct}%)`, { parse_mode: "Markdown", ...MAIN_MENU_KEYBOARD });
        return;
      }
      const loadingMsg = await bot.sendMessage(chatId, "📅 Завантажую виклик дня...");
      const challenge = await getOrCreateDailyChallenge(() => generateQuizQuestion());
      await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
      const dateObj = new Date(challenge.date + "T00:00:00Z");
      const dateStr = dateObj.toLocaleDateString("uk-UA", { day: "numeric", month: "long", timeZone: "UTC" });
      const options = typeof challenge.options === "string" ? JSON.parse(challenge.options) : challenge.options;
      await upsertSession(telegramId, "daily", { challengeId: challenge.id, date: challenge.date });
      await bot.sendMessage(chatId, `📅 *Виклик дня — ${dateStr}*\n\n${challenge.question}\n\n${options.join("\n")}`, {
        parse_mode: "Markdown",
        reply_markup: { remove_keyboard: true },
      });
      return;
    }

    // QUIZ START
    if (text === "🧠 Квіз") {
      if (session?.mode === "quiz") {
        await bot.sendMessage(chatId, "У вас вже активний квіз. Відповідайте або напишіть /quit для виходу.");
      } else {
        const quizState = { questionNumber: 1, sessionScore: 0, sessionTotal: 0, currentQuestion: null, previousTopics: [], previousQuestions: [] };
        await upsertSession(telegramId, "quiz", quizState);
        await bot.sendMessage(chatId, "🤔 Генерую питання...", { parse_mode: "Markdown" });
        await sendNextQuizQuestion(chatId, telegramId, quizState);
      }
      return;
    }

    // QUIZ QUIT
    if (text === "🏁 Завершити квіз" || text === "/quit") {
      if (session?.mode === "quiz") {
        const s = state as any;
        const pct = s.sessionTotal > 0 ? Math.round((s.sessionScore / s.sessionTotal) * 100) : 0;
        await deleteSession(telegramId);
        await sendMain(chatId, `🏁 *Квіз завершено!*\n\nРезультат: ${s.sessionScore}/${s.sessionTotal} (${pct}%)`);
      } else {
        await sendMain(chatId, "Немає активного квізу.");
      }
      return;
    }

    // ROLEPLAY MENU
    if (text === "🎭 Рольова гра") {
      if (session?.mode === "roleplay") {
        await bot.sendMessage(chatId, "У вас вже активна рольова гра. Напишіть /end для завершення.");
      } else {
        const keyboard = SCENARIOS.map((s, i) => [{ text: `${i + 1}. ${s.title}` }]);
        keyboard.push([{ text: "🎲 Випадковий сценарій" }, { text: "🏠 Головне меню" }]);
        await bot.sendMessage(chatId, "🎭 *Оберіть сценарій*\n\nЯ гратиму клієнта — спробуйте досягти мети!", {
          parse_mode: "Markdown",
          reply_markup: { keyboard, resize_keyboard: true },
        });
      }
      return;
    }

    // ROLEPLAY END
    if (text === "/end") {
      if (session?.mode === "roleplay") {
        const s = state as any;
        if (!s.history || s.history.length < 2) {
          await deleteSession(telegramId);
          await sendMain(chatId, "❌ Діалог занадто короткий для аналізу. Спробуйте провести повноцінну розмову з клієнтом!");
          return;
        }
        await bot.sendMessage(chatId, "📝 Формую звіт тренера...", { parse_mode: "Markdown" });
        const scenario = SCENARIOS.find(sc => sc.title === s.scenario?.title) ?? SCENARIOS[0];
        const feedback = await getRoleplayFeedback(scenario, s.history ?? []);
        await incrementRoleplayCount(telegramId);
        await deleteSession(telegramId);
        await bot.sendMessage(chatId, `🎭 *Сесію завершено!*\n\n${feedback}`, { parse_mode: "Markdown" });
        await sendMain(chatId, "Чудове тренування!");
      } else {
        await sendMain(chatId, "Немає активної рольової гри.");
      }
      return;
    }

    // ROLEPLAY FEEDBACK
    if (text === "/feedback") {
      if (session?.mode === "roleplay") {
        const s = state as any;
        if (!s.history || s.history.length < 2) {
          await bot.sendMessage(chatId, "💬 Спочатку проведіть кілька обмінів репліками!");
          return;
        }
        await bot.sendMessage(chatId, "🔍 Аналізую...", { parse_mode: "Markdown" });
        const scenario = SCENARIOS.find(sc => sc.title === s.scenario?.title) ?? SCENARIOS[0];
        const feedback = await getRoleplayFeedback(scenario, s.history);
        await bot.sendMessage(chatId, feedback, { parse_mode: "Markdown" });
      } else {
        await bot.sendMessage(chatId, "Спочатку розпочніть рольову гру.");
      }
      return;
    }

    // DAILY ANSWER
    if (session?.mode === "daily") {
      const s = state as any;
      const answerMap: Record<string, number> = { "А": 0, "Б": 1, "В": 2, "Г": 3, "A": 0, "B": 1, "C": 2, "D": 3 };
      const answerIndex = answerMap[text.trim().toUpperCase().charAt(0)];
      if (answerIndex === undefined) { await bot.sendMessage(chatId, "Будь ласка, відповідайте А, Б, В або Г."); return; }
      const existing = await getDailyResponse(telegramId, s.date);
      if (existing) { await deleteSession(telegramId); await sendMain(chatId, "Ви вже відповіли сьогодні!"); return; }
      const challenge = await getDailyChallengeById(s.challengeId);
      if (!challenge) { await deleteSession(telegramId); await sendMain(chatId, "⚠️ Виклик не знайдено."); return; }
      const correct = answerIndex === challenge.correct_index;
      await saveDailyResponse(telegramId, user.first_name, user.username, s.date, correct);
      await deleteSession(telegramId);
      const stats = await getDailyStats(s.date);
      const topNames = stats.topCorrect.map((u: any) => u.firstName ?? u.username ?? "Анонім").join(", ");
      await bot.sendMessage(chatId,
        `${correct ? "✅" : "❌"} *${correct ? "Правильно!" : "Неправильно."}*\n\n💡 ${challenge.explanation}\n\n📊 Команда: ${stats.totalAnswered} відповіли, ${stats.totalCorrect} (${stats.correctPct}%) правильно${topNames ? `\n🌟 Правильно: ${topNames}` : ""}`,
        { parse_mode: "Markdown", ...MAIN_MENU_KEYBOARD }
      );
      return;
    }

    // QUIZ ANSWER
    if (session?.mode === "quiz") {
      const s = state as any;
      if (!s.currentQuestion) return;
      const answerMap: Record<string, number> = { "А": 0, "Б": 1, "В": 2, "Г": 3, "A": 0, "B": 1, "C": 2, "D": 3 };
      const answerIndex = answerMap[text.trim().toUpperCase().charAt(0)];
      if (answerIndex === undefined) { await bot.sendMessage(chatId, "Будь ласка, відповідайте А, Б, В або Г.", { parse_mode: "Markdown" }); return; }
      const correct = answerIndex === s.currentQuestion.correctIndex;
      if (correct) s.sessionScore++;
      s.sessionTotal++;
      await incrementQuizScore(telegramId, correct);
      const u = await getUser(telegramId);
      await upsertWeeklyScore(telegramId, u?.first_name, u?.username, correct);
      const pct = Math.round((s.sessionScore / s.sessionTotal) * 100);
      await bot.sendMessage(chatId, `${correct ? "✅" : "❌"} *${correct ? "Правильно!" : "Неправильно."}*\n\n💡 ${s.currentQuestion.explanation}\n\n📊 ${s.sessionScore}/${s.sessionTotal} (${pct}%)`, { parse_mode: "Markdown" });
      s.questionNumber++;
      s.previousTopics = [...(s.previousTopics ?? []), s.currentQuestion.topic];
      s.previousQuestions = [...(s.previousQuestions ?? []), s.currentQuestion.question];
      s.currentQuestion = null;

      if (s.sessionTotal >= 15) {
        const pct2 = Math.round((s.sessionScore / s.sessionTotal) * 100);
        const level = pct2 >= 80 ? "🏆 Експерт" : pct2 >= 60 ? "📈 Добре" : pct2 >= 40 ? "📚 Непогано" : "🌱 Продовжуйте вчитись";
        await deleteSession(telegramId);
        await sendMain(chatId, `🏁 *Квіз завершено!*\n\n📊 Результат: ${s.sessionScore}/15 (${pct2}%)\n${level}\n\nПродовжуйте практикуватися!`);
        return;
      }

      await new Promise(r => setTimeout(r, 1200));
      await bot.sendMessage(chatId, "🤔 Генерую наступне питання...", { parse_mode: "Markdown" });
      await sendNextQuizQuestion(chatId, telegramId, s);
      return;
    }

    // ROLEPLAY MESSAGE
    if (session?.mode === "roleplay") {
      const s = state as any;
      await bot.sendChatAction(chatId as number, "typing");
      const scenario = SCENARIOS.find(sc => sc.title === s.scenario?.title) ?? SCENARIOS[0];
      const response = await getRoleplayResponse(scenario, s.history ?? [], text);
      s.history = [...(s.history ?? []), { role: "user", content: text }, { role: "assistant", content: response }];
      s.exchangeCount = (s.exchangeCount ?? 0) + 1;
      await upsertSession(telegramId, "roleplay", s);
      await bot.sendMessage(chatId, `👤 *Клієнт:* ${response}`, { parse_mode: "Markdown" });
      if (s.exchangeCount === 8) {
        await bot.sendMessage(chatId, "💡 _8 обмінів. Напишіть /end для розбору або продовжуйте!_", { parse_mode: "Markdown" });
      }
      return;
    }

    // SCENARIO SELECT
    const scenarioMatch = SCENARIOS.findIndex(s => text.includes(s.title));
    if (scenarioMatch >= 0) {
      const scenario = SCENARIOS[scenarioMatch];
      await upsertSession(telegramId, "roleplay", { scenario, history: [], exchangeCount: 0 });
      await bot.sendMessage(chatId, `🎭 *${scenario.title}*\n\n📋 ${scenario.context}\n\n🎯 *Мета:* ${scenario.objective}\n\n---\nПривітайте клієнта!\n\n_/feedback — поради, /end — завершити_`, {
        parse_mode: "Markdown",
        reply_markup: { keyboard: [[{ text: "/feedback" }, { text: "/end" }]], resize_keyboard: true },
      });
      return;
    }

    if (text === "🎲 Випадковий сценарій") {
      const scenario = SCENARIOS[Math.floor(Math.random() * SCENARIOS.length)];
      await upsertSession(telegramId, "roleplay", { scenario, history: [], exchangeCount: 0 });
      await bot.sendMessage(chatId, `🎭 *${scenario.title}*\n\n📋 ${scenario.context}\n\n🎯 *Мета:* ${scenario.objective}\n\n---\nПривітайте клієнта!\n\n_/feedback — поради, /end — завершити_`, {
        parse_mode: "Markdown",
        reply_markup: { keyboard: [[{ text: "/feedback" }, { text: "/end" }]], resize_keyboard: true },
      });
      return;
    }

    const numberMatch = text.match(/^(\d+)\./);
    if (numberMatch) {
      const idx = parseInt(numberMatch[1], 10) - 1;
      if (idx >= 0 && idx < SCENARIOS.length) {
        const scenario = SCENARIOS[idx];
        await upsertSession(telegramId, "roleplay", { scenario, history: [], exchangeCount: 0 });
        await bot.sendMessage(chatId, `🎭 *${scenario.title}*\n\n📋 ${scenario.context}\n\n🎯 *Мета:* ${scenario.objective}\n\n---\nПривітайте клієнта!\n\n_/feedback — поради, /end — завершити_`, {
          parse_mode: "Markdown",
          reply_markup: { keyboard: [[{ text: "/feedback" }, { text: "/end" }]], resize_keyboard: true },
        });
        return;
      }
    }

    // SCRIPTS MENU
    if (text === "📜 Скрипти") {
      await bot.sendMessage(chatId, "📜 *Оберіть скрипт:*", {
        parse_mode: "Markdown",
        reply_markup: {
          keyboard: [
            [{ text: "💰 Скрипт: Дорого" }, { text: "📦 Скрипт: Закриття" }],
            [{ text: "🤝 Скрипт: Теплий дзвінок" }],
            [{ text: "🧀 Скрипт: Philadelphia" }, { text: "🐟 Скрипт: Риба" }],
            [{ text: "🧮 Калькулятор знижок" }, { text: "🏠 Головне меню" }],
          ],
          resize_keyboard: true,
        },
      });
      return;
    }

    if (text === "💰 Скрипт: Дорого") {
      await bot.sendMessage(chatId, SCRIPTS.doroho, { parse_mode: "Markdown", ...MAIN_MENU_KEYBOARD });
      return;
    }

    if (text === "📦 Скрипт: Закриття") {
      await bot.sendMessage(chatId, SCRIPTS.zakryttia, { parse_mode: "Markdown", ...MAIN_MENU_KEYBOARD });
      return;
    }

    if (text === "🤝 Скрипт: Теплий дзвінок") {
      await bot.sendMessage(chatId, SCRIPTS.teplyi, { parse_mode: "Markdown", ...MAIN_MENU_KEYBOARD });
      return;
    }

    if (text === "🧀 Скрипт: Philadelphia") {
      await bot.sendMessage(chatId, SCRIPTS.philadelphia, { parse_mode: "Markdown", ...MAIN_MENU_KEYBOARD });
      return;
    }

    if (text === "🐟 Скрипт: Риба") {
      await bot.sendMessage(chatId, SCRIPTS.ryba, { parse_mode: "Markdown", ...MAIN_MENU_KEYBOARD });
      return;
    }

    // PROMO CALCULATOR
    if (text === "🧮 Калькулятор акцій" || text === "🧮 Калькулятор знижок") {
      await bot.sendMessage(chatId,
        `🧮 *Калькулятор акцій*\n\nНадішліть список банок у форматі:\n*назва кількість*\n\nПриклад:\n\`горбуша 2\nкета 2\nщука преміум 2\`\n\nДоступні позиції: щука, щука преміум, горбуша, горбуша преміум, форель, лосось, кижуч, кета, кета преміум, веслонос, осетер, осетер преміум`,
        { parse_mode: "Markdown" }
      );
      await upsertSession(telegramId, "calc_promo", {});
      return;
    }

    if (text === "💰 Калькулятор цін") {
      await bot.sendMessage(chatId,
        `💰 *Калькулятор цін*\n\nНадішліть ціну і знижку у форматі:\n*ціна знижка*\n\nПриклад: \`459 10\` або \`539 7\``,
        { parse_mode: "Markdown" }
      );
      await upsertSession(telegramId, "calc", {});
      return;
    }

    if (session?.mode === "calc_promo") {
      const PRICES: Record<string, { price: number; label: string }> = {
        "щука": { price: 429, label: "Щука скло 500г" },
        "щука преміум": { price: 489, label: "Щука Преміум скло 500г" },
        "горбуша": { price: 449, label: "Горбуша скло 440г" },
        "горбуша преміум": { price: 569, label: "Горбуша Преміум скло 500г" },
        "форель": { price: 459, label: "Форель скло 440г" },
        "лосось": { price: 509, label: "Лосось скло 500г" },
        "кижуч": { price: 509, label: "Кижуч скло 500г" },
        "кета": { price: 539, label: "Кета скло 500г" },
        "кета преміум": { price: 609, label: "Кета Преміум скло 500г" },
        "веслонос": { price: 559, label: "Веслонос скло 500г" },
        "осетер": { price: 549, label: "Осетер скло 440г" },
        "осетер преміум": { price: 629, label: "Осетер Преміум скло 500г" },
        "чорна": { price: 629, label: "Осетер Преміум скло 500г" },
        "чорна осетрова": { price: 629, label: "Осетер Преміум скло 500г" },
      };

      const lines = text.trim().split("\n");
      const items: Array<{ label: string; price: number; qty: number }> = [];
      let parseError = false;

      for (const line of lines) {
        if (!line.trim()) continue;
        const match = line.trim().match(/^(.+?)\s+(\d+)$/);
        if (!match) { parseError = true; break; }
        const name = match[1].toLowerCase().trim();
        const qty = parseInt(match[2]);
        const found = PRICES[name];
        if (!found) { parseError = true; break; }
        items.push({ label: found.label, price: found.price, qty });
      }

      if (parseError || items.length === 0) {
        await bot.sendMessage(chatId,
          `⚠️ Не розпізнав. Надішліть у форматі:\n\`горбуша 2\nкета 1\nщука преміум 2\``,
          { parse_mode: "Markdown" }
        );
        return;
      }

      const allJars: Array<{ label: string; price: number }> = [];
      for (const item of items) {
        for (let i = 0; i < item.qty; i++) {
          allJars.push({ label: item.label, price: item.price });
        }
      }

      const sorted = [...allJars].sort((a, b) => a.price - b.price);
      const total = allJars.reduce((s, j) => s + j.price, 0);
      const count = allJars.length;

      // Акція 1+1=3: купуєш 2 — 3-тя безкоштовно (найдешевша)
      function calc113() {
        if (count < 3) return null;
        // Безкоштовна — найдешевша банка
        const freeJar = sorted[0];
        return { price: total - freeJar.price, saved: freeJar.price };
      }

      function calcPromo(freeCount: number) {
        if (count < freeCount + 1) return null;
        const free = sorted.slice(0, freeCount);
        const freeSum = free.reduce((s, j) => s + j.price, 0);
        return { price: total - freeSum, saved: freeSum };
      }

      let promoText = `📋 *Замовлення:*\n`;
      for (const item of items) {
        promoText += `• ${item.label} × ${item.qty} = ${item.price * item.qty} грн\n`;
      }
      promoText += `\n💰 *Повна ціна: ${total} грн* (${count} банок)\n\n`;
      promoText += `━━━━━━━━━━━━━━━\n`;
      promoText += `📊 *Розрахунок по акціях:*\n\n`;

      if (count >= 3) {
        const p = calc113();
        if (p) promoText += `🔹 *1+1=3* (3-тя безкоштовно)\n💳 ${p.price} грн | Економія: ${p.saved} грн\n\n`;
      }

      if (count >= 4) {
        const p = calcPromo(1);
        if (p) promoText += `🔹 *3=4* (4-та безкоштовна + безкоштовна доставка)\n💳 ${p.price} грн | Економія: ${p.saved} грн\n\n`;
      }

      if (count >= 5) {
        const p = calcPromo(2);
        if (p) promoText += `🔹 *3=5* (5-та і 6-та безкоштовні)\n💳 ${p.price} грн | Економія: ${p.saved} грн\n\n`;
      }

      if (count >= 6) {
        const p = calcPromo(2);
        if (p) promoText += `🔹 *4=6* (5-та і 6-та безкоштовні + безкоштовна доставка) ⭐\n💳 ${p.price} грн | Економія: ${p.saved} грн\n\n`;
      }

      promoText += `━━━━━━━━━━━━━━━\n`;
      promoText += `✅ *Безкоштовні банки* (найдешевші):\n`;
      promoText += sorted.slice(0, 2).map(j => `• ${j.label} — ${j.price} грн`).join("\n");

      await deleteSession(telegramId);
      await bot.sendMessage(chatId, promoText, { parse_mode: "Markdown", ...MAIN_MENU_KEYBOARD });
      return;
    }

    if (session?.mode === "calc") {
      const parts = text.trim().split(/\s+/);
      if (parts.length === 2) {
        const price = parseInt(parts[0]);
        const disc = parseInt(parts[1].replace("%", ""));
        if (!isNaN(price) && !isNaN(disc) && disc >= 0 && disc <= 50) {
          const discPrice = calcDiscount(price, disc);
          const saved = price - discPrice;
          await deleteSession(telegramId);
          await sendMain(chatId,
            `🧮 *Результат:*\n\nПовна ціна: *${price} грн*\nЗнижка: *${disc}%*\nЦіна зі знижкою: *${discPrice} грн*\nЕкономія: *${saved} грн*`
          );
          return;
        }
      }
      await bot.sendMessage(chatId, "⚠️ Введіть у форматі: *ціна знижка*\nНаприклад: `459 10`", { parse_mode: "Markdown" });
      return;
    }

    // AI ASSISTANT
    await bot.sendChatAction(chatId as number, "typing");
    const aiText = await groqQueue.add(() =>
      withRetry(() => geminiChat(
        `Ти — асистент менеджера магазину Ikorka Shop. Відповідай коротко і по суті ТІЛЬКИ українською мовою.\n\n${IKORKA_KNOWLEDGE}\n\nЯкщо питають про фото продуктів — давай посилання: https://t.me/+KPwmfo_kSy83Yjhi`,
        text,
        800
      ))
    );
    await bot.sendMessage(chatId, aiText ?? "Не зрозумів питання. Спробуйте ще раз.", { parse_mode: "Markdown" });

  } catch (err: any) {
    console.error("Bot error:", err);
    const isRateLimit = err?.status === 429 || err?.message?.includes("rate limit");
    const errMsg = isRateLimit
      ? "⏳ Забагато запитів. Зачекайте хвилину і спробуйте ще раз."
      : "⚠️ Щось пішло не так. Напишіть /start для скидання.";
    await bot.sendMessage(chatId, errMsg).catch(() => {});
  } finally {
    processingUsers.delete(telegramId);
  }
});

async function sendNextQuizQuestion(chatId: number | string, telegramId: string, state: any) {
  try {
    const question = await generateQuizQuestion(state.previousTopics ?? [], state.previousQuestions ?? []);
    state.currentQuestion = question;
    await upsertSession(telegramId, "quiz", state);
    const keyboard = question.options.map((_: any, i: number) => [{ text: String.fromCharCode(1040 + i) }]);
    keyboard.push([{ text: "🏁 Завершити квіз" }]);
    await bot.sendMessage(chatId, `*Питання ${state.questionNumber}*\n\n${question.question}\n\n${question.options.join("\n")}`, {
      parse_mode: "Markdown",
      reply_markup: { keyboard, resize_keyboard: true, one_time_keyboard: false },
    });
  } catch (err) {
    console.error("Quiz error:", err);
    await bot.sendMessage(chatId, "⚠️ Не вдалося створити питання. Спробуйте ще раз.", MAIN_MENU_KEYBOARD);
    await deleteSession(telegramId);
  }
}

// ─── SCHEDULER ────────────────────────────────────────────────────────────────

// Щогодинна перевірка — відправляє виклик дня
cron.schedule("0 * * * *", async () => {
  const hourUtc = new Date().getUTCHours();
  const users = await getUsersForNotification(hourUtc);
  if (users.length === 0) return;
  const date = getTodayDate();
  const challenge = await getOrCreateDailyChallenge(() => generateQuizQuestion());
  const options = typeof challenge.options === "string" ? JSON.parse(challenge.options) : challenge.options;
  const dateStr = new Date(date + "T00:00:00Z").toLocaleDateString("uk-UA", { day: "numeric", month: "long", timeZone: "UTC" });
  for (const user of users) {
    const existing = await getDailyResponse(user.telegram_id, date);
    if (existing) continue;
    await bot.sendMessage(user.telegram_id,
      `📅 *Виклик дня — ${dateStr}*\n\nДоброго ранку${user.first_name ? `, ${user.first_name}` : ""}!\n\n${challenge.question}\n\n${options.join("\n")}\n\n_Відповідайте А, Б, В або Г_`,
      { parse_mode: "Markdown" }
    ).catch(() => {});
    await upsertSession(user.telegram_id, "daily", { challengeId: challenge.id, date: challenge.date ?? date });
  }
});

// ─── НАГАДУВАННЯ ДЛЯ НЕАКТИВНИХ КОРИСТУВАЧІВ ─────────────────────────────────
// Перевірка о 10:00 UTC (13:00 Київ) щодня
cron.schedule("0 10 * * *", async () => {
  console.log("🔔 Checking inactive users...");
  try {
    const inactiveUsers = await getInactiveUsers(24);
    for (const user of inactiveUsers) {
      const firstName = user.first_name ? `, ${user.first_name}` : "";
      const hasNoRoleplay = user.roleplay_count === 0;
      const hasNoQuiz = user.quiz_total === 0;

      let message = "";

      if (hasNoRoleplay && hasNoQuiz) {
        // Ніколи не практикувався
        message = `👋 Привіт${firstName}!\n\nДавно не бачились! 😊\n\n🎭 *Рольова гра* — найефективніший спосіб підготуватись до реальних продажів. Зіграй з клієнтом прямо зараз!\n\n🧠 *Квіз* — перевір знання асортименту за 5 хвилин.\n\nЗаходь — є новинки в асортименті: *Щука Преміум, Philadelphia, слабосолена риба!* 🐟🧀`;
      } else if (hasNoRoleplay) {
        // Є квіз але немає рольової
        message = `🎭 Привіт${firstName}!\n\nТи вже знаєш теорію — тепер час практики!\n\n*Рольова гра* допомагає відпрацювати реальні ситуації з клієнтами: заперечення, вибір подарунка, корпоративні замовлення.\n\nСпробуй прямо зараз — це займе лише 5-10 хвилин! 💪`;
      } else if (user.roleplay_count < 3) {
        // Мало рольових ігор
        message = `💪 Привіт${firstName}!\n\nТи вже пройшов${user.roleplay_count === 1 ? "" : "ла"} ${user.roleplay_count} рольову гру — чудово!\n\nЩоб закріпити навички продажів, рекомендується проходити хоча б раз на день.\n\n🎭 Є новий сценарій: *"Продаж крем-сиру та риби"* — відпрацюй допродаж Philadelphia і слабосоленої риби!`;
      } else {
        // Регулярно практикується, але давно не заходив
        message = `📚 Привіт${firstName}!\n\nДавно тебе не було! В асортименті з'явились новинки:\n\n🆕 *Щука Преміум* скло 500г — 489 грн\n🧀 *Philadelphia* (Balance, з зеленню, з зеленою цибулею)\n🐟 *Слабосолена риба* 300г і 500г\n\nОнови знання в квізі або відпрацюй продаж новинок у рольовій грі! 🎯`;
      }

      if (message) {
        await bot.sendMessage(user.telegram_id, message, {
          parse_mode: "Markdown",
          ...MAIN_MENU_KEYBOARD
        }).catch(() => {});
        // Невелика затримка між повідомленнями
        await new Promise(r => setTimeout(r, 500));
      }
    }
    console.log(`✅ Sent reminders to ${inactiveUsers.length} inactive users`);
  } catch (err) {
    console.error("Reminder error:", err);
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
initDB().then(async () => {
  await bot.deleteWebHook();
  console.log("🤖 Bot started!");
}).catch(err => {
  console.error("Failed to init:", err);
  process.exit(1);
});

// ─── AUDIO ANALYSIS ───────────────────────────────────────────────────────────
const ANALYSIS_PROMPT = `Ти — експерт з аналізу дзвінків менеджерів з продажу ікри в магазині Ikorka Shop.\n\nПроаналізуй транскрипцію дзвінку і дай структурований розбір.\n\nЧЕК-ЛИСТ IKORKA SHOP:\n- Привітання та встановлення контакту\n- Виявлення потреби (відкриті питання)\n- Презентація продукту (вид ікри, упаковка, смак)\n- Озвучення акцій (1+1=3, 3=4, 4=6)\n- Допродаж Philadelphia або риби\n- Допродаж (Преміум версія, додаткові позиції)\n- Робота із запереченнями (ціна, якість)\n- Озвучення комісії НП (2%+20 грн)\n- Закриття на замовлення\n- Злив на перезвон (негативний фактор)\n\nВідповідай СТРОГО в такому форматі:\n\n✅ *Сильні сторони:*\n[перелік що зроблено добре]\n\n❌ *Помилки:*\n[перелік помилок]\n\n📊 *Оцінка:*\n• Контакт: X/10\n• Виявлення потреби: X/10\n• Презентація: X/10\n• Робота з запереченнями: X/10\n• Закриття: X/10\n• Допродаж: X/10\n\n🏆 *Загальна оцінка: X/10*\n\n💡 *Головна порада:*\n[одна конкретна порада для покращення]`;

async function analyzeCall(chatId: number | string, transcript: string) {
  const analysisText = await groqQueue.add(() =>
    withRetry(() => geminiChat(ANALYSIS_PROMPT, `Транскрипція дзвінку:\n\n${transcript}`, 1500))
  );
  await bot.sendMessage(chatId, `🎯 *Аналіз дзвінку:*\n\n${analysisText ?? "Не вдалося проаналізувати."}`, { parse_mode: "Markdown" });
}

async function transcribeAudio(fileId: string, mimeType: string): Promise<string> {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) throw new Error("GROQ_API_KEY не заданий — транскрипція недоступна");
  const fileInfo = await bot.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
  const audioResponse = await fetch(fileUrl);
  const audioBuffer = await audioResponse.arrayBuffer();
  const ext = mimeType.includes("ogg") ? "audio.ogg" : "audio.mp3";
  const audioBlob = new Blob([audioBuffer], { type: mimeType });
  const formData = new FormData();
  formData.append("file", audioBlob, ext);
  formData.append("model", "whisper-large-v3");
  formData.append("language", "uk");
  formData.append("response_format", "text");
  formData.append("prompt", "Магазин ікри Ikorka Shop. Горбуша, Лосось, Кета, Форель, Кижуч, Веслонос, Осетер, Щука, Щука Преміум, Philadelphia. Менеджер з продажу. Нова Пошта.");
  const transcribeRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${groqKey}` },
    body: formData,
  });
  return await transcribeRes.text();
}

bot.on("voice", async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from?.id ?? chatId);
  try {
    const session = await getActiveSession(telegramId);

    if (session?.mode === "roleplay") {
      await bot.sendChatAction(chatId, "typing");
      const transcript = await transcribeAudio(msg.voice!.file_id, "audio/ogg");
      if (!transcript || transcript.length < 3) {
        await bot.sendMessage(chatId, "⚠️ Не вдалося розпізнати. Спробуйте ще раз.");
        return;
      }
      await bot.sendMessage(chatId, `🎤 *Ви:* ${transcript}`, { parse_mode: "Markdown" });
      const s = session.state as any;
      const scenario = SCENARIOS.find(sc => sc.title === s.scenario?.title) ?? SCENARIOS[0];
      const response = await getRoleplayResponse(scenario, s.history ?? [], transcript);
      s.history = [...(s.history ?? []), { role: "user", content: transcript }, { role: "assistant", content: response }];
      s.exchangeCount = (s.exchangeCount ?? 0) + 1;
      await upsertSession(telegramId, "roleplay", s);
      await bot.sendMessage(chatId, `👤 *Клієнт:* ${response}`, { parse_mode: "Markdown" });
      if (s.exchangeCount === 8) {
        await bot.sendMessage(chatId, "💡 _8 обмінів. Напишіть /end для розбору або продовжуйте!_", { parse_mode: "Markdown" });
      }
      return;
    }

    await bot.sendMessage(chatId, "🎙️ Отримав голосове! Транскрибую...", { parse_mode: "Markdown" });
    const transcript = await transcribeAudio(msg.voice!.file_id, "audio/ogg");
    if (!transcript || transcript.length < 10) {
      await bot.sendMessage(chatId, "⚠️ Не вдалося розпізнати аудіо. Спробуйте ще раз.");
      return;
    }
    await bot.sendMessage(chatId, `📝 *Транскрипція:*\n\n${transcript}`, { parse_mode: "Markdown" });
    await bot.sendMessage(chatId, "🔍 Аналізую дзвінок...", { parse_mode: "Markdown" });
    await analyzeCall(chatId, transcript);
  } catch (err) {
    console.error("Voice analysis error:", err);
    await bot.sendMessage(chatId, "⚠️ Помилка аналізу. Спробуйте ще раз.");
  }
});

bot.on("audio", async (msg) => {
  const chatId = msg.chat.id;
  try {
    await bot.sendMessage(chatId, "🎙️ Отримав аудіофайл! Транскрибую...", { parse_mode: "Markdown" });
    const transcript = await transcribeAudio(msg.audio!.file_id, "audio/mpeg");
    if (!transcript || transcript.length < 10) {
      await bot.sendMessage(chatId, "⚠️ Не вдалося розпізнати аудіо. Спробуйте ще раз.");
      return;
    }
    await bot.sendMessage(chatId, `📝 *Транскрипція:*\n\n${transcript}`, { parse_mode: "Markdown" });
    await bot.sendMessage(chatId, "🔍 Аналізую дзвінок...", { parse_mode: "Markdown" });
    await analyzeCall(chatId, transcript);
  } catch (err) {
    console.error("Audio analysis error:", err);
    await bot.sendMessage(chatId, "⚠️ Помилка аналізу. Спробуйте ще раз.");
  }
});

bot.on("polling_error", (err) => console.error("Polling error:", err));

// ─── APPROVE / REJECT CALLBACKS ───────────────────────────────────────────────
bot.on("callback_query", async (query) => {
  const adminId = String(query.from.id);
  if (adminId !== ADMIN_ID) {
    await bot.answerCallbackQuery(query.id, { text: "⛔ Немає прав." });
    return;
  }

  const data = query.data ?? "";
  const approveMatch = data.match(/^approve_(.+)$/);
  const rejectMatch = data.match(/^reject_(.+)$/);

  if (approveMatch) {
    const targetId = approveMatch[1];
    await setAccessStatus(targetId, "approved");
    await bot.answerCallbackQuery(query.id, { text: "✅ Схвалено" });
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [[{ text: "✅ Схвалено", callback_data: "done" }]] },
      { chat_id: query.message?.chat.id, message_id: query.message?.message_id }
    ).catch(() => {});
    await bot.sendPhoto(targetId, getWelcomePhoto() as any).catch(() => {});
    await bot.sendMessage(targetId, WELCOME_MESSAGE, { parse_mode: "Markdown", ...MAIN_MENU_KEYBOARD }).catch(async () => {
      await bot.sendMessage(targetId, WELCOME_MESSAGE.replace(/\*/g, ""), MAIN_MENU_KEYBOARD).catch(() => {});
    });
  }

  if (rejectMatch) {
    const targetId = rejectMatch[1];
    await setAccessStatus(targetId, "rejected");
    await bot.answerCallbackQuery(query.id, { text: "❌ Відхилено" });
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [[{ text: "❌ Відхилено", callback_data: "done" }]] },
      { chat_id: query.message?.chat.id, message_id: query.message?.message_id }
    ).catch(() => {});
    await bot.sendMessage(targetId, "🚫 На жаль, ваш запит на доступ відхилено. Зверніться до адміністратора.").catch(() => {});
  }
});

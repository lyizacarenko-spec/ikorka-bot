import TelegramBot from "node-telegram-bot-api";
import pkg from "pg";
import Groq from "groq-sdk";
import * as cron from "node-cron";

const { Pool } = pkg;

// ─── ENV ─────────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const GROQ_API_KEY = process.env.GROQ_API_KEY!;
const DATABASE_URL = process.env.DATABASE_URL!;
const WELCOME_PHOTO = "https://i.postimg.cc/K8cGfryZ/2024-02-10-0342.jpg";

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
  `);
  console.log("✅ DB initialized");
}

async function getOrCreateUser(telegramId: string, firstName?: string, username?: string) {
  const res = await pool.query(
    `INSERT INTO users (telegram_id, first_name, username) VALUES ($1, $2, $3)
     ON CONFLICT (telegram_id) DO UPDATE SET first_name = COALESCE($2, users.first_name), username = COALESCE($3, users.username)
     RETURNING *`,
    [telegramId, firstName ?? null, username ?? null]
  );
  return res.rows[0];
}

async function getUser(telegramId: string) {
  const res = await pool.query("SELECT * FROM users WHERE telegram_id = $1", [telegramId]);
  return res.rows[0] ?? null;
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

// ─── GROQ ─────────────────────────────────────────────────────────────────────
const groq = new Groq({ apiKey: GROQ_API_KEY });

const IKORKA_KNOWLEDGE = `
Ти — експерт з продуктів магазину Ikorka Shop (магазин ікри). Всі відповіді тільки українською мовою.

АСОРТИМЕНТ ТА ЦІНИ (грн):
- Щука 500г скло: 429 грн, пластик: 379 грн
- Горбуша 440г скло: 449 грн, пластик: 399 грн
- Горбуша Преміум 500г скло: 569 грн, пластик: 549 грн
- Форель 440г скло: 459 грн, пластик: 409 грн
- Лосось 500г скло: 509 грн, пластик: 459 грн
- Кижуч 500г скло: 509 грн, пластик: 459 грн
- Кета 500г скло: 539 грн, пластик: 499 грн
- Кета Преміум 500г скло: 609 грн
- Веслонос 500г скло: 559 грн, пластик: 509 грн
- Осетер 440г скло: 549 грн, пластик: 529 грн
- Осетер Преміум 500г скло: 629 грн, пластик: 589 грн

АКЦІЇ:
- 1+1=3: купуєш 2 банки — 3-тя безкоштовно
- 3=4 + безкоштовна доставка
- 4=6 + безкоштовна доставка
- 3=5: повна ціна, доставка за рахунок клієнта
- ХХЛ 1.5кг: 1299 грн (1=2)

ЗБЕРІГАННЯ: закрита — 3 місяці при 0-5°C; після відкриття — 14 діб у холодильнику.
`;

const IKORKA_TOPICS = [
  "види ікри в асортименті Ikorka Shop",
  "ціни на ікру Ikorka Shop",
  "акція 1+1=3",
  "акція 3=5",
  "скляна упаковка ікри",
  "пластикова упаковка ікри",
  "розмір зерна різних видів ікри",
  "смакові характеристики ікри",
  "умови зберігання ікри",
  "робота із запереченнями при продажу ікри",
  "як запропонувати ікру як подарунок",
];

async function generateQuizQuestion(previousTopics: string[] = []) {
  const available = IKORKA_TOPICS.filter(t => !previousTopics.includes(t));
  const topic = available.length > 0
    ? available[Math.floor(Math.random() * available.length)]
    : IKORKA_TOPICS[Math.floor(Math.random() * IKORKA_TOPICS.length)];

  const response = await groq.chat.completions.create({
    model: "llama3-70b-8192",,
    max_tokens: 1024,
    messages: [
      {
        role: "system",
        content: `${IKORKA_KNOWLEDGE}

Створи питання для тесту менеджера з продажу на тему: "${topic}".

СУВОРІ ПРАВИЛА ФОРМАТУ:
1. Поверни ТІЛЬКИ валідний JSON, без markdown-блоків
2. Формат варіантів відповідей: ["А) текст", "Б) текст", "В) текст", "Г) текст"]
3. ЗАБОРОНЕНО виділяти правильну відповідь — всі 4 варіанти однаково
4. correctIndex — індекс правильної відповіді (0–3)
5. Весь текст тільки українською мовою

JSON:
{
  "question": "текст питання",
  "options": ["А) варіант1", "Б) варіант2", "В) варіант3", "Г) варіант4"],
  "correctIndex": 0,
  "explanation": "коротке пояснення",
  "topic": "${topic}"
}`,
      },
      { role: "user", content: "Створи питання для квізу." },
    ],
  });

  const content = response.choices[0]?.message?.content ?? "{}";
  const cleaned = content.replace(/```json\n?|\n?```/g, "").trim();
  const parsed = JSON.parse(cleaned);
  parsed.options = parsed.options.map((opt: string) =>
    opt.replace(/\*\*/g, "").replace(/\*/g, "").replace(/__/g, "").replace(/_/g, "")
  );
  return parsed;
}

// ─── ROLEPLAY ─────────────────────────────────────────────────────────────────
const SCENARIOS = [
  {
    title: "Вибір подарунка",
    context: "Клієнт хоче купити ікру в подарунок на день народження.",
    customerPersona: `Ти — Наталія, 38 років. Хочеш купити ікру в подарунок, бюджет 1000–1500 грн. Не розбираєшся у видах. Говори тільки українською.\n${IKORKA_KNOWLEDGE}`,
    objective: "Допомогти обрати ікру в подарунок і запропонувати скляну упаковку",
  },
  {
    title: "Заперечення по ціні",
    context: "Клієнт вважає ікру дорогою і порівнює з супермаркетом.",
    customerPersona: `Ти — Сергій, 45 років. Купуєш ікру в АТБ, вважаєш 449 грн забагато. Скептичний. Говори тільки українською.\n${IKORKA_KNOWLEDGE}`,
    objective: "Обґрунтувати різницю у якості та запропонувати акцію",
  },
  {
    title: "Корпоративне замовлення",
    context: "Представник компанії хоче закупити ікру для 20 співробітників.",
    customerPersona: `Ти — Андрій, офіс-менеджер. Потрібно 20 подарунків, бюджет до 15 000 грн. Торгуєшся. Говори тільки українською.\n${IKORKA_KNOWLEDGE}`,
    objective: "Закрити на акцію та оформити велике замовлення",
  },
  {
    title: "Новачок, вперше купує ікру",
    context: "Молодий клієнт ніколи не купував ікру в спеціалізованому магазині.",
    customerPersona: `Ти — Кирило, 24 роки. Ніколи не їв ікру, все незнайоме. Ставиш наївні питання. Говори тільки українською.\n${IKORKA_KNOWLEDGE}`,
    objective: "Навчити клієнта та продати ікру як оптимальний старт",
  },
  {
    title: "Клієнт іде до конкурента",
    context: "Постійний клієнт знайшов дешевше в іншому місці.",
    customerPersona: `Ти — Олена, 50 років. Знайшла дешевше на маркетплейсі. Ввічлива але тверда. Говори тільки українською.\n${IKORKA_KNOWLEDGE}`,
    objective: "Утримати клієнта та запропонувати акцію",
  },
];

async function getRoleplayResponse(scenario: any, history: any[], userMessage: string) {
  const messages = [
    {
      role: "system" as const,
      content: `${scenario.customerPersona}\n\nТи граєш роль клієнта. Відповідай коротко (2-3 речення). Мета менеджера: ${scenario.objective}`,
    },
    ...history.map((m: any) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: userMessage },
  ];
  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    max_tokens: 512,
    messages,
  });
  return response.choices[0]?.message?.content ?? "Зрозуміло. Розкажіть детальніше.";
}

async function getRoleplayFeedback(scenario: any, history: any[]) {
  const transcript = history.map((m: any) => `${m.role === "user" ? "Менеджер" : "Клієнт"}: ${m.content}`).join("\n");
  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    max_tokens: 1024,
    messages: [
      {
        role: "system",
        content: `Ти — тренер з продажів Ikorka Shop. Проаналізуй діалог. Сценарій: ${scenario.title}. Мета: ${scenario.objective}.\n${IKORKA_KNOWLEDGE}\n\nФормат:\n**Загальна оцінка**: [Відмінно/Добре/Потребує покращення]\n**Що вийшло добре**: [2-3 моменти]\n**Над чим попрацювати**: [2-3 рекомендації]\n**Ключовий прийом**: [одна порада]`,
      },
      { role: "user", content: `Транскрипт:\n\n${transcript}\n\nДай зворотний зв'язок.` },
    ],
  });
  return response.choices[0]?.message?.content ?? "Гарна спроба! Продовжуйте практикуватися.";
}

// ─── MESSAGES ─────────────────────────────────────────────────────────────────
const MAIN_MENU_KEYBOARD = {
  reply_markup: {
    keyboard: [
      [{ text: "🧠 Квіз" }, { text: "🎭 Рольова гра" }],
      [{ text: "📅 Виклик дня" }, { text: "🏆 Лідерборд" }],
      [{ text: "🗓 Тижень" }, { text: "📊 Моя статистика" }],
      [{ text: "ℹ️ Допомога" }],
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
"Зараз є акція 4=6 з безкоштовною доставкою — фактично 2 банки у подарунок. Давайте порахуємо?"

5️⃣ *Закрий*
"Оформлюємо на завтра чи на п'ятницю?"`,

  zakryttia: `📦 *Скрипт: Закриття на замовлення*

1️⃣ *Підсумуй вибір*
"Отже, ви обрали [вид ікри], [упаковка], [кількість]. Правильно?"

2️⃣ *Запропонуй доп. продаж*
"До цього замовлення чудово підійде [вид] — інший смак, цікаво порівняти. Додаємо?"

3️⃣ *Уточни доставку*
"Доставка Новою Поштою. Пам'ятайте — при накладеному платежі комісія НП: 2% + 20 грн."

4️⃣ *Закрий питанням*
"Оплата карткою чи накладеним? Доставка на завтра чи на після завтра?"

5️⃣ *Підтвердження*
"Чудово! Записую замовлення. Номер телефону для НП?"`,

  teplyi: `🤝 *Скрипт: Теплий дзвінок*

1️⃣ *Привітання*
"Добрий день, [ім'я]! Це [ваше ім'я] з Ikorka Shop. Ви у нас купували [вид ікри] — сподобалось?"

2️⃣ *Приводь причину дзвінка*
"Телефоную, бо у нас з'явилась нова партія свіжої ікри + зараз діє акція 4=6 з безкоштовною доставкою — подумав(ла) про вас одразу!"

3️⃣ *Згадай попереднє замовлення*
"Минулого разу брали горбушу — хочете знову чи спробуємо щось нове? Зараз дуже добра Кета Преміум — крупніше зерно, насиченіший смак."

4️⃣ *Запропонуй вигоду*
"При замовленні від 4 банок — доставка безкоштовна. Виходить дуже вигідно!"

5️⃣ *Закрий*
"Оформлюємо? Доставка на завтра ще є — встигаємо!"`,
};

function calcDiscount(price: number, pct: number): number {
  return Math.round(price * (1 - pct / 100));
}
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

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from?.id ?? chatId);
  const text = msg.text?.trim() ?? "";
  if (!text) return;

  try {
    const user = await getOrCreateUser(telegramId, msg.from?.first_name, msg.from?.username);
    const session = await getActiveSession(telegramId);
    const state = session?.state ?? null;

    // START
    if (text === "/start" || text === "🏠 Головне меню") {
      await deleteSession(telegramId);
      await bot.sendPhoto(chatId, WELCOME_PHOTO);
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
      const pct = user.quiz_total > 0 ? Math.round((user.quiz_score / user.quiz_total) * 100) : 0;
      const level = pct >= 80 ? "🏆 Експерт" : pct >= 60 ? "📈 Середній" : pct >= 40 ? "📚 Навчається" : "🌱 Початківець";
      await bot.sendMessage(chatId, `📊 *Статистика: ${user.first_name ?? "Менеджер"}*\n\n🧠 Квіз: ${user.quiz_score}/${user.quiz_total} (${pct}%) — ${level}\n🎭 Рольових ігор: ${user.roleplay_count}`, { parse_mode: "Markdown", ...MAIN_MENU_KEYBOARD });
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
        const quizState = { questionNumber: 1, sessionScore: 0, sessionTotal: 0, currentQuestion: null, previousTopics: [] };
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
        await bot.sendMessage(chatId, "📝 Формую звіт тренера...", { parse_mode: "Markdown" });
        const s = state as any;
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

    await sendMain(chatId, "👋 Оберіть режим для початку:");
  } catch (err) {
    console.error("Bot error:", err);
    await bot.sendMessage(chatId, "⚠️ Щось пішло не так. Напишіть /start для скидання.");
  }
});

async function sendNextQuizQuestion(chatId: number | string, telegramId: string, state: any) {
  try {
    const question = await generateQuizQuestion(state.previousTopics ?? []);
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
// ─── SCHEDULER ────────────────────────────────────────────────────────────────
const ADMIN_TELEGRAM_ID = "620838766";

// Щогодинне нагадування про виклик дня
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

// Щотижневий звіт керівнику — п'ятниця о 17:00 Київ (14:00 UTC)
cron.schedule("0 14 * * 5", async () => {
  try {
    const top = await getWeeklyLeaderboard(10);
    const allRes = await pool.query("SELECT COUNT(*) as cnt FROM weekly_scores WHERE week_start = $1", [getCurrentWeekStart()]);
    const totalParticipants = parseInt(allRes.rows[0]?.cnt ?? "0");
    const totalQuestionsRes = await pool.query(
      "SELECT COALESCE(SUM(total), 0) as total_q, COALESCE(SUM(score), 0) as total_correct FROM weekly_scores WHERE week_start = $1",
      [getCurrentWeekStart()]
    );
    const totalQuestions = parseInt(totalQuestionsRes.rows[0]?.total_q ?? "0");
    const totalCorrect = parseInt(totalQuestionsRes.rows[0]?.total_correct ?? "0");
    const avgPct = totalQuestions > 0 ? Math.round((totalCorrect / totalQuestions) * 100) : 0;
    const medals = ["🥇", "🥈", "🥉"];
    const topRows = top.length > 0
      ? top.map((e, i) => `${medals[i] ?? `${i + 1}.`} *${e.firstName ?? e.username ?? "Анонім"}* — ${e.score}/${e.total} (${e.pct}%)`).join("\n")
      : "_Ніхто не проходив квіз цього тижня_";
    const weekStart = getCurrentWeekStart();
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(new Date(weekStart).getUTCDate() + 4);
    const weekStr = `${new Date(weekStart).toLocaleDateString("uk-UA", { day: "numeric", month: "long", timeZone: "UTC" })} — ${weekEnd.toLocaleDateString("uk-UA", { day: "numeric", month: "long", timeZone: "UTC" })}`;
    const report = `📊 *Щотижневий звіт Ikorka Shop*\n📅 ${weekStr}\n\n👥 Учасників: *${totalParticipants}*\n📝 Питань пройдено: *${totalQuestions}*\n✅ Середній результат: *${avgPct}%*\n\n🏆 *Топ менеджерів тижня:*\n${topRows}\n\n_Звіт сформовано автоматично_`;
    await bot.sendMessage(ADMIN_TELEGRAM_ID, report, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("Weekly report error:", err);
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
initDB().then(() => {
  console.log("🤖 Bot started!");
}).catch(err => {
  console.error("Failed to init:", err);
  process.exit(1);
});

bot.on("polling_error", (err) => console.error("Polling error:", err));

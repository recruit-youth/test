const express = require("express");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
const { google } = require("googleapis");
const nodemailer = require("nodemailer");
const { v4: uuidv4 } = require("uuid");
require("dotenv").config();

dayjs.extend(utc);
dayjs.extend(timezone);

const JST = "Asia/Tokyo";
const SLOT_MINUTES = 60;
const MONTHLY_LIMIT = 14;
const SLOT_HOURS = [10, 11, 13, 14, 15, 16, 17, 18];
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/spreadsheets",
];

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

const dbDir = path.join(__dirname, "..", "data");
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(path.join(dbDir, "app.db"));
db.pragma("journal_mode = WAL");

initializeDatabase();

const QUESTIONS = [
  {
    key: "jobType",
    label: "希望職種",
    options: ["営業", "エンジニア", "マーケティング", "事務", "接客・販売", "未定"],
  },
  {
    key: "workStyle",
    label: "希望の働き方",
    options: ["フルリモート", "ハイブリッド", "出社メイン", "こだわりなし"],
  },
  {
    key: "priority",
    label: "転職で重視するポイント",
    options: ["年収アップ", "ワークライフバランス", "成長環境", "安定性", "福利厚生"],
  },
  {
    key: "timing",
    label: "転職希望時期",
    options: ["すぐに", "1~3ヶ月以内", "半年以内", "情報収集段階"],
  },
  {
    key: "location",
    label: "希望勤務地",
    options: ["東京", "関東圏", "大阪", "名古屋", "福岡", "全国可"],
  },
];

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, now: new Date().toISOString() });
});

app.get("/api/questions", (_req, res) => {
  res.json({ questions: QUESTIONS });
});

app.get("/api/public-config", (_req, res) => {
  res.json({
    lineRegistrationUrl:
      process.env.LINE_REGISTRATION_URL || "https://line.me/R/ti/p/@example",
    monthlyLimit: MONTHLY_LIMIT,
  });
});

app.post("/api/recommendations", (req, res) => {
  try {
    const { profile, answers } = req.body || {};
    validateProfile(profile);
    validateAnswers(answers);

    const seekerId = uuidv4();
    const createdAt = nowIso();
    db.prepare(
      `
      INSERT INTO seekers (id, name, email, phone, answers_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `
    ).run(
      seekerId,
      profile.name.trim(),
      profile.email.trim().toLowerCase(),
      profile.phone.trim(),
      JSON.stringify(answers),
      createdAt
    );

    const targetMonth = dayjs().tz(JST).format("YYYY-MM");
    const allCompanies = db
      .prepare(
        `
      SELECT c.*, COALESCE(mc.booked_count, 0) as booked_count
      FROM companies c
      LEFT JOIN monthly_capacity mc
        ON mc.company_id = c.id AND mc.year_month = ?
      WHERE c.active = 1
      `
      )
      .all(targetMonth);

    const scored = allCompanies
      .filter((company) => company.booked_count < MONTHLY_LIMIT)
      .map((company) => {
        const score = scoreCompany(company, answers);
        return {
          ...company,
          score,
          remainingSlots: MONTHLY_LIMIT - company.booked_count,
        };
      })
      .sort((a, b) => b.score - a.score || b.remainingSlots - a.remainingSlots);

    const selected = scored.slice(0, 3);
    const insertRecStmt = db.prepare(
      `INSERT INTO recommendations (seeker_id, company_id, score, created_at) VALUES (?, ?, ?, ?)`
    );
    const insertMany = db.transaction((items) => {
      for (const item of items) {
        insertRecStmt.run(seekerId, item.id, item.score, createdAt);
      }
    });
    insertMany(selected);

    res.json({
      seekerId,
      targetMonth,
      recommendations: selected.map((company) => ({
        id: company.id,
        name: company.name,
        industry: company.industry,
        description: company.description,
        strengths: parseJson(company.strengths_json, []),
        repName: company.rep_name,
        score: company.score,
        remainingSlots: company.remainingSlots,
      })),
    });
  } catch (error) {
    res.status(400).json({ error: error.message || "推薦の取得に失敗しました。" });
  }
});

app.get("/api/companies/:companyId/slots", async (req, res) => {
  try {
    const { companyId } = req.params;
    const startDate = req.query.startDate || dayjs().tz(JST).format("YYYY-MM-DD");
    const days = clampInt(req.query.days, 14, 30);
    const company = db.prepare(`SELECT * FROM companies WHERE id = ? AND active = 1`).get(companyId);
    if (!company) {
      return res.status(404).json({ error: "会社が見つかりません。" });
    }

    const slots = await getAvailableSlots(company, startDate, days);
    res.json({ companyId, startDate, days, slots });
  } catch (error) {
    res.status(400).json({ error: error.message || "空き枠取得に失敗しました。" });
  }
});

app.post("/api/bookings", async (req, res) => {
  try {
    const { seekerId, companyId, slotStart } = req.body || {};
    if (!seekerId || !companyId || !slotStart) {
      throw new Error("seekerId/companyId/slotStart を指定してください。");
    }

    const seeker = db.prepare(`SELECT * FROM seekers WHERE id = ?`).get(seekerId);
    if (!seeker) {
      throw new Error("求職者データが見つかりません。");
    }
    const company = db.prepare(`SELECT * FROM companies WHERE id = ? AND active = 1`).get(companyId);
    if (!company) {
      throw new Error("会社データが見つかりません。");
    }

    const start = dayjs(slotStart).tz(JST);
    if (!start.isValid()) {
      throw new Error("予約日時の形式が不正です。");
    }
    if (start.isBefore(dayjs().tz(JST).add(1, "hour"))) {
      throw new Error("予約は1時間後以降を指定してください。");
    }
    const end = start.add(SLOT_MINUTES, "minute");
    const yearMonth = start.format("YYYY-MM");

    const googleSlotFree = await isSlotFreeInGoogle(company.calendar_id, start, end);
    if (!googleSlotFree) {
      throw new Error("その枠は埋まっています。別の時間を選択してください。");
    }

    const bookingId = uuidv4();
    const createdAt = nowIso();
    const answersSnapshot = seeker.answers_json;

    const createBooking = db.transaction(() => {
      const existingCapacity = db
        .prepare(`SELECT booked_count FROM monthly_capacity WHERE company_id = ? AND year_month = ?`)
        .get(company.id, yearMonth);
      const bookedCount = existingCapacity?.booked_count || 0;
      if (bookedCount >= MONTHLY_LIMIT) {
        throw new Error("この会社は今月の面談上限に達しています。");
      }

      const overlapCount = db
        .prepare(
          `
          SELECT COUNT(1) as count
          FROM bookings
          WHERE company_id = ?
            AND status = 'confirmed'
            AND start_at < ?
            AND end_at > ?
        `
        )
        .get(company.id, end.toISOString(), start.toISOString()).count;
      if (overlapCount > 0) {
        throw new Error("その枠は他の予約と重複しています。");
      }

      db.prepare(
        `
        INSERT INTO bookings
          (id, seeker_id, company_id, start_at, end_at, status, created_at, answers_snapshot_json)
        VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?)
      `
      ).run(
        bookingId,
        seeker.id,
        company.id,
        start.toISOString(),
        end.toISOString(),
        createdAt,
        answersSnapshot
      );

      db.prepare(
        `
        INSERT INTO monthly_capacity (company_id, year_month, booked_count, updated_at)
        VALUES (?, ?, 1, ?)
        ON CONFLICT(company_id, year_month)
        DO UPDATE SET
          booked_count = booked_count + 1,
          updated_at = excluded.updated_at
      `
      ).run(company.id, yearMonth, createdAt);
    });

    createBooking();

    const booking = db
      .prepare(
        `
      SELECT b.*, c.name as company_name, c.rep_name, c.rep_email, c.calendar_id, c.sheet_id,
             s.name as seeker_name, s.email as seeker_email, s.phone as seeker_phone, s.answers_json
      FROM bookings b
      JOIN companies c ON c.id = b.company_id
      JOIN seekers s ON s.id = b.seeker_id
      WHERE b.id = ?
    `
      )
      .get(bookingId);

    let calendarEventId = null;
    try {
      calendarEventId = await createCalendarEvent(booking);
      if (calendarEventId) {
        db.prepare(`UPDATE bookings SET calendar_event_id = ? WHERE id = ?`).run(calendarEventId, booking.id);
      }
    } catch (error) {
      console.error("calendar sync error", error.message);
    }

    try {
      await appendBookingsToSheets(booking);
    } catch (error) {
      console.error("sheet sync error", error.message);
    }

    try {
      await sendBookingNotification(booking);
    } catch (error) {
      console.error("mail send error", error.message);
    }

    res.json({
      bookingId: booking.id,
      seekerId: booking.seeker_id,
      companyId: booking.company_id,
      companyName: booking.company_name,
      startAt: booking.start_at,
      endAt: booking.end_at,
      calendarEventId,
      redirectTo: `/bookings.html?seekerId=${booking.seeker_id}`,
    });
  } catch (error) {
    res.status(400).json({ error: error.message || "予約処理に失敗しました。" });
  }
});

app.get("/api/bookings/seeker/:seekerId", (req, res) => {
  try {
    const seeker = db.prepare(`SELECT * FROM seekers WHERE id = ?`).get(req.params.seekerId);
    if (!seeker) {
      return res.status(404).json({ error: "求職者が見つかりません。" });
    }
    const bookings = db
      .prepare(
        `
      SELECT b.*, c.name as company_name, c.rep_name, c.rep_email
      FROM bookings b
      JOIN companies c ON c.id = b.company_id
      WHERE b.seeker_id = ?
      ORDER BY b.start_at DESC
    `
      )
      .all(seeker.id);
    res.json({
      seeker: {
        id: seeker.id,
        name: seeker.name,
        email: seeker.email,
        phone: seeker.phone,
        answers: parseJson(seeker.answers_json, {}),
      },
      bookings,
    });
  } catch (error) {
    res.status(400).json({ error: error.message || "予約一覧取得に失敗しました。" });
  }
});

app.get("/api/bookings/company/:companyId", (req, res) => {
  try {
    const company = db.prepare(`SELECT * FROM companies WHERE id = ?`).get(req.params.companyId);
    if (!company) {
      return res.status(404).json({ error: "会社が見つかりません。" });
    }
    const bookings = db
      .prepare(
        `
      SELECT b.*, s.name as seeker_name, s.email as seeker_email, s.phone as seeker_phone
      FROM bookings b
      JOIN seekers s ON s.id = b.seeker_id
      WHERE b.company_id = ?
      ORDER BY b.start_at DESC
    `
      )
      .all(company.id);
    res.json({ company: { id: company.id, name: company.name }, bookings });
  } catch (error) {
    res.status(400).json({ error: error.message || "会社予約一覧の取得に失敗しました。" });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

function initializeDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      industry TEXT NOT NULL,
      description TEXT NOT NULL,
      strengths_json TEXT NOT NULL,
      rep_name TEXT NOT NULL,
      rep_email TEXT NOT NULL,
      calendar_id TEXT,
      sheet_id TEXT,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS seekers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      answers_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recommendations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seeker_id TEXT NOT NULL,
      company_id TEXT NOT NULL,
      score INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS monthly_capacity (
      company_id TEXT NOT NULL,
      year_month TEXT NOT NULL,
      booked_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (company_id, year_month)
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      seeker_id TEXT NOT NULL,
      company_id TEXT NOT NULL,
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      answers_snapshot_json TEXT NOT NULL,
      calendar_event_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_bookings_company_time ON bookings (company_id, start_at, end_at);
    CREATE INDEX IF NOT EXISTS idx_bookings_seeker ON bookings (seeker_id);
  `);

  const existing = db.prepare(`SELECT COUNT(1) as count FROM companies`).get().count;
  if (existing > 0) return;

  const seedCompanies = [
    {
      id: "comp-axis",
      name: "Axis Career Partners",
      industry: "総合人材",
      description: "未経験からハイクラスまで、幅広い職種に強い総合型エージェント。",
      strengths: ["営業", "事務", "未定", "関東圏", "安定性", "年収アップ"],
      repName: "山田 直人",
      repEmail: "axis@example.com",
    },
    {
      id: "comp-tech",
      name: "Tech Bridge Agent",
      industry: "IT特化",
      description: "エンジニア・プロダクト職の転職支援に特化。リモート案件が豊富。",
      strengths: ["エンジニア", "フルリモート", "ハイブリッド", "成長環境", "全国可"],
      repName: "鈴木 悠斗",
      repEmail: "tech@example.com",
    },
    {
      id: "comp-sales",
      name: "Sales Next",
      industry: "営業職特化",
      description: "法人営業・インサイドセールス案件に特化し、年収アップ提案が得意。",
      strengths: ["営業", "年収アップ", "東京", "関東圏", "すぐに"],
      repName: "小林 葵",
      repEmail: "sales@example.com",
    },
    {
      id: "comp-marketing",
      name: "Growth Mark Careers",
      industry: "マーケティング特化",
      description: "デジタルマーケ職を中心に、成長企業とのマッチングを支援。",
      strengths: ["マーケティング", "成長環境", "ハイブリッド", "東京", "大阪"],
      repName: "高橋 美咲",
      repEmail: "marketing@example.com",
    },
    {
      id: "comp-balance",
      name: "LifeShift Recruit",
      industry: "ワークライフ重視",
      description: "残業少なめ・福利厚生重視の求人を中心に取り扱い。",
      strengths: ["ワークライフバランス", "福利厚生", "安定性", "出社メイン", "名古屋", "福岡"],
      repName: "中村 海",
      repEmail: "lifeshift@example.com",
    },
    {
      id: "comp-service",
      name: "Hospitality Works",
      industry: "接客・販売特化",
      description: "店舗運営・接客経験を活かせる求人紹介に強み。",
      strengths: ["接客・販売", "事務", "大阪", "福岡", "1~3ヶ月以内"],
      repName: "伊藤 さくら",
      repEmail: "service@example.com",
    },
  ];

  const insert = db.prepare(`
    INSERT INTO companies
      (id, name, industry, description, strengths_json, rep_name, rep_email, calendar_id, sheet_id, active)
    VALUES
      (@id, @name, @industry, @description, @strengths_json, @rep_name, @rep_email, @calendar_id, @sheet_id, 1)
  `);
  const insertTx = db.transaction((items) => {
    for (const item of items) insert.run(item);
  });

  insertTx(
    seedCompanies.map((company) => ({
      id: company.id,
      name: company.name,
      industry: company.industry,
      description: company.description,
      strengths_json: JSON.stringify(company.strengths),
      rep_name: company.repName,
      rep_email: company.repEmail,
      calendar_id: process.env[`${company.id.toUpperCase()}_CALENDAR_ID`] || "",
      sheet_id: process.env[`${company.id.toUpperCase()}_SHEET_ID`] || "",
    }))
  );
}

function scoreCompany(company, answers) {
  const strengths = parseJson(company.strengths_json, []);
  const values = Object.values(answers || {});
  let score = 0;
  for (const value of values) {
    if (!value) continue;
    if (strengths.includes(value)) score += 18;
  }
  if (answers.timing === "すぐに") score += 4;
  if (answers.workStyle === "フルリモート" && strengths.includes("フルリモート")) score += 6;
  return score;
}

async function getAvailableSlots(company, startDate, days) {
  const start = dayjs.tz(startDate, JST).startOf("day");
  if (!start.isValid()) throw new Error("startDate の形式が不正です。");
  const end = start.add(days, "day").endOf("day");

  const localBusy = db
    .prepare(
      `
      SELECT start_at, end_at
      FROM bookings
      WHERE company_id = ?
        AND status = 'confirmed'
        AND start_at >= ?
        AND start_at <= ?
    `
    )
    .all(company.id, start.toISOString(), end.toISOString())
    .map((row) => ({
      start: dayjs(row.start_at),
      end: dayjs(row.end_at),
    }));

  const googleBusy = await fetchGoogleBusyRanges(company.calendar_id, start, end);
  const busyRanges = localBusy.concat(googleBusy);

  const byDay = [];
  for (let i = 0; i < days; i += 1) {
    const day = start.add(i, "day");
    if (day.day() === 0 || day.day() === 6) continue;

    const yearMonth = day.format("YYYY-MM");
    const bookedCount =
      db
        .prepare(`SELECT booked_count FROM monthly_capacity WHERE company_id = ? AND year_month = ?`)
        .get(company.id, yearMonth)?.booked_count || 0;
    if (bookedCount >= MONTHLY_LIMIT) continue;

    const slots = [];
    for (const hour of SLOT_HOURS) {
      const slotStart = day.hour(hour).minute(0).second(0).millisecond(0);
      const slotEnd = slotStart.add(SLOT_MINUTES, "minute");
      if (slotStart.isBefore(dayjs().tz(JST).add(1, "hour"))) continue;
      if (!isOverlapping(slotStart, slotEnd, busyRanges)) {
        slots.push({
          startAt: slotStart.toISOString(),
          endAt: slotEnd.toISOString(),
          label: slotStart.format("MM/DD(ddd) HH:mm"),
        });
      }
    }
    if (slots.length) {
      byDay.push({ date: day.format("YYYY-MM-DD"), slots });
    }
  }
  return byDay;
}

function isOverlapping(start, end, ranges) {
  return ranges.some((range) => start.isBefore(range.end) && end.isAfter(range.start));
}

function validateProfile(profile) {
  if (!profile || typeof profile !== "object") {
    throw new Error("求職者情報を入力してください。");
  }
  const required = ["name", "email", "phone"];
  for (const key of required) {
    if (!profile[key] || !String(profile[key]).trim()) {
      throw new Error(`プロフィール項目 ${key} は必須です。`);
    }
  }
}

function validateAnswers(answers) {
  if (!answers || typeof answers !== "object") {
    throw new Error("回答が不足しています。");
  }
  for (const q of QUESTIONS) {
    if (!answers[q.key]) {
      throw new Error(`${q.label} を選択してください。`);
    }
  }
}

function clampInt(value, defaultValue, maxValue) {
  const parsed = Number.parseInt(String(value ?? defaultValue), 10);
  if (Number.isNaN(parsed) || parsed <= 0) return defaultValue;
  return Math.min(parsed, maxValue);
}

function parseJson(input, fallback) {
  try {
    return JSON.parse(input);
  } catch (_error) {
    return fallback;
  }
}

function nowIso() {
  return dayjs().tz(JST).toISOString();
}

async function fetchGoogleBusyRanges(calendarId, start, end) {
  if (!calendarId) return [];
  const auth = getGoogleAuth();
  if (!auth) return [];
  try {
    const calendar = google.calendar({ version: "v3", auth });
    const response = await calendar.freebusy.query({
      requestBody: {
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        timeZone: JST,
        items: [{ id: calendarId }],
      },
    });
    const busy = response.data.calendars?.[calendarId]?.busy || [];
    return busy.map((item) => ({ start: dayjs(item.start), end: dayjs(item.end) }));
  } catch (error) {
    console.error("google freebusy error", error.message);
    return [];
  }
}

async function isSlotFreeInGoogle(calendarId, start, end) {
  if (!calendarId) return true;
  const auth = getGoogleAuth();
  if (!auth) return true;
  try {
    const calendar = google.calendar({ version: "v3", auth });
    const response = await calendar.freebusy.query({
      requestBody: {
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        timeZone: JST,
        items: [{ id: calendarId }],
      },
    });
    const busy = response.data.calendars?.[calendarId]?.busy || [];
    return busy.length === 0;
  } catch (error) {
    console.error("google slot check error", error.message);
    return true;
  }
}

async function createCalendarEvent(booking) {
  if (!booking.calendar_id) return null;
  const auth = getGoogleAuth();
  if (!auth) return null;
  const calendar = google.calendar({ version: "v3", auth });
  const start = dayjs(booking.start_at).tz(JST);
  const end = dayjs(booking.end_at).tz(JST);
  const answers = parseJson(booking.answers_json, {});
  const response = await calendar.events.insert({
    calendarId: booking.calendar_id,
    requestBody: {
      summary: `面談予約: ${booking.seeker_name} 様`,
      description: [
        `求職者名: ${booking.seeker_name}`,
        `メール: ${booking.seeker_email}`,
        `電話: ${booking.seeker_phone}`,
        "",
        "回答内容:",
        Object.entries(answers)
          .map(([k, v]) => `- ${k}: ${v}`)
          .join("\n"),
      ].join("\n"),
      start: { dateTime: start.toISOString(), timeZone: JST },
      end: { dateTime: end.toISOString(), timeZone: JST },
      attendees: [{ email: booking.rep_email }, { email: booking.seeker_email }],
    },
  });
  return response.data.id || null;
}

async function appendBookingsToSheets(booking) {
  const auth = getGoogleAuth();
  if (!auth) return;
  const sheets = google.sheets({ version: "v4", auth });
  const answers = parseJson(booking.answers_json, {});
  const values = [
    [
      dayjs(booking.created_at).tz(JST).format("YYYY-MM-DD HH:mm"),
      booking.id,
      booking.company_name,
      booking.seeker_name,
      booking.seeker_email,
      booking.seeker_phone,
      dayjs(booking.start_at).tz(JST).format("YYYY-MM-DD HH:mm"),
      dayjs(booking.end_at).tz(JST).format("YYYY-MM-DD HH:mm"),
      JSON.stringify(answers),
    ],
  ];

  const commonSheetId = process.env.GLOBAL_BOOKING_SHEET_ID;
  if (commonSheetId) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: commonSheetId,
      range: "A:I",
      valueInputOption: "USER_ENTERED",
      requestBody: { values },
    });
  }

  if (booking.sheet_id) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: booking.sheet_id,
      range: "A:I",
      valueInputOption: "USER_ENTERED",
      requestBody: { values },
    });
  }
}

async function sendBookingNotification(booking) {
  const host = process.env.SMTP_HOST;
  const portNum = Number.parseInt(process.env.SMTP_PORT || "587", 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.MAIL_FROM || "no-reply@example.com";
  if (!host || !user || !pass) {
    console.log(
      `[mail skipped] company=${booking.company_name}, to=${booking.rep_email}, seeker=${booking.seeker_email}`
    );
    return;
  }

  const transporter = nodemailer.createTransport({
    host,
    port: portNum,
    secure: portNum === 465,
    auth: { user, pass },
  });

  await transporter.sendMail({
    from,
    to: booking.rep_email,
    cc: booking.seeker_email,
    subject: `【面談予約】${booking.seeker_name} 様 / ${booking.company_name}`,
    text: [
      `${booking.company_name} ご担当者様`,
      "",
      "以下の面談予約が入りました。",
      `求職者名: ${booking.seeker_name}`,
      `メール: ${booking.seeker_email}`,
      `電話: ${booking.seeker_phone}`,
      `予約時間: ${dayjs(booking.start_at).tz(JST).format("YYYY-MM-DD HH:mm")} - ${dayjs(
        booking.end_at
      )
        .tz(JST)
        .format("HH:mm")}`,
      "",
      "本メールは自動送信です。",
    ].join("\n"),
  });
}

function getGoogleAuth() {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const jsonPath = process.env.GOOGLE_SERVICE_ACCOUNT_PATH;
  try {
    if (json) {
      const creds = JSON.parse(json);
      return new google.auth.GoogleAuth({ credentials: creds, scopes: GOOGLE_SCOPES });
    }
    if (jsonPath && fs.existsSync(jsonPath)) {
      return new google.auth.GoogleAuth({ keyFile: jsonPath, scopes: GOOGLE_SCOPES });
    }
  } catch (error) {
    console.error("google auth setup error", error.message);
  }
  return null;
}

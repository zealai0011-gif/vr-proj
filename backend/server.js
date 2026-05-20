"use strict";

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 8080);
const API_KEY = process.env.API_KEY || "";
const DATABASE_URL = process.env.DATABASE_URL || "";

if (!DATABASE_URL) {
  console.error("DATABASE_URL is required. Copy backend/.env.example to backend/.env");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 8,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 20000,
});

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.use((req, res, next) => {
  if (!API_KEY) {
    return next();
  }

  const key = req.get("X-API-Key") || "";
  if (key !== API_KEY) {
    return res.status(401).json({ ok: false, error: "Invalid API key." });
  }

  next();
});

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1 AS ok");
    res.json({ ok: true, database: true });
  } catch (error) {
    res.status(503).json({ ok: false, database: false, error: error.message });
  }
});

app.post("/auth/sign-in", async (req, res) => {
  const userId = String(req.body?.user_id || "").trim();
  if (!userId) {
    return res.status(400).json({ ok: false, error: "user_id is required." });
  }

  try {
    const result = await pool.query(
      "SELECT user_id FROM users WHERE user_id = $1 AND is_active = TRUE LIMIT 1;",
      [userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "User ID not found or inactive." });
    }

    res.json({ ok: true, user_id: result.rows[0].user_id });
  } catch (error) {
    console.error("[sign-in]", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/auth/sign-up", async (req, res) => {
  const fullName = String(req.body?.full_name || "").trim();
  const introText = String(req.body?.intro_text || "").trim();
  const age = Number(req.body?.age);

  if (!fullName) {
    return res.status(400).json({ ok: false, error: "full_name is required." });
  }

  if (!Number.isInteger(age) || age < 5 || age > 120) {
    return res.status(400).json({ ok: false, error: "age must be between 5 and 120." });
  }

  if (!introText) {
    return res.status(400).json({ ok: false, error: "intro_text is required." });
  }

  try {
    const result = await pool.query(
      "INSERT INTO users (full_name, age, intro_text) VALUES ($1, $2, $3) RETURNING user_id;",
      [fullName, age, introText]
    );

    const userId = result.rows[0]?.user_id;
    if (!userId) {
      return res.status(500).json({ ok: false, error: "Sign-up succeeded but no user_id returned." });
    }

    res.status(201).json({ ok: true, user_id: userId });
  } catch (error) {
    console.error("[sign-up]", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/auth/last-login", async (req, res) => {
  const userId = String(req.body?.user_id || "").trim();
  if (!userId) {
    return res.status(400).json({ ok: false, error: "user_id is required." });
  }

  try {
    await pool.query(
      "UPDATE users SET last_login_at = NOW() WHERE user_id = $1;",
      [userId]
    );
    res.json({ ok: true });
  } catch (error) {
    console.error("[last-login]", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/users/:userId/context", async (req, res) => {
  const userId = String(req.params.userId || "").trim();
  const historyLimit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 100);

  if (!userId) {
    return res.status(400).json({ ok: false, error: "user_id is required." });
  }

  const sql = `
    SELECT json_build_object(
      'user_id', u.user_id,
      'full_name', u.full_name,
      'age', u.age,
      'intro_text', u.intro_text,
      'history', COALESCE(
        (
          SELECT json_agg(
            json_build_object(
              'timestamp', h.turn_timestamp_iso,
              'summary', h.summary
            )
            ORDER BY h.turn_timestamp_iso DESC
          )
          FROM (
            SELECT turn_timestamp_iso, summary
            FROM conversation_history
            WHERE user_id = u.user_id
            ORDER BY turn_timestamp_iso DESC
            LIMIT $2
          ) h
        ),
        '[]'::json
      )
    ) AS context
    FROM users u
    WHERE u.user_id = $1
    LIMIT 1;`;

  try {
    const result = await pool.query(sql, [userId, historyLimit]);
    if (result.rowCount === 0 || !result.rows[0]?.context) {
      return res.status(404).json({ ok: false, error: "No context data found for user." });
    }

    res.json({ ok: true, context: result.rows[0].context });
  } catch (error) {
    console.error("[context]", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/conversation-history", async (req, res) => {
  const userId = String(req.body?.user_id || "").trim();
  const conversationId = String(req.body?.conversation_id || "").trim();
  const turnTimestampIso = String(req.body?.turn_timestamp_iso || "").trim();
  const summary = String(req.body?.summary || "");
  const rawTranscriptJson = req.body?.raw_transcript_json;

  if (!userId || !conversationId || !turnTimestampIso) {
    return res.status(400).json({
      ok: false,
      error: "user_id, conversation_id, and turn_timestamp_iso are required.",
    });
  }

  const transcriptJson =
    typeof rawTranscriptJson === "string"
      ? rawTranscriptJson
      : JSON.stringify(rawTranscriptJson ?? {});

  try {
    const update = await pool.query(
      `UPDATE conversation_history
       SET turn_timestamp_iso = $3, summary = $4, raw_transcript_json = $5::jsonb
       WHERE user_id = $1 AND conversation_id = $2;`,
      [userId, conversationId, turnTimestampIso, summary, transcriptJson]
    );

    if (update.rowCount > 0) {
      return res.json({ ok: true, updated: true });
    }

    await pool.query(
      `INSERT INTO conversation_history
         (user_id, conversation_id, turn_timestamp_iso, summary, raw_transcript_json)
       VALUES ($1, $2, $3, $4, $5::jsonb);`,
      [userId, conversationId, turnTimestampIso, summary, transcriptJson]
    );

    res.status(201).json({ ok: true, updated: false });
  } catch (error) {
    console.error("[conversation-history]", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log("Auth API listening on port " + PORT);
});

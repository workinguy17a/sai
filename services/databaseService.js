import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

pool.on("error", error => {
  console.error("Unexpected PostgreSQL pool error:", error.message);
});

export async function getOrCreateConversation(storeId, visitorId) {
  const result = await pool.query(
    `INSERT INTO conversations (store_id, visitor_id)
     VALUES ($1, $2)
     ON CONFLICT (store_id, visitor_id)
     DO UPDATE SET updated_at = NOW()
     RETURNING id`,
    [storeId, visitorId]
  );

  return result.rows[0].id;
}

export async function saveMessage(conversationId, role, content) {
  await pool.query(
    `INSERT INTO messages (conversation_id, role, content)
     VALUES ($1, $2, $3::jsonb)`,
    [conversationId, role, JSON.stringify(content)]
  );
}

export async function getStoreByWidgetKey(widgetKey, origin) {
  if (
    typeof widgetKey !== "string" ||
    !widgetKey.trim() ||
    typeof origin !== "string"
  ) {
    return null;
  }

  let requestOrigin;

  try {
    requestOrigin = new URL(origin).origin;
  } catch {
    return null;
  }

  const result = await pool.query(
    `SELECT id, name, website_url, platform, currency_code, allowed_origins, account_status
     FROM stores
     WHERE public_widget_key = $1 AND account_status = 'active'`,
    [widgetKey]
  );

  const store = result.rows[0];

  if (!store || !store.allowed_origins.includes(requestOrigin)) {
    return null;
  }

  return store;
}

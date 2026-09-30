import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { pool } from "../services/databaseService.js";

const [nameArg, websiteUrlArg, currencyArg, emailArg] =
  process.argv.slice(2);

const name = String(nameArg || "").trim();
const email = String(emailArg || "").trim().toLowerCase();
const currencyCode = String(currencyArg || "").trim().toUpperCase();
const password = process.env.DASHBOARD_ACCOUNT_PASSWORD;

let website;
try {
  website = new URL(websiteUrlArg);
} catch {
  console.error("Provide a valid store website URL.");
  process.exit(1);
}

if (
  !name ||
  !email ||
  !/^[A-Z]{3}$/.test(currencyCode) ||
  !["http:", "https:"].includes(website.protocol) ||
  !password ||
  password.length < 12
) {
  console.error(
    "Required: store name, website URL, three-letter currency, owner email, and a dashboard password of at least 12 characters."
  );
  process.exit(1);
}

const websiteUrl = website.toString().replace(/\/+$/, "");
const allowedOrigins = [website.origin];

if (
  process.env.NODE_ENV !== "production" &&
  !allowedOrigins.includes("http://localhost:3000")
) {
  allowedOrigins.push("http://localhost:3000");
}

const passwordHash = await bcrypt.hash(password, 12);
const widgetKey = randomUUID();
const client = await pool.connect();

try {
  await client.query("BEGIN");

  const storeResult = await client.query(
    `INSERT INTO stores
       (name, website_url, platform, currency_code, created_at,
        public_widget_key, allowed_origins)
     VALUES ($1, $2, 'woocommerce', $3, NOW(), $4, $5)
     RETURNING id`,
    [name, websiteUrl, currencyCode, widgetKey, allowedOrigins]
  );

  const storeId = storeResult.rows[0].id;

  await client.query(
    `INSERT INTO store_users
       (store_id, email, password_hash, role, is_active, created_at)
     VALUES ($1, $2, $3, 'owner', TRUE, NOW())`,
    [storeId, email, passwordHash]
  );

  await client.query("COMMIT");

  console.log(`Created test store ${storeId} and owner account ${email}.`);
  console.log("The owner can now sign in and configure WooCommerce in the dashboard.");
} catch (error) {
  await client.query("ROLLBACK");
  console.error("Could not create the test store:", error.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
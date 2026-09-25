import "dotenv/config";
import { pool } from "../services/databaseService.js";
import { encryptCredentials } from "../services/credentialCryptoService.js";

const storeId = Number(process.env.STORE_ID);
const consumerKey = process.env.WC_KEY;
const consumerSecret = process.env.WC_SECRET;

if (!Number.isSafeInteger(storeId)) {
  throw new Error("STORE_ID is missing or invalid.");
}

if (!consumerKey || !consumerSecret) {
  throw new Error("WC_KEY or WC_SECRET is missing from .env.");
}

try {
  const encryptedCredentials = encryptCredentials({
    consumerKey,
    consumerSecret
  });

  await pool.query(
    `INSERT INTO store_integrations
       (store_id, platform, credentials_encrypted)
     VALUES ($1, 'woocommerce', $2::jsonb)
     ON CONFLICT (store_id)
     DO UPDATE SET
       platform = EXCLUDED.platform,
       credentials_encrypted = EXCLUDED.credentials_encrypted,
       updated_at = NOW()`,
    [storeId, JSON.stringify(encryptedCredentials)]
  );

  console.log("WooCommerce credentials encrypted and saved.");
} catch (error) {
  console.error("Credential migration failed:", error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
import bcrypt from "bcryptjs";
import { pool } from "../services/databaseService.js";

const [storeIdArg, emailArg] = process.argv.slice(2);
const storeId = Number(storeIdArg);
const email = String(emailArg || "").trim().toLowerCase();
const password = process.env.DASHBOARD_ACCOUNT_PASSWORD;

try {
  if (!Number.isInteger(storeId) || storeId <= 0 || !email || !password) {
    throw new Error(
      "Usage: set DASHBOARD_ACCOUNT_PASSWORD, then run with store ID and email."
    );
  }

  const passwordHash = await bcrypt.hash(password, 12);

  await pool.query(
    `INSERT INTO store_users (store_id, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, 'owner', TRUE)`,
    [storeId, email, passwordHash]
  );

  console.log(`Dashboard owner created for store ${storeId}: ${email}`);
} catch (error) {
  console.error("Could not create dashboard owner:", error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
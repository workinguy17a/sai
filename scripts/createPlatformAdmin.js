import bcrypt from "bcryptjs";
import { pool } from "../services/databaseService.js";

const email = String(process.argv[2] || "").trim().toLowerCase();
const password = process.env.PLATFORM_ADMIN_PASSWORD || "";

try {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Pass a valid admin email as the first argument.");
  }
  if (password.length < 12) {
    throw new Error("Set PLATFORM_ADMIN_PASSWORD to a password of at least 12 characters.");
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const existing = await pool.query(
    "SELECT id FROM platform_admins WHERE LOWER(email) = LOWER($1) LIMIT 1",
    [email]
  );

  if (existing.rowCount) {
    await pool.query(
      "UPDATE platform_admins SET password_hash = $1, is_active = TRUE WHERE id = $2",
      [passwordHash, existing.rows[0].id]
    );
    console.log(`Platform admin password updated for ${email}.`);
  } else {
    await pool.query(
      "INSERT INTO platform_admins (email, password_hash, is_active) VALUES ($1, $2, TRUE)",
      [email, passwordHash]
    );
    console.log(`Platform admin created for ${email}.`);
  }
} catch (error) {
  console.error("Could not create platform admin:", error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}

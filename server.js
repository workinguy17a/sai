import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import path from "node:path";
import express from "express";
import OpenAI from "openai";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { mkdir, unlink } from "node:fs/promises";
import { encryptCredentials } from "./services/credentialCryptoService.js";
import { sendConversationTranscript } from "./services/emailService.js";

import {
  searchProducts,
  searchCategories,
  getProductsByCategory,
  findOrderByNumberAndEmail,
  searchSaleProducts,
  getStoreCurrency
} from "./services/woocommerceService.js";

import {
  pool,
  getOrCreateConversation,
  saveMessage,getStoreByWidgetKey
} from "./services/databaseService.js";

import { searchKnowledge } from "./services/knowledgeService.js";
import { createRetrievalPlan } from "./services/orchestratorService.js";

dotenv.config();

console.log(
  "WC KEY LOADED:",
  !!process.env.WC_KEY
);

console.log(
  "WC SECRET LOADED:",
  !!process.env.WC_SECRET
);

const execFileAsync = promisify(execFile);
const rebuildingStores = new Set();

const app = express();

app.get("/dashboard-ui", (req, res) => {
  res.sendFile(path.resolve("dashboard.html"));
});

app.get("/admin-ui", (req, res) => {
  res.sendFile(path.resolve("admin.html"));
});

app.get("/signup", (req, res) => {
  res.sendFile(path.resolve("signup.html"));
});

app.use(express.json());

const PgSession = connectPgSimple(session);

const knowledgeUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, callback) {
      const storeId = Number(req.dashboardStoreId);

      if (!Number.isSafeInteger(storeId) || storeId <= 0) {
        return callback(new Error("Invalid store session."));
      }

      const directory = path.resolve(
        "knowledge",
        "stores",
        String(storeId),
        "documents"
      );

      mkdir(directory, { recursive: true })
        .then(() => callback(null, directory))
        .catch(callback);
    },

    filename(req, file, callback) {
      const extension = path.extname(file.originalname).toLowerCase();
      callback(null, `${randomUUID()}${extension}`);
    },
  }),

  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1,
    fields: 2,
    parts: 3,
  },

  fileFilter(req, file, callback) {
    const extension = path.extname(file.originalname).toLowerCase();

    if (![".pdf", ".txt"].includes(extension)) {
      return callback(new Error("Only PDF and TXT files are allowed."));
    }

    callback(null, true);
  },
});

function parseKnowledgeUpload(req, res, next) {
  knowledgeUpload.single("file")(req, res, error => {
    if (error) {
      const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      return res.status(status).json({
        success: false,
        message: error.message || "File upload failed.",
      });
    }

    next();
  });
}


app.use(
  "/dashboard",
  session({
    store: new PgSession({
      pool,
      tableName: "dashboard_sessions",
      createTableIfMissing: false,
    }),
    name: "sai_dashboard",
    secret: process.env.DASHBOARD_SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 8, // 8 hours
    },
  })
);

app.post("/signup", async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const rawWebsiteUrl = String(req.body?.website_url || "").trim();
  const currencyCode = String(req.body?.currency_code || "").trim().toUpperCase();
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");

  let website;
  try {
    website = new URL(rawWebsiteUrl);
  } catch {
    return res.status(400).json({ success: false, message: "Enter a valid store website URL." });
  }

  if (!name || name.length > 120) {
    return res.status(400).json({ success: false, message: "Store name is required and must be 120 characters or fewer." });
  }
  if (!["http:", "https:"].includes(website.protocol)) {
    return res.status(400).json({ success: false, message: "Store website must use HTTP or HTTPS." });
  }
  if (!/^[A-Z]{3}$/.test(currencyCode)) {
    return res.status(400).json({ success: false, message: "Currency must be a three-letter code such as GBP or USD." });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, message: "Enter a valid email address." });
  }
  if (password.length < 12) {
    return res.status(400).json({ success: false, message: "Password must be at least 12 characters." });
  }

  const existingOwner = await pool.query(
    "SELECT 1 FROM store_users WHERE LOWER(email) = LOWER($1) LIMIT 1",
    [email]
  );
  if (existingOwner.rowCount) {
    return res.status(409).json({ success: false, message: "An account already exists for this email. Sign in or contact the platform administrator." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const passwordHash = await bcrypt.hash(password, 12);
    const websiteUrl = website.toString().replace(/\/+$/, "");
    const allowedOrigins = [website.origin];
    if (process.env.NODE_ENV !== "production") allowedOrigins.push("http://localhost:3000");

    const storeResult = await client.query(
      `INSERT INTO stores
         (name, website_url, platform, currency_code, created_at,
          public_widget_key, allowed_origins, account_status)
       VALUES ($1, $2, 'woocommerce', $3, NOW(), $4, $5, 'pending_approval')
       RETURNING id`,
      [name, websiteUrl, currencyCode, randomUUID(), [...new Set(allowedOrigins)]]
    );
    const storeId = storeResult.rows[0].id;

    await client.query(
      `INSERT INTO store_users (store_id, email, password_hash, role, is_active, created_at)
       VALUES ($1, $2, $3, 'owner', TRUE, NOW())`,
      [storeId, email, passwordHash]
    );
    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      message: "Your store account request was submitted. You can sign in after it is approved.",
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Store self-signup error:", error.message);
    res.status(error.code === "23505" ? 409 : 500).json({
      success: false,
      message: error.code === "23505"
        ? "An account already exists for this email. Contact the platform administrator."
        : "Could not submit the store account request.",
    });
  } finally {
    client.release();
  }
});



app.post("/dashboard/login", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim();
    const password = String(req.body?.password || "");

    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Email and password are required." });
    }

    const result = await pool.query(
      `SELECT su.id, su.store_id, su.email, su.password_hash, su.role,
              s.account_status
       FROM store_users su
       JOIN stores s ON s.id = su.store_id
       WHERE LOWER(su.email) = LOWER($1) AND su.is_active = TRUE
       LIMIT 1`,
      [email]
    );

    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ success: false, message: "Invalid email or password." });
    }

    if (user.account_status === "pending_approval") {
      return res.status(403).json({ success: false, message: "Your store account is awaiting approval." });
    }
    if (user.account_status !== "active") {
      return res.status(403).json({ success: false, message: "This store account is not active." });
    }

    req.session.regenerate((error) => {
      if (error) {
        console.error("Dashboard session error:", error);
        return res.status(500).json({ success: false, message: "Could not start a session." });
      }

      req.session.user = {
        id: user.id,
        storeId: user.store_id,
        email: user.email,
        role: user.role,
      };

      req.session.save((saveError) => {
        if (saveError) {
          console.error("Dashboard session save error:", saveError);
          return res.status(500).json({ success: false, message: "Could not save the session." });
        }

        return res.json({
          success: true,
          user: {
            email: user.email,
            storeId: user.store_id,
            role: user.role,
          },
        });
      });
    });
  } catch (error) {
    console.error("Dashboard login error:", error);
    return res.status(500).json({ success: false, message: "Login failed." });
  }
});

app.get("/dashboard/me", (req, res) => {
  if (req.session.platformAdmin && req.session.activeStoreId) {
    return res.json({
      success: true,
      user: {
        email: req.session.platformAdmin.email,
        storeId: req.session.activeStoreId,
        role: "platform_admin",
        isPlatformAdmin: true,
      },
    });
  }

  if (!req.session.user) {
    return res.status(401).json({ success: false, message: "Not logged in." });
  }

  res.json({ success: true, user: req.session.user });
});

app.post("/dashboard/logout", (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      console.error("Dashboard logout error:", error);
      return res.status(500).json({ success: false, message: "Could not log out." });
    }

    res.clearCookie("sai_dashboard", { path: "/" });
    res.json({ success: true, message: "Logged out." });
  });
});

function requireDashboardLogin(req, res, next) {
  const storeId = req.session.platformAdmin
    ? req.session.activeStoreId
    : req.session.user?.storeId;

  if (!storeId || !Number.isSafeInteger(Number(storeId)) || Number(storeId) <= 0) {
    return res.status(401).json({
      success: false,
      message: req.session.platformAdmin
        ? "Select a store before opening its dashboard."
        : "Please log in to the dashboard.",
    });
  }

  req.dashboardStoreId = Number(storeId);
  next();
}

function requirePlatformAdmin(req, res, next) {
  if (!req.session.platformAdmin) {
    return res.status(401).json({ success: false, message: "Platform admin login required." });
  }
  next();
}

app.post("/dashboard/admin/login", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim();
    const password = String(req.body?.password || "");

    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Email and password are required." });
    }

    const result = await pool.query(
      `SELECT id, email, password_hash
       FROM platform_admins
       WHERE LOWER(email) = LOWER($1) AND is_active = TRUE
       LIMIT 1`,
      [email]
    );
    const admin = result.rows[0];

    if (!admin || !(await bcrypt.compare(password, admin.password_hash))) {
      return res.status(401).json({ success: false, message: "Invalid email or password." });
    }

    req.session.regenerate(error => {
      if (error) {
        console.error("Platform admin session error:", error.message);
        return res.status(500).json({ success: false, message: "Could not start a session." });
      }

      req.session.platformAdmin = { id: admin.id, email: admin.email };
      req.session.save(saveError => {
        if (saveError) {
          console.error("Platform admin session save error:", saveError.message);
          return res.status(500).json({ success: false, message: "Could not save the session." });
        }
        res.json({ success: true, admin: req.session.platformAdmin });
      });
    });
  } catch (error) {
    console.error("Platform admin login error:", error.message);
    res.status(500).json({ success: false, message: "Platform admin login failed." });
  }
});

app.get("/dashboard/admin/me", requirePlatformAdmin, (req, res) => {
  res.json({ success: true, admin: req.session.platformAdmin });
});

app.post("/dashboard/admin/logout", requirePlatformAdmin, (req, res) => {
  req.session.destroy(error => {
    if (error) {
      console.error("Platform admin logout error:", error.message);
      return res.status(500).json({ success: false, message: "Could not log out." });
    }
    res.clearCookie("sai_dashboard", { path: "/" });
    res.json({ success: true });
  });
});

app.get("/dashboard/admin/stores", requirePlatformAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         s.id, s.name, s.website_url, s.platform, s.currency_code, s.created_at, s.account_status,
         (SELECT COUNT(*)::int FROM conversations c WHERE c.store_id = s.id) AS conversation_count,
         (SELECT MAX(c.updated_at) FROM conversations c WHERE c.store_id = s.id) AS last_activity_at,
         (SELECT su.email FROM store_users su
          WHERE su.store_id = s.id AND su.is_active = TRUE
          ORDER BY CASE WHEN su.role = 'owner' THEN 0 ELSE 1 END, su.id
          LIMIT 1) AS owner_email,
         COALESCE((
           SELECT json_agg(json_build_object(
             'platform', si.platform,
             'configured', (si.credentials_encrypted IS NOT NULL AND si.credentials_encrypted <> '{}'::jsonb)
           ) ORDER BY si.platform)
           FROM store_integrations si WHERE si.store_id = s.id
         ), '[]'::json) AS integrations
       FROM stores s
       ORDER BY s.created_at DESC, s.id DESC`
    );

    res.json({ success: true, stores: result.rows });
  } catch (error) {
    console.error("Platform admin store list error:", error.message);
    res.status(500).json({ success: false, message: "Could not load stores." });
  }
});

app.get("/dashboard/admin/conversations", requirePlatformAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         c.id,
         c.store_id,
         s.name AS store_name,
         c.crm_status,
         c.updated_at,
         COUNT(m.id)::int AS message_count,
         MAX(m.created_at) AS last_message_at,
         (
           SELECT CASE
             WHEN jsonb_typeof(latest_user_message.content) = 'string'
               THEN latest_user_message.content #>> '{}'
             ELSE COALESCE(
               latest_user_message.content ->> 'message',
               latest_user_message.content::text
             )
           END
           FROM messages latest_user_message
           WHERE latest_user_message.conversation_id = c.id
             AND latest_user_message.role = 'user'
           ORDER BY latest_user_message.created_at DESC
           LIMIT 1
         ) AS latest_customer_message,
         l.name AS customer_name,
         l.email AS customer_email,
         l.phone AS customer_phone
       FROM conversations c
       JOIN stores s ON s.id = c.store_id
       LEFT JOIN messages m ON m.conversation_id = c.id
       LEFT JOIN leads l ON l.conversation_id = c.id
       GROUP BY c.id, s.id, l.id
       ORDER BY MAX(m.created_at) DESC NULLS LAST
       LIMIT 200`
    );

    res.json({ success: true, conversations: result.rows });
  } catch (error) {
    console.error("Platform admin conversations error:", error.message);
    res.status(500).json({ success: false, message: "Could not load conversations." });
  }
});

app.post("/dashboard/admin/stores/:id/approve", requirePlatformAdmin, async (req, res) => {
  const storeId = Number(req.params.id);
  if (!Number.isSafeInteger(storeId) || storeId <= 0) {
    return res.status(400).json({ success: false, message: "Choose a valid store." });
  }

  try {
    const result = await pool.query(
      `UPDATE stores SET account_status = 'active'
       WHERE id = $1 AND account_status = 'pending_approval'
       RETURNING id, name, account_status`,
      [storeId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Pending store request not found." });
    }
    res.json({ success: true, store: result.rows[0], message: "Store approved. Its owner can now sign in." });
  } catch (error) {
    console.error("Platform admin approve-store error:", error.message);
    res.status(500).json({ success: false, message: "Could not approve this store." });
  }
});

app.post("/dashboard/admin/stores", requirePlatformAdmin, async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const rawWebsiteUrl = String(req.body?.website_url || "").trim();
  const currencyCode = String(req.body?.currency_code || "").trim().toUpperCase();
  const ownerEmail = String(req.body?.owner_email || "").trim().toLowerCase();
  const ownerPassword = String(req.body?.owner_password || "");

  let website;
  try {
    website = new URL(rawWebsiteUrl);
  } catch {
    return res.status(400).json({ success: false, message: "Enter a valid store website URL." });
  }

  if (!name || name.length > 120) {
    return res.status(400).json({ success: false, message: "Store name is required and must be 120 characters or fewer." });
  }
  if (!["http:", "https:"].includes(website.protocol)) {
    return res.status(400).json({ success: false, message: "Store website must use HTTP or HTTPS." });
  }
  if (!/^[A-Z]{3}$/.test(currencyCode)) {
    return res.status(400).json({ success: false, message: "Currency must be a three-letter code such as GBP or USD." });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
    return res.status(400).json({ success: false, message: "Enter a valid store owner email." });
  }
  if (ownerPassword.length < 12) {
    return res.status(400).json({ success: false, message: "The owner password must be at least 12 characters." });
  }

  const existingOwner = await pool.query(
    "SELECT 1 FROM store_users WHERE LOWER(email) = LOWER($1) LIMIT 1",
    [ownerEmail]
  );
  if (existingOwner.rowCount) {
    return res.status(409).json({ success: false, message: "This owner email already has an account. Use a different email." });
  }

  const websiteUrl = website.toString().replace(/\/+$/, "");
  const allowedOrigins = [website.origin];
  if (process.env.NODE_ENV !== "production") allowedOrigins.push("http://localhost:3000");

  const client = await pool.connect();
  try {
    const passwordHash = await bcrypt.hash(ownerPassword, 12);
    const widgetKey = randomUUID();
    await client.query("BEGIN");

    const storeResult = await client.query(
      `INSERT INTO stores
         (name, website_url, platform, currency_code, created_at,
          public_widget_key, allowed_origins)
       VALUES ($1, $2, 'woocommerce', $3, NOW(), $4, $5)
       RETURNING id, name, website_url, platform, currency_code`,
      [name, websiteUrl, currencyCode, widgetKey, [...new Set(allowedOrigins)]]
    );
    const store = storeResult.rows[0];

    await client.query(
      `INSERT INTO store_users (store_id, email, password_hash, role, is_active, created_at)
       VALUES ($1, $2, $3, 'owner', TRUE, NOW())`,
      [store.id, ownerEmail, passwordHash]
    );

    await client.query("COMMIT");
    res.status(201).json({ success: true, store: { ...store, owner_email: ownerEmail } });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Platform admin create-store error:", error.message);
    res.status(error.code === "23505" ? 409 : 500).json({
      success: false,
      message: error.code === "23505"
        ? "This owner email is already in use. Use another email or update the existing account."
        : "Could not create the store and owner account.",
    });
  } finally {
    client.release();
  }
});

app.post("/dashboard/admin/select-store", requirePlatformAdmin, async (req, res) => {
  try {
    const storeId = Number(req.body?.storeId);
    if (!Number.isSafeInteger(storeId) || storeId <= 0) {
      return res.status(400).json({ success: false, message: "Choose a valid store." });
    }

    const result = await pool.query(
      "SELECT id, name FROM stores WHERE id = $1",
      [storeId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Store not found." });
    }

    req.session.activeStoreId = Number(result.rows[0].id);
    req.session.save(error => {
      if (error) {
        console.error("Platform admin store selection error:", error.message);
        return res.status(500).json({ success: false, message: "Could not open this store." });
      }
      res.json({ success: true, store: result.rows[0] });
    });
  } catch (error) {
    console.error("Platform admin store selection error:", error.message);
    res.status(500).json({ success: false, message: "Could not open this store." });
  }
});

app.post(
  "/dashboard/knowledge-sources/upload",
  requireDashboardLogin,
  parseKnowledgeUpload,
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "Choose a PDF or TXT file.",
        });
      }

      const title = String(req.body?.title || "").trim();
      const sourceType = String(req.body?.source_type || "store_policy").trim();

      if (!title) {
        await unlink(req.file.path).catch(() => {});
        return res.status(400).json({
          success: false,
          message: "A source title is required.",
        });
      }

      const filePath = path
        .relative(process.cwd(), req.file.path)
        .split(path.sep)
        .join("/");

      const result = await pool.query(
        `INSERT INTO knowledge_sources
           (store_id, source_kind, source_type, title, file_path, is_active)
         VALUES ($1, 'file', $2, $3, $4, TRUE)
         RETURNING id, source_kind, source_type, title, url, file_path, is_active, created_at`,
        [req.dashboardStoreId, sourceType, title, filePath]
      );

      res.status(201).json({ success: true, source: result.rows[0] });
    } catch (error) {
      if (req.file?.path) {
        await unlink(req.file.path).catch(() => {});
      }

      console.error("Dashboard knowledge-file upload error:", error);
      res.status(500).json({
        success: false,
        message: "Could not save the uploaded knowledge file.",
      });
    }
  }
);

app.get("/dashboard/knowledge-sources", requireDashboardLogin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, source_kind, source_type, title, url, file_path, is_active, created_at, updated_at
       FROM knowledge_sources
       WHERE store_id = $1
       ORDER BY created_at DESC`,
      [req.dashboardStoreId]
    );

    res.json({ success: true, sources: result.rows });
  } catch (error) {
    console.error("Dashboard knowledge sources error:", error);
    res.status(500).json({
      success: false,
      message: "Could not load knowledge sources.",
    });
  }
});

app.post("/dashboard/knowledge-sources", requireDashboardLogin, async (req, res) => {
  try {
    const title = String(req.body?.title || "").trim();
    const sourceType = String(req.body?.source_type || "store_policy").trim();
    const url = String(req.body?.url || "").trim();

    if (!title || !url) {
      return res.status(400).json({
        success: false,
        message: "Title and URL are required.",
      });
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      return res.status(400).json({
        success: false,
        message: "Enter a valid URL.",
      });
    }

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return res.status(400).json({
        success: false,
        message: "Only HTTP and HTTPS URLs are supported.",
      });
    }

    const result = await pool.query(
      `INSERT INTO knowledge_sources
         (store_id, source_kind, source_type, title, url, is_active)
       VALUES ($1, 'url', $2, $3, $4, TRUE)
       RETURNING id, source_kind, source_type, title, url, file_path, is_active, created_at`,
      [req.dashboardStoreId, sourceType, title, url]
    );

    res.status(201).json({ success: true, source: result.rows[0] });
  } catch (error) {
    console.error("Add dashboard knowledge source error:", error);
    res.status(500).json({
      success: false,
      message: "Could not add the knowledge source.",
    });
  }
});

app.patch(
  "/dashboard/knowledge-sources/:id",
  requireDashboardLogin,
  async (req, res) => {
    try {
      const sourceId = Number(req.params.id);
      const isActive = req.body?.is_active;

      if (!Number.isInteger(sourceId) || sourceId <= 0) {
        return res.status(400).json({
          success: false,
          message: "Invalid source ID.",
        });
      }

      if (typeof isActive !== "boolean") {
        return res.status(400).json({
          success: false,
          message: "is_active must be true or false.",
        });
      }

      const result = await pool.query(
        `UPDATE knowledge_sources
         SET is_active = $1, updated_at = NOW()
         WHERE id = $2 AND store_id = $3
         RETURNING id, source_kind, source_type, title, url, file_path, is_active, created_at`,
        [isActive, sourceId, req.dashboardStoreId]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({
          success: false,
          message: "Knowledge source not found.",
        });
      }

      res.json({ success: true, source: result.rows[0] });
    } catch (error) {
      console.error("Update dashboard knowledge source error:", error);
      res.status(500).json({
        success: false,
        message: "Could not update the knowledge source.",
      });
    }
  }
);

app.put(
  "/dashboard/knowledge-sources/:id",
  requireDashboardLogin,
  async (req, res) => {
    try {
      const sourceId = Number(req.params.id);
      const title = String(req.body?.title || "").trim();
      const sourceType = String(req.body?.source_type || "").trim();
      const url = String(req.body?.url || "").trim();

      if (!Number.isInteger(sourceId) || sourceId <= 0 || !title || !sourceType || !url) {
        return res.status(400).json({
          success: false,
          message: "A valid source ID, title, source type, and URL are required.",
        });
      }

      let parsedUrl;
      try {
        parsedUrl = new URL(url);
      } catch {
        return res.status(400).json({
          success: false,
          message: "Enter a valid URL.",
        });
      }

      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        return res.status(400).json({
          success: false,
          message: "Only HTTP and HTTPS URLs are supported.",
        });
      }

      const result = await pool.query(
        `UPDATE knowledge_sources
         SET title = $1, source_type = $2, url = $3, updated_at = NOW()
         WHERE id = $4 AND store_id = $5 AND source_kind = 'url'
         RETURNING id, source_kind, source_type, title, url, file_path, is_active, created_at`,
        [title, sourceType, url, sourceId, req.dashboardStoreId]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({
          success: false,
          message: "URL knowledge source not found.",
        });
      }

      res.json({ success: true, source: result.rows[0] });
    } catch (error) {
      console.error("Edit dashboard knowledge source error:", error);
      res.status(500).json({
        success: false,
        message: "Could not edit the knowledge source.",
      });
    }
  }
);

app.post(
  "/dashboard/rebuild-knowledge-base",
  requireDashboardLogin,
  async (req, res) => {
    const storeId = String(req.dashboardStoreId);

    if (rebuildingStores.has(storeId)) {
      return res.status(409).json({
        success: false,
        message: "A knowledge-base rebuild is already running for this store.",
      });
    }

    rebuildingStores.add(storeId);

    try {
      const result = await execFileAsync(
        process.execPath,
        [
          path.resolve("scripts/buildKnowledgeBase.js"),
          storeId,
        ],
        {
          cwd: process.cwd(),
          env: process.env,
          timeout: 10 * 60 * 1000,
          maxBuffer: 10 * 1024 * 1024,
        }
      );

      await pool.query(
        `INSERT INTO knowledge_base_builds (store_id, built_at)
        VALUES ($1, NOW())
        ON CONFLICT (store_id)
        DO UPDATE SET built_at = EXCLUDED.built_at`,
        [req.dashboardStoreId]
      );

      console.log(`Knowledge base rebuilt for store ${storeId}.`);
      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.error(result.stderr);

      res.json({
        success: true,
        message: `Knowledge base rebuilt for store ${storeId}.`,
      });
    } catch (error) {
      console.error(`Knowledge-base rebuild failed for store ${storeId}:`, error);
      res.status(500).json({
        success: false,
        message: "Knowledge-base rebuild failed. Check the server terminal for details.",
      });
    } finally {
      rebuildingStores.delete(storeId);
    }
  }
);

app.get(
  "/dashboard/knowledge-base-status",
  requireDashboardLogin,
  async (req, res) => {
    try {
      const storeId = req.dashboardStoreId;

      const [sourceResult, buildResult] = await Promise.all([
        pool.query(
          `SELECT MAX(updated_at) AS latest_source_change
           FROM knowledge_sources
           WHERE store_id = $1`,
          [storeId]
        ),
        pool.query(
          `SELECT built_at
           FROM knowledge_base_builds
           WHERE store_id = $1`,
          [storeId]
        ),
      ]);

      const latestSourceChange =
        sourceResult.rows[0]?.latest_source_change || null;
      const builtAt = buildResult.rows[0]?.built_at || null;

      const needsRebuild =
        !builtAt ||
        (latestSourceChange &&
          new Date(latestSourceChange) > new Date(builtAt));

      res.json({
        success: true,
        needs_rebuild: Boolean(needsRebuild),
        latest_source_change: latestSourceChange,
        built_at: builtAt,
      });
    } catch (error) {
      console.error("Knowledge-base status error:", error);
      res.status(500).json({
        success: false,
        message: "Could not check knowledge-base status.",
      });
    }
  }
);

app.get("/dashboard/store-settings", requireDashboardLogin, async (req, res) => {
  try {
    const storeId = req.dashboardStoreId;

    const [storeResult, integrationsResult] = await Promise.all([
      pool.query(
        `SELECT id, name, website_url, platform, currency_code,
                public_widget_key, allowed_origins
         FROM stores
         WHERE id = $1`,
        [storeId]
      ),
      pool.query(
        `SELECT platform,
                (
                  credentials_encrypted IS NOT NULL
                  AND credentials_encrypted <> '{}'::jsonb
                ) AS configured
         FROM store_integrations
         WHERE store_id = $1`,
        [storeId]
      ),
    ]);

    if (storeResult.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Store not found.",
      });
    }

    res.json({
      success: true,
      store: storeResult.rows[0],
      integrations: integrationsResult.rows,
    });
  } catch (error) {
    console.error("Dashboard store settings error:", error);
    res.status(500).json({
      success: false,
      message: "Could not load store settings.",
    });
  }
});

app.put("/dashboard/store-settings", requireDashboardLogin, async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const websiteUrl = String(req.body?.website_url || "").trim();
    const currencyCode = String(req.body?.currency_code || "").trim().toUpperCase();
    const rawOrigins = req.body?.allowed_origins;

    if (!name || name.length > 120) {
      return res.status(400).json({
        success: false,
        message: "Store name is required and must be 120 characters or fewer.",
      });
    }

    let parsedWebsite;
    try {
      parsedWebsite = new URL(websiteUrl);
    } catch {
      return res.status(400).json({
        success: false,
        message: "Enter a valid store website URL.",
      });
    }

    if (!["http:", "https:"].includes(parsedWebsite.protocol)) {
      return res.status(400).json({
        success: false,
        message: "The store website must use HTTP or HTTPS.",
      });
    }

    if (!/^[A-Z]{3}$/.test(currencyCode)) {
      return res.status(400).json({
        success: false,
        message: "Currency must be a three-letter code, such as GBP or USD.",
      });
    }

    if (!Array.isArray(rawOrigins) || rawOrigins.length === 0 || rawOrigins.length > 20) {
      return res.status(400).json({
        success: false,
        message: "Provide between 1 and 20 allowed website origins.",
      });
    }

    const allowedOrigins = [];

    for (const value of rawOrigins) {
      let parsedOrigin;
      try {
        parsedOrigin = new URL(String(value).trim());
      } catch {
        return res.status(400).json({
          success: false,
          message: `Invalid allowed origin: ${value}`,
        });
      }

      if (!["http:", "https:"].includes(parsedOrigin.protocol)) {
        return res.status(400).json({
          success: false,
          message: "Allowed origins must use HTTP or HTTPS.",
        });
      }

      allowedOrigins.push(parsedOrigin.origin);
    }

    const result = await pool.query(
      `UPDATE stores
       SET name = $1,
           website_url = $2,
           currency_code = $3,
           allowed_origins = $4
       WHERE id = $5
       RETURNING id, name, website_url, platform, currency_code,
                 public_widget_key, allowed_origins`,
      [name, parsedWebsite.origin, currencyCode, [...new Set(allowedOrigins)], req.dashboardStoreId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Store not found.",
      });
    }

    res.json({ success: true, store: result.rows[0] });
  } catch (error) {
    console.error("Dashboard update store settings error:", error);
    res.status(500).json({
      success: false,
      message: "Could not update store settings.",
    });
  }
});

app.put(
  "/dashboard/store-integrations/woocommerce",
  requireDashboardLogin,
  async (req, res) => {
    try {
      const consumerKey = String(req.body?.consumerKey || "").trim();
      const consumerSecret = String(req.body?.consumerSecret || "").trim();

      if (!consumerKey || !consumerSecret) {
        return res.status(400).json({
          success: false,
          message: "Both WooCommerce API credentials are required.",
        });
      }

      const encryptedCredentials = encryptCredentials({
        consumerKey,
        consumerSecret,
      });

      const storeId = req.dashboardStoreId;

      const updated = await pool.query(
        `UPDATE store_integrations
         SET credentials_encrypted = $1, updated_at = NOW()
         WHERE store_id = $2 AND platform = 'woocommerce'
         RETURNING platform, updated_at`,
        [encryptedCredentials, storeId]
      );

      if (updated.rowCount === 0) {
        const inserted = await pool.query(
          `INSERT INTO store_integrations
             (store_id, platform, credentials_encrypted, created_at, updated_at)
           VALUES ($1, 'woocommerce', $2, NOW(), NOW())
           RETURNING platform, updated_at`,
          [storeId, encryptedCredentials]
        );

        return res.json({
          success: true,
          integration: inserted.rows[0],
          credentials_configured: true,
        });
      }

      res.json({
        success: true,
        integration: updated.rows[0],
        credentials_configured: true,
      });
    } catch (error) {
      console.error("Save WooCommerce credentials error:", error);
      res.status(500).json({
        success: false,
        message: "Could not save WooCommerce credentials. Check the server log.",
      });
    }
  }
);

app.put(
  "/dashboard/store-integrations/smtp",
  requireDashboardLogin,
  async (req, res) => {
    try {
      const host = String(req.body?.host || "").trim();
      const port = Number(req.body?.port);
      const secure = req.body?.secure === true;
      const username = String(req.body?.username || "").trim();
      const password = String(req.body?.password || "");
      const fromEmail = String(req.body?.fromEmail || "").trim().toLowerCase();
      const fromName = String(req.body?.fromName || "").trim();

      if (
        !host ||
        host.length > 253 ||
        /\s/.test(host) ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535 ||
        !username ||
        !password ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail) ||
        fromName.length > 120
      ) {
        return res.status(400).json({
          success: false,
          message: "Enter valid SMTP server, port, login, and sender details.",
        });
      }

      const encryptedCredentials = encryptCredentials({
        host,
        port,
        secure,
        username,
        password,
        fromEmail,
        fromName,
      });

      const storeId = req.dashboardStoreId;

      const updated = await pool.query(
        `UPDATE store_integrations
         SET credentials_encrypted = $1, updated_at = NOW()
         WHERE store_id = $2 AND platform = 'smtp'
         RETURNING platform, updated_at`,
        [encryptedCredentials, storeId]
      );

      if (updated.rowCount === 0) {
        const inserted = await pool.query(
          `INSERT INTO store_integrations
             (store_id, platform, credentials_encrypted, created_at, updated_at)
           VALUES ($1, 'smtp', $2, NOW(), NOW())
           RETURNING platform, updated_at`,
          [storeId, encryptedCredentials]
        );

        return res.json({
          success: true,
          integration: inserted.rows[0],
          credentials_configured: true,
        });
      }

      res.json({
        success: true,
        integration: updated.rows[0],
        credentials_configured: true,
      });
    } catch (error) {
      console.error("Save SMTP credentials error:", error);
      res.status(500).json({
        success: false,
        message: "Could not save SMTP settings.",
      });
    }
  }
);

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function normalizeText(text = "") {

  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

}

app.use(async (req, res, next) => {
  if (req.path !== "/chat") {
    return next();
  }

  const origin = req.get("Origin");

  if (!origin) {
    return next();
  }

  try {
    const normalizedOrigin = new URL(origin).origin;

    const result = await pool.query(
      `SELECT 1
       FROM stores
       WHERE $1 = ANY(allowed_origins)
       LIMIT 1`,
      [normalizedOrigin]
    );

    if (result.rowCount === 0) {
      return res.status(403).json({
        success: false,
        error: "This website is not allowed to use the chat."
      });
    }

    res.setHeader("Access-Control-Allow-Origin", normalizedOrigin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      return res.sendStatus(204);
    }

    return next();
  } catch (error) {
    console.error("CORS origin check failed:", error.message);

    return res.status(500).json({
      success: false,
      error: "Unable to verify this website."
    });
  }
});


function removeDuplicateProducts(products) {

  return [
    ...new Map(
      products.map(product => [
        product.id,
        product
      ])
    ).values()
  ];

}

function getReferencedProducts(history = [], references = []) {
  const previousProductSet = [...history]
    .reverse()
    .find(item =>
      item.role === "assistant" &&
      Array.isArray(item.content) &&
      item.content.some(product => product?.id)
    )
    ?.content.filter(product => product?.id) || [];

  const reference = references.find(
    item => item.type === "previous_products"
  );

  if (!reference || !previousProductSet.length) {
    return previousProductSet;
  }

  if (
    reference.selector === "position" &&
    Number.isInteger(reference.position)
  ) {
    const product = previousProductSet[reference.position - 1];
    return product ? [product] : [];
  }

  if (
    reference.selector === "positions" &&
    Array.isArray(reference.positions)
  ) {
    return reference.positions
      .map(position => previousProductSet[position - 1])
      .filter(Boolean);
  }

  return previousProductSet;
}

app.get(
  "/dashboard/conversations",
  requireDashboardLogin,
  async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT
           c.id,
           c.crm_status,
           c.visitor_id,
           c.created_at,
           c.updated_at,
           COUNT(m.id)::int AS message_count,
           MAX(m.created_at) AS last_message_at,
           (
             SELECT CASE
               WHEN jsonb_typeof(latest_user_message.content) = 'string'
                 THEN latest_user_message.content #>> '{}'
               ELSE COALESCE(
                 latest_user_message.content ->> 'message',
                 latest_user_message.content::text
               )
             END
             FROM messages latest_user_message
             WHERE latest_user_message.conversation_id = c.id
               AND latest_user_message.role = 'user'
             ORDER BY latest_user_message.created_at DESC
             LIMIT 1
           ) AS latest_customer_message,
           l.name AS customer_name,
           l.email AS customer_email,
           l.phone AS customer_phone,
           COALESCE(l.consent_to_contact, FALSE) AS consent_to_contact
         FROM conversations c
         LEFT JOIN messages m ON m.conversation_id = c.id
         LEFT JOIN leads l ON l.conversation_id = c.id
         WHERE c.store_id = $1
         GROUP BY c.id, l.id
         ORDER BY MAX(m.created_at) DESC NULLS LAST
         LIMIT 50`,
        [req.dashboardStoreId]
      );

      res.json({ success: true, conversations: result.rows });
    } catch (error) {
      console.error("Dashboard conversations error:", error);
      res.status(500).json({
        success: false,
        message: "Could not load conversations.",
      });
    }
  }
);

app.get(
  "/dashboard/conversations/:id",
  requireDashboardLogin,
  async (req, res) => {
    try {
      const conversationId = Number(req.params.id);

      if (!Number.isSafeInteger(conversationId) || conversationId <= 0) {
        return res.status(400).json({
          success: false,
          message: "Invalid conversation ID.",
        });
      }

      const conversationResult = await pool.query(
        `SELECT
           c.id,
           c.visitor_id,
           c.created_at,
           c.updated_at,
           c.crm_status,
          c.internal_notes,
           l.name AS customer_name,
           l.email AS customer_email,
           l.phone AS customer_phone,
           COALESCE(l.consent_to_contact, FALSE) AS consent_to_contact
         FROM conversations c
         LEFT JOIN leads l ON l.conversation_id = c.id
         WHERE c.id = $1 AND c.store_id = $2`,
        [conversationId, req.dashboardStoreId]
      );

      if (conversationResult.rowCount === 0) {
        return res.status(404).json({
          success: false,
          message: "Conversation not found.",
        });
      }

      const messagesResult = await pool.query(
        `SELECT id, role, content, created_at
         FROM messages
         WHERE conversation_id = $1
         ORDER BY created_at ASC`,
        [conversationId]
      );

      res.json({
        success: true,
        conversation: conversationResult.rows[0],
        messages: messagesResult.rows,
      });
    } catch (error) {
      console.error("Dashboard conversation detail error:", error);
      res.status(500).json({
        success: false,
        message: "Could not load this conversation.",
      });
    }
  }
);

app.post("/leads", async (req, res) => {
  try {
    const widgetKey = String(req.body?.widgetKey || "").trim();
    const visitorId = String(req.body?.visitorId || "").trim();
    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const phone = String(req.body?.phone || "").trim();
    const consentToContact = req.body?.consentToContact;

    if (!widgetKey || !visitorId || visitorId.length > 100) {
      return res.status(400).json({
        success: false,
        message: "The store and conversation details are required.",
      });
    }

    if (!name || name.length > 120) {
      return res.status(400).json({
        success: false,
        message: "Enter your name (maximum 120 characters).",
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid email address.",
      });
    }

    if (!/^[+()0-9.\-\s]{7,30}$/.test(phone)) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid phone number.",
      });
    }

    if (consentToContact !== true) {
      return res.status(400).json({
        success: false,
        message: "Please agree to be contacted before submitting.",
      });
    }

    const store = await getStoreByWidgetKey(widgetKey, req.get("origin"));

    if (!store) {
      return res.status(403).json({
        success: false,
        message: "This chat widget is not authorized for this website.",
      });
    }

    const conversationId = await getOrCreateConversation(
      Number(store.id),
      visitorId
    );

    await pool.query(
      `INSERT INTO leads
         (conversation_id, name, email, phone, consent_to_contact, consent_at)
       VALUES ($1, $2, $3, $4, TRUE, NOW())
       ON CONFLICT (conversation_id)
       DO UPDATE SET
         name = EXCLUDED.name,
         email = EXCLUDED.email,
         phone = EXCLUDED.phone,
         consent_to_contact = TRUE,
         consent_at = NOW()`,
      [conversationId, name, email, phone]
    );

    res.status(201).json({
      success: true,
      message: "Thanks. Your details have been saved.",
    });
  } catch (error) {
    console.error("Lead submission error:", error);
    res.status(500).json({
      success: false,
      message: "Could not save your details.",
    });
  }
});

app.post("/chat/end", async (req, res) => {
  try {
    const widgetKey = String(req.body?.widgetKey || "").trim();
    const visitorId = String(req.body?.visitorId || "").trim();

    if (!widgetKey || !visitorId || visitorId.length > 100) {
      return res.status(400).json({
        success: false,
        message: "Store and conversation details are required."
      });
    }

    const store = await getStoreByWidgetKey(widgetKey, req.get("origin"));

    if (!store) {
      return res.status(403).json({
        success: false,
        message: "This chat widget is not authorized for this website."
      });
    }

    const result = await pool.query(
      `UPDATE conversations
       SET ended_at = COALESCE(ended_at, NOW()),
           updated_at = NOW()
       WHERE store_id = $1 AND visitor_id = $2
       RETURNING id`,
      [Number(store.id), visitorId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Conversation not found."
      });
    }

    let transcriptSent = false;

    try {
      const emailResult = await sendConversationTranscript(
        Number(store.id),
        result.rows[0].id
      );
      transcriptSent = emailResult.sent;
    } catch (emailError) {
      console.error("End-chat transcript email error:", emailError.message);
    }

    res.json({
      success: true,
      transcriptSent,
      message: transcriptSent
        ? "Chat ended. The transcript has been emailed."
        : "Chat ended."
    });
  } catch (error) {
    console.error("End chat error:", error);
    res.status(500).json({
      success: false,
      message: "Could not end the chat."
    });
  }
});

app.post("/chat/activity", async (req, res) => {
  try {
    const widgetKey = String(req.body?.widgetKey || "").trim();
    const visitorId = String(req.body?.visitorId || "").trim();
    const store = await getStoreByWidgetKey(widgetKey, req.get("origin"));

    if (!store || !visitorId) {
      return res.status(403).json({ success: false });
    }

    const result = await pool.query(
      `UPDATE conversations
       SET updated_at = NOW()
       WHERE store_id = $1 AND visitor_id = $2 AND ended_at IS NULL
       RETURNING id`,
      [Number(store.id), visitorId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Conversation not found or already ended."
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Chat activity error:", error.message);
    res.status(500).json({ success: false });
  }
});

app.patch(
  "/dashboard/conversations/:id",
  requireDashboardLogin,
  async (req, res) => {
    try {
      const conversationId = Number(req.params.id);
      const status = req.body?.crm_status;
      const internalNotes = req.body?.internal_notes;

      if (!Number.isSafeInteger(conversationId) || conversationId <= 0) {
        return res.status(400).json({
          success: false,
          message: "Invalid conversation ID.",
        });
      }

      if (!["new", "follow_up", "resolved"].includes(status)) {
        return res.status(400).json({
          success: false,
          message: "Choose a valid conversation status.",
        });
      }

      if (typeof internalNotes !== "string" || internalNotes.length > 2000) {
        return res.status(400).json({
          success: false,
          message: "Internal notes must be 2,000 characters or fewer.",
        });
      }

      const result = await pool.query(
        `UPDATE conversations
         SET crm_status = $1,
             internal_notes = $2
         WHERE id = $3 AND store_id = $4
         RETURNING id, crm_status, internal_notes`,
        [status, internalNotes.trim(), conversationId, req.dashboardStoreId]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({
          success: false,
          message: "Conversation not found.",
        });
      }

      res.json({ success: true, conversation: result.rows[0] });
    } catch (error) {
      console.error("Update conversation CRM fields error:", error);
      res.status(500).json({
        success: false,
        message: "Could not update the conversation.",
      });
    }
  }
);

app.get("/chat", (req, res) => {
  res.sendFile(path.resolve(process.cwd(), "index.html"));
});

app.post("/chat", async (req, res) => {
  try {
    const { 
      message, 
      history = [], 
      visitorId ,
      widgetKey
    } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({
        success: false,
        error: "Message is required"
      });
    }

    if (
      typeof visitorId !== "string" ||
      !visitorId.trim() ||
      visitorId.length > 100
    ) {
      return res.status(400).json({
        success: false,
        error: "Visitor ID is required"
      });
    }

    const store = await getStoreByWidgetKey(
      widgetKey,
      req.get("origin")
    );

    if (!store) {
      return res.status(403).json({
        success: false,
        error: "This chat widget is not authorized for this website."
      });
    }

    const storeId = Number(store.id);

    if (!Number.isSafeInteger(storeId)) {
      throw new Error("STORE_ID is missing or invalid.");
    }

    const conversationId = await getOrCreateConversation(
      storeId,
      visitorId
    );

    await saveMessage(conversationId, "user", message);

    const sendChatResponse = async payload => {
      await saveMessage(conversationId, "assistant", {
        message: payload.message || "",
        products: payload.products || []
      });

      return res.json(payload);
    };

    const retrievalPlan = await createRetrievalPlan({ message, history });

    console.log(
      "RETRIEVAL PLAN:",
      JSON.stringify(retrievalPlan, null, 2)
    );

        if (retrievalPlan.sources.customer) {
      const emailMatch = message.match(
        /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
      );

      // Ask for this exact label so the order number can be parsed reliably.
      const orderNumberMatch = message.match(
        /(?:order\s*(?:number|no\.?|id)|order\s*#)\s*[:#-]?\s*([A-Z0-9-]+)/i
      );

      if (!emailMatch || !orderNumberMatch) {
        return sendChatResponse({
          success: true,
          message:
            "To check a guest order, send both details in one message: Order number: YOUR_ORDER_NUMBER; checkout email: YOUR_EMAIL",
          products: []
        });
      }

      let order;

      try {
        order = await findOrderByNumberAndEmail(
          storeId,
          orderNumberMatch[1],
          emailMatch[0]
        );
      } catch (error) {
        console.error(
          "ORDER LOOKUP ERROR:",
          error.response?.data || error.message
        );

        return res.status(502).json({
          success: false,
          error: "Order lookup is temporarily unavailable."
        });
      }

      if (!order) {
        return sendChatResponse({
          success: true,
          message:
            "I couldn't verify an order with those details. Please check them and try again, or contact store support.",
          products: []
        });
      }

      const itemSummary = order.items
        .map(item => item.name + " × " + item.quantity)
        .join(", ");

      return sendChatResponse({
        success: true,
        message:
          "Order " + order.number +
          " status: " + order.status +
          (order.date_created
            ? ". Placed: " + order.date_created
            : "") +
          (itemSummary ? ". Items: " + itemSummary : "") +
          (order.total
            ? ". Total: " + order.total + " " + order.currency
            : "") +
          ".",
        products: []
      });
    }

    const recentHistory = history
      .slice(-10)
      .map(item => {
        const content =
          typeof item.content === "string"
            ? item.content
            : JSON.stringify(item.content);

        return String(item.role || "user").toUpperCase() + ": " + content;
      })
      .join("\n");

    const previouslyShownProducts =
      getReferencedProducts(history, retrievalPlan.references);

    let candidateProducts = [];

    if (
      retrievalPlan.sources.products &&
      (retrievalPlan.sale_only || retrievalPlan.product_query)
    ) {
      if (retrievalPlan.sale_only) {
        candidateProducts.push(...(await searchSaleProducts(storeId)));
      } else {
        const productQuery = retrievalPlan.product_query;

        candidateProducts.push(...(await searchProducts(storeId, productQuery)));

        const categories = await searchCategories(storeId, productQuery);
        const normalizedQuery = normalizeText(productQuery);

        const selectedCategories = categories
          .sort((a, b) => {
            const aExact = normalizeText(a.name) === normalizedQuery ? 1 : 0;
            const bExact = normalizeText(b.name) === normalizedQuery ? 1 : 0;
            return bExact - aExact;
          })
          .slice(0, 2);

        for (const category of selectedCategories) {
          candidateProducts.push(
            ...(await getProductsByCategory(storeId, category.id))
          );
        }
      }
    }

    if (retrievalPlan.sources.conversation_products) {
      candidateProducts.push(...previouslyShownProducts);
    }

    let products = removeDuplicateProducts(candidateProducts);

    if (retrievalPlan.sources.products) {
      products = products.filter(
        product => product.stock_status === "instock"
      );
    }

    const minPrice = retrievalPlan.constraints.min_price;
    const maxPrice = retrievalPlan.constraints.max_price;

    if (minPrice !== null) {
      products = products.filter(
        product => Number(product.price) >= minPrice
      );
    }

    if (maxPrice !== null) {
      products = products.filter(
        product => Number(product.price) <= maxPrice
      );
    }

    let knowledgeResults = [];

    if (
      retrievalPlan.sources.knowledge &&
      retrievalPlan.knowledge_query
    ) {
      knowledgeResults = await searchKnowledge(
        storeId,
        retrievalPlan.knowledge_query,
        { topK: 5, minScore: 0.45 }
      );
    }

    const storeCurrency =
      products.length > 0 ? await getStoreCurrency(storeId) : null;

    const formattedProducts = products
      .map(product => {
        const cleanDescription = (product.description || "")
          .replace(/<[^>]*>/g, "")
          .trim();

          

        const cleanShortDescription = (product.short_description || "")
          .replace(/<[^>]*>/g, "")
          .trim();

        const attributes = product.attributes
          ?.map(attribute => {
            const options = Array.isArray(attribute.options)
              ? attribute.options.join(", ")
              : "";

            return attribute.name + ": " + options;
          })
          .join(", ") || "";

        return [
          "Product ID: " + product.id,
          "Product Name: " + product.name,
          "Short Description: " + cleanShortDescription,
          "Full Description: " + cleanDescription,
          "Categories: " + (product.categories || []).map(category => category.name).join(", "),
          "Tags: " + (product.tags || []).map(tag => tag.name).join(", "),
          "Attributes: " + attributes,
          "Currency Code: " + (storeCurrency?.code || "unknown"),
          "Currency Symbol: " + (storeCurrency?.symbol || ""),
          "Current Price: " + product.price,
          "Regular Price: " + (product.regular_price || product.price),
          "Sale Price: " + (product.on_sale ? product.sale_price : ""),
          "On Sale: " + (product.on_sale ? "yes" : "no"),
          "Stock: " + product.stock_status
        ].join("\n");
      })
      .join("\n---\n");

    const knowledgeContext = knowledgeResults
      .map((result, index) => [
        "SOURCE " + (index + 1),
        "Title: " + result.title,
        "Source Type: " + result.source_type,
        "Relevance Score: " + result.score.toFixed(4),
        result.text
      ].join("\n"))
      .join("\n---\n");

    const unavailableCustomerData = retrievalPlan.sources.customer
  ? "Order lookup is not connected. Providing an order number, email address, or tracking number will not enable a lookup."
  : "No customer-specific data was requested.";

    const prompt = [
      "You are an ecommerce assistant for this store. Understand the customer's request in context and answer naturally.",
      "",
      "Use only the supplied evidence:",
      "- Live product data is authoritative for product names, prices, availability, and specifications.",
      "- Knowledge evidence is authoritative for store policies and reference information.",
      "- Conversation history helps resolve follow-up references.",
      "- Do not claim to have checked order or customer details when that data is unavailable.",
      "- If the supplied evidence does not answer the question, say what information is missing.",
      "- Recommend only products from the candidate list, and only when the supplied details support the recommendation.",
      "- Follow explicit product requirements and price constraints from the retrieval plan.",
      "- If no products match, explain that clearly while still answering any other part of the request.",
      "- For educational and policy answers, include only facts explicitly stated in the supplied knowledge evidence.",
      "- Do not add general background claims, even if they seem commonly true.",
      "- If the evidence does not cover a detail, say the available store information does not specify it.",
      "- Do not treat an implication as a stated fact. If you include an inference, label it as an inference and explain which supplied evidence it follows from.",
      "- When order lookup is unavailable, do not ask for order numbers, email addresses, or tracking numbers. Say that order lookup is not connected and direct the customer to their store account or customer support.",
      "- Keep answers concise by default. Answer simple factual or policy questions in one direct sentence.",
      "- Use a few short sentences or concise bullets only when needed to answer multiple parts accurately.",
      "- Do not add background, extra examples, or follow-up offers unless the customer asks.",
      "- If the supplied store information does not specify the answer, say so briefly instead of guessing.",
      "- For a simple question, answer in no more than 25 words and include only the information needed to answer it; omit related policies and advice unless the customer asks.",
      "- For a simple factual question, answer in one sentence of at most 20 words. Do not add related policies that were not asked about.",
      "- For sale products, only say an item is on sale when its On Sale field is yes. Use the supplied current and regular prices; never calculate or invent a discount.",
      "- Use only the supplied currency code and symbol for product prices. Never guess the currency.",
      "",
      "CUSTOMER REQUEST:",
      message,
      "",
      "RETRIEVAL PLAN:",
      JSON.stringify(retrievalPlan),
      "",
      "CUSTOMER DATA AVAILABILITY:",
      unavailableCustomerData,
      "",
      "CONVERSATION:",
      recentHistory || "No prior conversation.",
      "",
      "KNOWLEDGE EVIDENCE:",
      knowledgeContext || "No knowledge evidence was retrieved.",
      "",
      "CANDIDATE PRODUCTS:",
      formattedProducts || "No products were retrieved.",
      "",
      "Return JSON only in this format:",
      '{ "answer": "A clear, natural answer to the customer", "products": [{ "id": 123, "description": "A short factual reason this product matches" }] }',
      "Return a maximum of 5 products. Use only IDs in CANDIDATE PRODUCTS."
    ].join("\n");

    const response = await client.responses.create({
      model: "gpt-5-mini",
      input: prompt
    });

    const parsed = JSON.parse(response.output_text);

    const recommendedProducts = (parsed.products || [])
      .map(recommendation => {
        const product = products.find(
          item => Number(item.id) === Number(recommendation.id)
        );

        if (!product) {
          return null;
        }

        return {
          id: product.id,
          name: product.name,
          description: recommendation.description || "",
          price: product.price,
          currency: storeCurrency?.code || "",
          currency_symbol: storeCurrency?.symbol || "",
          regular_price: product.regular_price || product.price,
          sale_price: product.sale_price || "",
          on_sale: product.on_sale === true,
          url: product.permalink,
          image: product.images?.[0]?.src || "",
          stock_status: product.stock_status
        };
      })
      .filter(Boolean);

    return sendChatResponse({
      success: true,
      message: parsed.answer || "",
      products: recommendedProducts
    });
  } catch (error) {
    console.error("CHAT ERROR:", error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

let inactivitySweepRunning = false;

async function sweepInactiveConversations() {
  if (inactivitySweepRunning) return;
  inactivitySweepRunning = true;

  try {
    await pool.query(
      `UPDATE conversations c
       SET ended_at = NOW(),
           updated_at = NOW()
       WHERE c.ended_at IS NULL
         AND c.updated_at <= NOW() - INTERVAL '10 minutes'
         AND EXISTS (
           SELECT 1
           FROM messages m
           WHERE m.conversation_id = c.id
         )`
    );

    const pending = await pool.query(
      `SELECT c.id, c.store_id
       FROM conversations c
       JOIN leads l ON l.conversation_id = c.id
       WHERE c.ended_at IS NOT NULL
         AND c.transcript_sent_at IS NULL
         AND c.transcript_send_status IN ('pending', 'failed')
         AND l.consent_to_contact = TRUE
       ORDER BY c.ended_at
       LIMIT 25`
    );

    for (const conversation of pending.rows) {
      try {
        await sendConversationTranscript(
          Number(conversation.store_id),
          conversation.id
        );
      } catch (error) {
        console.error(
          `Transcript retry failed for conversation ${conversation.id}:`,
          error.message
        );
      }
    }
  } catch (error) {
    console.error("Inactive-conversation sweep failed:", error.message);
  } finally {
    inactivitySweepRunning = false;
  }
}

setInterval(() => {
  void sweepInactiveConversations();
}, 60_000);

void sweepInactiveConversations();

app.listen(3000, () => {
  console.log("Server running on port 3000");
});

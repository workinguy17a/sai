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

app.use(express.json());

const PgSession = connectPgSimple(session);

const knowledgeUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, callback) {
      const storeId = Number(req.session?.user?.storeId);

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



app.post("/dashboard/login", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim();
    const password = String(req.body?.password || "");

    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Email and password are required." });
    }

    const result = await pool.query(
      `SELECT id, store_id, email, password_hash, role
       FROM store_users
       WHERE LOWER(email) = LOWER($1) AND is_active = TRUE
       LIMIT 1`,
      [email]
    );

    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ success: false, message: "Invalid email or password." });
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
  if (!req.session.user) {
    return res.status(401).json({
      success: false,
      message: "Please log in to the dashboard.",
    });
  }

  next();
}

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
        [req.session.user.storeId, sourceType, title, filePath]
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
      [req.session.user.storeId]
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
      [req.session.user.storeId, sourceType, title, url]
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
        [isActive, sourceId, req.session.user.storeId]
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
        [title, sourceType, url, sourceId, req.session.user.storeId]
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
    const storeId = String(req.session.user.storeId);

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
        [req.session.user.storeId]
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
      const storeId = req.session.user.storeId;

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
    const storeId = req.session.user.storeId;

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
      [name, parsedWebsite.origin, currencyCode, [...new Set(allowedOrigins)], req.session.user.storeId]
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

      const storeId = req.session.user.storeId;

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
        return res.json({
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
        return res.json({
          success: true,
          message:
            "I couldn't verify an order with those details. Please check them and try again, or contact store support.",
          products: []
        });
      }

      const itemSummary = order.items
        .map(item => item.name + " × " + item.quantity)
        .join(", ");

      return res.json({
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

    return res.json({
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
app.listen(3000, () => {
  console.log("Server running on port 3000");
});
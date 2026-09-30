import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import axios from "axios";
import * as cheerio from "cheerio";
import { PDFParse } from "pdf-parse";
import OpenAI from "openai";
import { pool } from "../services/databaseService.js";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const ROOT_DIR = process.cwd();
const storeId = process.argv[2];

if (!/^[1-9]\d*$/.test(storeId || "")) {
  throw new Error("Usage: npm run knowledge:build -- <storeId>");
}

const STORE_DIR = path.join(
  ROOT_DIR,
  "knowledge",
  "stores",
  storeId
);

const INDEX_FILE = path.join(
  STORE_DIR,
  "index.json"
);

const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 200;

/* ---------------------------------------
   TEXT CLEANING
--------------------------------------- */

function cleanText(text = "") {
  return text
    .replace(/\s+/g, " ")
    .replace(/\n+/g, "\n")
    .trim();
}

/* ---------------------------------------
   TEXT CHUNKING
--------------------------------------- */

function createChunks(text) {
  const cleaned = cleanText(text);

  if (!cleaned) {
    return [];
  }

  const chunks = [];

  let start = 0;

  while (start < cleaned.length) {
    const end = Math.min(
      start + CHUNK_SIZE,
      cleaned.length
    );

    const chunk = cleaned.slice(start, end).trim();

    if (chunk.length > 100) {
      chunks.push(chunk);
    }

    if (end >= cleaned.length) {
      break;
    }

    start = end - CHUNK_OVERLAP;
  }

  return chunks;
}

/* ---------------------------------------
   URL EXTRACTION
--------------------------------------- */

async function extractFromUrl(source) {
  console.log(`Reading URL: ${source.url}`);

  const response = await axios.get(source.url, {
    timeout: 20000,
    headers: {
      "User-Agent": "KnifeAI-KnowledgeBuilder/1.0"
    }
  });

  const $ = cheerio.load(response.data);

  // Remove content that is normally not useful
$(
  "script, style, noscript, svg, iframe, " +
  "nav, footer, header, aside, " +
  ".woocommerce-breadcrumb, " +
  ".site-header, " +
  ".site-footer, " +
  ".cookie-notice, " +
  ".cookie-banner"
).remove();

const title =
  $("title").first().text().trim() ||
  source.url;

const mainContent =
  $("main").text() ||
  $("article").text() ||
  $("body").text();

const text = mainContent;

  return {
    text: cleanText(text),
    title,
    source_type: source.type || "web",
    url: source.url
  };
}

/* ---------------------------------------
   PDF EXTRACTION
--------------------------------------- */

async function extractFromPdf(source) {
  const filePath = path.resolve(
    ROOT_DIR,
    source.file
  );

  console.log(`Reading PDF: ${source.file}`);

  const buffer = await fs.readFile(filePath);

    const parser = new PDFParse({
    data: buffer
    });

    const data = await parser.getText();

    await parser.destroy();

    return {
    text: cleanText(data.text),
    title:
      source.title ||
      path.basename(filePath),
    source_type: source.type || "pdf",
    file: source.file
  };
}

/* ---------------------------------------
   TXT EXTRACTION
--------------------------------------- */

async function extractFromTextFile(source) {
  const filePath = path.resolve(
    ROOT_DIR,
    source.file
  );

  console.log(`Reading TXT: ${source.file}`);

  const text = await fs.readFile(
    filePath,
    "utf8"
  );

  return {
    text: cleanText(text),
    title:
      source.title ||
      path.basename(filePath),
    source_type: source.type || "text",
    file: source.file
  };
}

/* ---------------------------------------
   EMBEDDINGS
--------------------------------------- */

async function createEmbedding(text) {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text
  });

  return response.data[0].embedding;
}

/* ---------------------------------------
   MAIN BUILDER
--------------------------------------- */

async function buildKnowledgeBase() {
  console.log("=================================");
  console.log("Building Knowledge Base");
  console.log("=================================");

  // const sourcesRaw = await fs.readFile(
  //   SOURCES_FILE,
  //   "utf8"
  // );

  // const sources = JSON.parse(sourcesRaw);

  const sourceResult = await pool.query(
  `SELECT source_kind, source_type, title, url, file_path
   FROM knowledge_sources
   WHERE store_id = $1
     AND is_active = TRUE
   ORDER BY id`,
  [storeId]
);

const sources = {
  urls: sourceResult.rows
    .filter(source => source.source_kind === "url")
    .map(source => ({
      url: source.url,
      type: source.source_type,
      title: source.title
    })),

  files: sourceResult.rows
    .filter(source => source.source_kind === "file")
    .map(source => ({
      file: source.file_path,
      type: source.source_type,
      title: source.title
    }))
};

if (sources.urls.length + sources.files.length === 0) {
  throw new Error(`No active knowledge sources found for store ${storeId}.`);
}

  const documents = [];

  /* -----------------------------------
     URL SOURCES
  ----------------------------------- */

  for (const source of sources.urls || []) {
    try {
      const document = await extractFromUrl(source);

      if (!document.text) {
        console.log(
          `No usable text found: ${source.url}`
        );
        continue;
      }

      documents.push(document);

    } catch (error) {
      console.error(
        `Failed URL: ${source.url}`
      );

      console.error(
        error.response?.status ||
        error.message
      );
    }
  }

  /* -----------------------------------
     FILE SOURCES
  ----------------------------------- */

  for (const source of sources.files || []) {
    try {
      const extension = path
        .extname(source.file)
        .toLowerCase();

      let document;

      if (extension === ".pdf") {
        document = await extractFromPdf(source);
      } else if (extension === ".txt") {
        document = await extractFromTextFile(source);
      } else {
        console.log(
          `Skipping unsupported file: ${source.file}`
        );
        continue;
      }

      if (!document.text) {
        console.log(
          `No usable text found: ${source.file}`
        );
        continue;
      }

      documents.push(document);

    } catch (error) {
      console.error(
        `Failed file: ${source.file}`
      );

      console.error(error.message);
    }
  }

  /* -----------------------------------
     CREATE CHUNKS
  ----------------------------------- */

  const chunks = [];

  for (const document of documents) {
    const documentChunks =
      createChunks(document.text);

    documentChunks.forEach(
      (chunkText, index) => {
        chunks.push({
          id: `chunk_${chunks.length + 1}`,
          text: chunkText,

          source_type:
            document.source_type,

          title:
            document.title,

          url:
            document.url || null,

          file:
            document.file || null,

          chunk_index: index
        });
      }
    );
  }

  console.log(
    `Documents loaded: ${documents.length}`
  );

  console.log(
    `Chunks created: ${chunks.length}`
  );

  /* -----------------------------------
     CREATE EMBEDDINGS
  ----------------------------------- */

  console.log(
    "Creating embeddings..."
  );

  for (let i = 0; i < chunks.length; i++) {
    console.log(
      `Embedding ${i + 1}/${chunks.length}`
    );

    chunks[i].embedding =
      await createEmbedding(
        chunks[i].text
      );
  }

  /* -----------------------------------
     SAVE INDEX
  ----------------------------------- */

  await fs.mkdir(STORE_DIR, { recursive: true });

  const index = {
    version: 1,
    store_id: Number(storeId),
    created_at: new Date().toISOString(),
    embedding_model: "text-embedding-3-small",
    chunk_size: CHUNK_SIZE,
    chunk_overlap: CHUNK_OVERLAP,
    chunks
  };

  await fs.writeFile(
    INDEX_FILE,
    JSON.stringify(index, null, 2),
    "utf8"
  );

  console.log("");
  console.log(
    "Knowledge Base created successfully."
  );

  console.log(
    `Saved to: ${INDEX_FILE}`
  );

  console.log(
    `Total chunks: ${chunks.length}`
  );
}

/* ---------------------------------------
   RUN
--------------------------------------- */

buildKnowledgeBase().catch(error => {
  console.error(
    "Knowledge Base build failed:"
  );

  console.error(error);

  process.exitCode = 1
})
.finally(async () => {
    await pool.end();
  });
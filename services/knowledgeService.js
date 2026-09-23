import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const INDEX_FILE = path.join(
  process.cwd(),
  "knowledge",
  "index.json"
);

/* ---------------------------------------
   COSINE SIMILARITY
--------------------------------------- */

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) {
    return 0;
  }

  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    magnitudeA += a[i] * a[i];
    magnitudeB += b[i] * b[i];
  }

  if (magnitudeA === 0 || magnitudeB === 0) {
    return 0;
  }

  return (
    dotProduct /
    (Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB))
  );
}

/* ---------------------------------------
   LOAD KNOWLEDGE INDEX
--------------------------------------- */

async function loadKnowledgeIndex() {
  try {
    const raw = await fs.readFile(
      INDEX_FILE,
      "utf8"
    );

    return JSON.parse(raw);

  } catch (error) {
    console.error(
      "Failed to load knowledge index:",
      error.message
    );

    return {
      chunks: []
    };
  }
}

/* ---------------------------------------
   CREATE QUERY EMBEDDING
--------------------------------------- */

async function createQueryEmbedding(query) {
  const response =
    await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: query
    });

  return response.data[0].embedding;
}

/* ---------------------------------------
   SEARCH KNOWLEDGE
--------------------------------------- */

export async function searchKnowledge(
  query,
  options = {}
) {
  const {
    topK = 5,
    minScore = 0.45,
    maxPerSource = 2
  } = options;

  if (!query?.trim()) {
    return [];
  }

  const index =
    await loadKnowledgeIndex();

  if (
    !index.chunks ||
    index.chunks.length === 0
  ) {
    return [];
  }

  const queryEmbedding =
    await createQueryEmbedding(query);

  const rankedResults = index.chunks
    .map(chunk => ({
      ...chunk,

      score: cosineSimilarity(
        queryEmbedding,
        chunk.embedding
      )
    }))
    .filter(result =>
      result.score >= minScore
    )
    .sort(
      (a, b) =>
        b.score - a.score
    );

  const selectedResults = [];
  const sourceCounts = new Map();

  for (const result of rankedResults) {
    const sourceKey =
      result.url ||
      result.file ||
      result.title ||
      "unknown";

    const currentCount =
      sourceCounts.get(sourceKey) || 0;

    if (currentCount >= maxPerSource) {
      continue;
    }

    selectedResults.push(result);

    sourceCounts.set(
      sourceKey,
      currentCount + 1
    );

    if (selectedResults.length >= topK) {
      break;
    }
  }

  return selectedResults;
}
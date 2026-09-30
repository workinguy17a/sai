import "dotenv/config";
import { searchKnowledge } from "../services/knowledgeService.js";

const storeId = process.argv[2];
const query =
  process.argv.slice(3).join(" ") ||
  "What is the difference between wooden and steel knife handles?";

if (!/^[1-9]\d*$/.test(storeId || "")) {
  console.error("Usage: npm run knowledge:test -- <storeId> [query]");
  process.exit(1);
}

console.log("");
console.log("=================================");
console.log("Knowledge Search Test");
console.log("=================================");
console.log("");

console.log("QUERY:");
console.log(query);
console.log("");

const results = await searchKnowledge(
  storeId,
  query,
  {
    topK: 5,
    minScore: 0.45
  }
);

if (results.length === 0) {
  console.log(
    "No relevant knowledge found."
  );

  process.exit(0);
}

results.forEach((result, index) => {
  console.log(
    `--- RESULT ${index + 1} ---`
  );

  console.log(
    `Score: ${result.score.toFixed(4)}`
  );

  console.log(
    `Title: ${result.title}`
  );

  console.log(
    `Source: ${result.source_type}`
  );

  console.log("");
  console.log(result.text);
  console.log("");
});
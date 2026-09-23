import express from "express";
import OpenAI from "openai";
import dotenv from "dotenv";
import cors from "cors";

import {
  searchProducts,
  searchCategories,
  getProductsByCategory
} from "./services/woocommerceService.js";

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

const app = express();

app.use(express.json());

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

function getPreviouslyShownProducts(history = []) {

  const products = [];

  for (const item of history) {

    if (
      item.role === "assistant" &&
      Array.isArray(item.content)
    ) {

      for (const product of item.content) {

        if (product?.id) {
          products.push(product);
        }

      }

    }

  }

  return products;
}

function getLastShownProducts(history = []) {
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];

    if (
      item.role === "assistant" &&
      Array.isArray(item.content) &&
      item.content.length > 0
    ) {
      return item.content.filter(product => product?.id);
    }
  }

  return [];
}


function getCheapestPreviousPrice(products = []) {

  const prices = products
    .map(product => Number(product.price))
    .filter(price => !Number.isNaN(price));

  if (prices.length === 0) {
    return null;
  }

  return Math.min(...prices);
}

function getCheapestPreviousProduct(products = []) {

  const validProducts = products
    .filter(product =>
      product &&
      product.id &&
      !Number.isNaN(Number(product.price))
    )
    .sort(
      (a, b) =>
        Number(a.price) - Number(b.price)
    );

  return validProducts[0] || null;
}


app.post("/chat", async (req, res) => {

  try {

    


    // --------------------------------------------------
    // 1. RECEIVE USER MESSAGE + CONVERSATION HISTORY
    // --------------------------------------------------

    const {
      message,
      history = []
    } = req.body;

    const retrievalPlan =
      await createRetrievalPlan({
        message,
        history
      });

    console.log(
      "RETRIEVAL PLAN:",
      JSON.stringify(
        retrievalPlan,
        null,
        2
      )
    );

    if (!message || typeof message !== "string") {

      return res.status(400).json({
        success: false,
        error: "Message is required"
      });

    }


    console.log("\n------------------------------");
    console.log("USER MESSAGE:", message);


    // --------------------------------------------------
    // 2. FORMAT RECENT CONVERSATION HISTORY
    // --------------------------------------------------

    const recentHistory = history
      .slice(-10)
      .map(item => {

        const content =
          typeof item.content === "string"
            ? item.content
            : JSON.stringify(item.content);

        return `${item.role.toUpperCase()}: ${content}`;

      })
      .join("\n");

      const previouslyShownProducts =
  getPreviouslyShownProducts(history);

  const lastShownProducts =
  getLastShownProducts(history);


  const cheapestPreviousProduct =
  getCheapestPreviousProduct(
    previouslyShownProducts
  );

    // --------------------------------------------------
    // 3. AI SHOPPING INTENT EXTRACTION
    // --------------------------------------------------

    const intentResponse = await client.responses.create({

  model: "gpt-5-mini",

  input: `
You are the shopping-intent engine for a knife ecommerce assistant.

The customer may ask a NEW shopping question or a FOLLOW-UP question.

Your job is to resolve the customer's CURRENT shopping intent using:
1. conversation history
2. the latest user message

IMPORTANT:

A follow-up must preserve previous product requirements unless the user clearly changes them.

Examples:

USER:
I want a knife with a wooden handle under £80

Resolved intent:
{
  "search_terms": [
    "wooden handle knife",
    "wood handle knife"
  ],
  "hard_requirements": [
    "wooden handle"
  ],
  "preferences": [],
  "min_price": null,
  "max_price": 80,
  "comparison": null
}


FOLLOW-UP:

USER:
Show me cheaper options

The user STILL wants:
- wooden handle
- knife
- the previous requirements

But now also wants products cheaper than previously shown products.

Resolved intent:
{
  "search_terms": [
    "wooden handle knife",
    "wood handle knife"
  ],
  "hard_requirements": [
    "wooden handle"
  ],
  "preferences": [],
  "min_price": null,
  "max_price": 80,
  "comparison": "cheaper"
}


Other comparison values:

"cheaper"
"more_expensive"
"more"
"different"
"best"
"cheapest"
"similar"
null

COMPARISON RULES:

- Use "cheaper" when the user asks for cheaper options than previously shown products.
- Use "more" when the user asks for more options, such as "show me more", "give me more", or "more options".
- Use "different" when the user asks for different alternatives.
- Use null when there is no comparison or refinement request.

For "more":
- Preserve the previous hard requirements.
- Preserve the previous preferences.
- Find additional matching products.
- Do not return products from the immediately previous product result.

INTENT TYPE:

Use "product_search" for normal product discovery or recommendation.

Use "product_comparison" when the customer wants to compare
products that have already been shown in the conversation.

Examples:

"Compare these products"
"Compare these"
"Compare them"
"Which is better?"
"What are the differences?"

For product comparison:
- Use the previously shown products as the comparison set.
- Do not perform a new product search.
- Set "needs_products" to true.
- Set "comparison" to "compare".

Use "product_availability" when the customer is asking whether a
specific product is currently in stock or available.

Examples:

"Is the 12 Inches Damascus Steel Hunting Knife in stock?"
→ intent_type: "product_availability"

"Do you have the 12 inch Damascus hunting knife?"
→ intent_type: "product_availability"

"Is this knife available?"
→ intent_type: "product_availability"

For product availability questions:
- Put the specific product name or description in "product_query".
- Do not treat the question as a product recommendation.
- Do not recommend alternative products unless the customer asks for alternatives.

For all other knowledge questions, use the existing knowledge logic.

"intent_type": "product_search",
"product_query": ""

QUERY TYPE:

Determine whether the customer needs live WooCommerce products,
knowledge-base information, or both.

Set "needs_products" to true when the customer is asking to:
- find products
- show products
- recommend products
- compare products
- choose a product
- find products by price, material, category, use case, etc.

Set "needs_knowledge" to true when the customer is asking for:
- store policies
- returns or refunds
- delivery information
- age requirements
- terms and conditions
- educational information
- explanations about knife materials, steels, handles, care, etc.

Set BOTH to true when the customer needs products AND an explanation
or policy answer.

Examples:

"What is your return policy?"
needs_products: false
needs_knowledge: true

"Show me Damascus knives under £100"
needs_products: true
needs_knowledge: false

"Show me Damascus knives and tell me how to care for Damascus steel"
needs_products: true
needs_knowledge: true

For "knowledge_query", write the user's knowledge question in a
clear standalone form suitable for semantic knowledge retrieval.

If knowledge is not needed:
"knowledge_query": ""

RULES:

- Do NOT drop previous hard requirements during a follow-up.
- Do NOT convert hard requirements into preferences.
- Explicit characteristics such as wooden handle, Damascus steel,
  folding blade, fixed blade, horn handle, specific steel type,
  or exact material should normally be hard requirements.
- General desires such as stylish, premium, good for gifting,
  strong, attractive may be preferences depending on context.
- Do NOT invent product names.
- Generate a maximum of 3 useful search terms.
- Search terms should help retrieve products/categories.
- Do NOT add a price threshold for "cheaper" yourself.
  Node.js will calculate it from previously shown products.

CONVERSATION HISTORY:

${recentHistory}

CURRENT USER MESSAGE:

${message}

Return JSON only.

Format:

{
  "intent_type": "product_search",
  "search_terms": [],
  "product_query": "",
  "hard_requirements": [],
  "preferences": [],
  "min_price": null,
  "max_price": null,
  "comparison": null,
  "needs_products": false,
  "needs_knowledge": false,
  "knowledge_query": ""
}


Format:

{
  "search_terms": [],
  "min_price": null,
  "max_price": null,
  "requirements": []
}
`
    });


    const intent =
  JSON.parse(intentResponse.output_text);

console.log(
  "RESOLVED INTENT:",
  intent
);

// --------------------------------------------------
// 3A. SPECIFIC PRODUCT AVAILABILITY
// --------------------------------------------------

if (
  intent.intent_type === "product_availability" &&
  intent.product_query
) {
  const availabilityProducts =
    await searchProducts(intent.product_query);

  console.log(
    "AVAILABILITY SEARCH:",
    intent.product_query
  );

  console.log(
    "AVAILABILITY MATCHES:",
    availabilityProducts.map(product => ({
      id: product.id,
      name: product.name,
      stock_status: product.stock_status
    }))
  );

  if (availabilityProducts.length === 0) {
    return res.json({
      success: true,
      message:
        `I couldn't find a product matching "${intent.product_query}". Please check the product name and try again.`,
      products: []
    });
  }

  if (availabilityProducts.length > 1) {
    return res.json({
      success: true,
      message:
        `I found multiple products matching "${intent.product_query}". Please provide the exact product name or select the product you mean.`,
      products: []
    });
  }

  const product = availabilityProducts[0];

  const isInStock =
    product.stock_status === "instock";

  return res.json({
    success: true,
    message: isInStock
      ? `Yes, ${product.name} is currently in stock.`
      : `No, ${product.name} is currently out of stock.`,
    products: []
  });
}

// --------------------------------------------------
// 3A. KNOWLEDGE BASE RETRIEVAL
// --------------------------------------------------

let knowledgeResults = [];

if (
  intent.needs_knowledge === true &&
  intent.knowledge_query
) {
  knowledgeResults = await searchKnowledge(
    intent.knowledge_query,
    {
      topK: 5,
      minScore: 0.45
    }
  );

  console.log(
    "KNOWLEDGE RESULTS:",
    knowledgeResults.map(result => ({
      title: result.title,
      score: Number(result.score.toFixed(4))
    }))
  );
}

if (
  intent.needs_knowledge === true &&
  intent.needs_products !== true
) {
  const knowledgeResponse = await client.responses.create({
    model: "gpt-5-mini",
    input: `
You are a customer support assistant for Perkin Knives.

Answer the customer's question using ONLY the supplied store knowledge.

Do not invent:
- policies
- fees
- dates
- procedures
- contact details
- return conditions

If the supplied knowledge does not contain the answer, say that the available store information does not specify it.

CUSTOMER QUESTION:
${message}

STORE KNOWLEDGE:
${knowledgeResults
  .map(result => `
Source: ${result.title}
${result.text}
`)
  .join("\n---\n")}
`
  });

  return res.json({
    success: true,
    message: knowledgeResponse.output_text,
    products: []
  });
}

const cheapestPreviousPrice =
  getCheapestPreviousPrice(
    previouslyShownProducts
  );


if (
  intent.comparison === "cheaper" &&
  cheapestPreviousPrice !== null
) {

  intent.max_price =
    cheapestPreviousPrice - 0.01;

  console.log(
    "CHEAPER FOLLOW-UP: NEW MAX PRICE =",
    intent.max_price
  );

}

    // --------------------------------------------------
// 3B. KNOWLEDGE-ONLY QUESTION
// --------------------------------------------------

if (
  intent.needs_knowledge === true &&
  intent.needs_products === false
) {
  const knowledgeContext = knowledgeResults
    .map((result, index) => {
      return `
SOURCE ${index + 1}
Title: ${result.title}
Source Type: ${result.source_type}
Relevance Score: ${result.score.toFixed(4)}

${result.text}
`;
    })
    .join("\n");

  const knowledgeResponse =
    await client.responses.create({
      model: "gpt-5-mini",

      input: `
You are the knowledge assistant for a knife ecommerce store.

Answer the customer's question using the supplied knowledge
evidence.

IMPORTANT RULES:

- Use the supplied evidence as the primary source.
- Do not invent store policies.
- Do not invent dates, fees, requirements, or procedures.
- If the evidence does not contain enough information, say that
  the available store information does not specify it.
- Do not use unrelated knowledge to fill missing store-policy details.
- Give a clear, natural answer.
- Do not mention embeddings, retrieval, chunks, or the knowledge base.

CUSTOMER QUESTION:
${message}

KNOWLEDGE EVIDENCE:
${knowledgeContext || "No relevant knowledge was found."}
`
    });

  return res.json({
    success: true,
    message: knowledgeResponse.output_text,
    products: []
  });
}


    // --------------------------------------------------
    // 4. CLEAN SEARCH TERMS
    // --------------------------------------------------

    const searchTerms = Array.isArray(intent.search_terms)
      ? intent.search_terms
          .filter(Boolean)
          .slice(0, 3)
      : [];


    let candidateProducts = [];


    // --------------------------------------------------
    // 5. SEARCH PRODUCTS + CATEGORIES
    // --------------------------------------------------

    for (const searchTerm of searchTerms) {

      console.log(
        "\nSEARCHING:",
        searchTerm
      );


      // --------------------------------
      // A. PRODUCT SEARCH
      // --------------------------------

      const directProducts =
        await searchProducts(searchTerm);


      candidateProducts.push(
        ...directProducts
      );


      // --------------------------------
      // B. CATEGORY SEARCH
      // --------------------------------

      const categories =
        await searchCategories(searchTerm);


      if (categories.length > 0) {

        /*
          Prefer categories whose names are
          closest to our search phrase.

          We don't blindly use every category.
        */

        const normalizedTerm =
          normalizeText(searchTerm);


        const sortedCategories =
          categories.sort((a, b) => {

            const aName =
              normalizeText(a.name);

            const bName =
              normalizeText(b.name);


            const aExact =
              aName === normalizedTerm
                ? 1
                : 0;

            const bExact =
              bName === normalizedTerm
                ? 1
                : 0;


            return bExact - aExact;

          });


        // Maximum 2 categories per search term
        const selectedCategories =
          sortedCategories.slice(0, 2);


        for (
          const category
          of selectedCategories
        ) {

          console.log(
            "CATEGORY CANDIDATE:",
            category.name
          );


          const categoryProducts =
            await getProductsByCategory(
              category.id
            );


          candidateProducts.push(
            ...categoryProducts
          );

        }

      }

    }


    // --------------------------------------------------
    // 6. REMOVE DUPLICATES
    // --------------------------------------------------

    let products =
      removeDuplicateProducts(
        candidateProducts
      );


    console.log(
      "UNIQUE CANDIDATES:",
      products.length
    );

    if (
  intent.comparison === "more" &&
  lastShownProducts.length > 0
) {
  const lastShownIds = new Set(
    lastShownProducts.map(product => Number(product.id))
  );

  products = products.filter(
    product => !lastShownIds.has(Number(product.id))
  );
}


    // --------------------------------------------------
    // 7. STOCK FILTER
    // --------------------------------------------------

    products = products.filter(
      product =>
        product.stock_status === "instock"
    );


    // --------------------------------------------------
    // 8. PRICE FILTERS
    // --------------------------------------------------

    if (
      intent.min_price !== null &&
      intent.min_price !== undefined
    ) {

      products = products.filter(
        product =>
          Number(product.price) >=
          Number(intent.min_price)
      );

    }


    if (
      intent.max_price !== null &&
      intent.max_price !== undefined
    ) {

      products = products.filter(
        product =>
          Number(product.price) <=
          Number(intent.max_price)
      );

    }


    console.log(
      "CANDIDATES AFTER FILTERS:",
      products.length
    );


    // --------------------------------------------------
    // 9. NOTHING FOUND
    // --------------------------------------------------

   if (products.length === 0) {

  // ---------------------------------------------
  // CHEAPER FOLLOW-UP: NO CHEAPER MATCH FOUND
  // ---------------------------------------------

  if (
    intent.comparison === "cheaper" &&
    cheapestPreviousProduct
  ) {

    return res.json({

      success: true,

      message:
        `I couldn't find another matching option cheaper than £${cheapestPreviousProduct.price}. ` +
        `${cheapestPreviousProduct.name} is still the cheapest matching option from my previous suggestions.`,

      products: [
        {
          ...cheapestPreviousProduct,
          is_previous_reference: true
        }
      ]

    });

  }


  // Normal no-results case

  return res.json({

    success: true,

    message:
      "I couldn't find a product that matches all of those requirements.",

    products: []

  });

}


    // --------------------------------------------------
    // 10. FORMAT CANDIDATES FOR AI
    // --------------------------------------------------

    const formattedProducts =
      products.map(product => {

        

        const cleanDescription =
          (product.description || "")
            .replace(/<[^>]*>/g, "")
            .trim();


        const cleanShortDescription =
          (product.short_description || "")
            .replace(/<[^>]*>/g, "")
            .trim();

            const attributes =
  product.attributes
    ?.map(attribute => {

      const options =
        Array.isArray(attribute.options)
          ? attribute.options.join(", ")
          : "";

      return `${attribute.name}: ${options}`;

    })
    .join(", ") || "";

        return `
Product ID:
${product.id}

Product Name:
${product.name}

Short Description:
${cleanShortDescription}

Full Description:
${cleanDescription}

Categories:
${
  product.categories
    ?.map(cat => cat.name)
    .join(", ") || ""
}

Tags:
${
  product.tags
    ?.map(tag => tag.name)
    .join(", ") || ""
}

Attributes:
${attributes}

Price:
${product.price}

Stock:
${product.stock_status}

---
`;

      }).join("\n");


    // --------------------------------------------------
    // 11. AI RANKS CANDIDATE PRODUCTS
    // --------------------------------------------------

    const response =
  await client.responses.create({

    model: "gpt-5-mini",

    input: `
You are an AI shopping assistant for a knife ecommerce store.

The retrieval system has already found possible candidate products.

The system may also provide knowledge evidence.

Knowledge evidence is supplemental information for answering
the customer's question.

IMPORTANT:
- Knowledge evidence must never override live WooCommerce data.
- WooCommerce is authoritative for product name, price, stock,
  image, URL, category, attributes and current product data.
- Knowledge evidence is authoritative for store policies and
  reference information when supplied.
- Do not use knowledge evidence to invent product specifications.

Your task is to select only products that genuinely match the customer's resolved intent.

STRICT RULES:

- ONLY select products from CANDIDATE PRODUCTS.
- NEVER invent products.
- NEVER invent Product IDs.
- NEVER invent product features.
- NEVER invent materials.
- NEVER invent specifications.

HARD REQUIREMENTS:

${JSON.stringify(intent.hard_requirements || [])}

Hard requirements are mandatory.

A product may only be recommended if the supplied WooCommerce data provides
reasonable evidence that it satisfies every hard requirement.

Evidence may come from:

- Product Name
- Short Description
- Full Description
- Categories
- Tags
- Attributes if supplied

VERY IMPORTANT:

If the customer requires something such as:

"wooden handle"

then the product must have supplied evidence of a wooden/wood handle.

Do NOT recommend uncertain products.

Never use phrases such as:

"check product page to confirm"
"verify on product page"
"may have"
"might have"
"possibly"
"appears to have"
"likely has"

If a hard requirement cannot be verified from the supplied store data,
DO NOT recommend that product.

It is better to return 0 or 1 matching product than 3 uncertain products.

PREFERENCES:

${JSON.stringify(intent.preferences || [])}

Preferences should influence ranking but do not have to be mandatory.

PRICE:

Minimum:
${intent.min_price}

Maximum:
${intent.max_price}

COMPARISON:

${intent.comparison}


CONVERSATION HISTORY:

${recentHistory}


CURRENT USER QUESTION:

${message}

KNOWLEDGE EVIDENCE:

${
  knowledgeResults.length > 0
    ? knowledgeResults
        .map((result, index) => `
SOURCE ${index + 1}
Title: ${result.title}
Source Type: ${result.source_type}
Relevance Score: ${result.score.toFixed(4)}

${result.text}
`)
        .join("\n")
    : "No relevant knowledge evidence was retrieved."
}

CANDIDATE PRODUCTS:

${formattedProducts}


Return a maximum of 5 products.

Return JSON only.

ANSWER:

If the customer's question also requires an explanation,
answer that part in "answer".

The answer must be based on the supplied knowledge evidence
when the question concerns store policy or reference information.

If no explanation is needed, return an empty string.

Do not put product price, stock, image URL, or product URL
inside the answer. Those values will be supplied separately
from WooCommerce.

Format:

{
  "answer": "",
  "products": [
    {
      "id": 123,
      "description": "Short factual reason this product matches"
    }
  ]
}
`
  });


    const parsed =
      JSON.parse(response.output_text);


    // --------------------------------------------------
    // 12. MAP AI IDs BACK TO REAL WOOCOMMERCE DATA
    // --------------------------------------------------

    const recommendedProducts =
      (parsed.products || [])
        .map(recommendation => {

          const product =
            products.find(
              product =>
                Number(product.id) ===
                Number(recommendation.id)
            );


          if (!product) {
            return null;
          }


          return {

            id:
              product.id,

            name:
              product.name,

            description:
              recommendation.description || "",

            price:
              product.price,

            url:
              product.permalink,

            image:
              product.images?.[0]?.src || "",

            stock_status:
              product.stock_status

          };

        })
        .filter(Boolean);


    // --------------------------------------------------
    // 13. SEND RESPONSE TO FRONTEND
    // --------------------------------------------------

    res.json({
      success: true,
      message: parsed.answer || "",
      products: recommendedProducts
    });


  } catch (error) {

    console.error(
      "CHAT ERROR:",
      error
    );


    res.status(500).json({

      success: false,

      error:
        error.message

    });

  }

});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});
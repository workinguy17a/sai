import path from "node:path";
import express from "express";
import OpenAI from "openai";
import dotenv from "dotenv";

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
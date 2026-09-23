import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/**
 * Converts the customer's message + recent conversation
 * into a generic retrieval plan.
 *
 * IMPORTANT:
 * This does NOT retrieve products or knowledge.
 * It only determines what information is required.
 */
export async function createRetrievalPlan({
  message,
  history = []
}) {

  const recentHistory = history
    .slice(-10)
    .map(item => {

      if (
        item.role === "assistant" &&
        Array.isArray(item.content)
      ) {
        return {
          role: "assistant",
          content: JSON.stringify(item.content)
        };
      }

      return {
        role: item.role,
        content: item.content
      };

    });

  const prompt = `
You are the retrieval planner for a universal ecommerce AI assistant.

Your job is NOT to answer the customer.

Your job is to determine what information the system needs
in order to answer the customer's latest message accurately.

The ecommerce system may have access to:

1. products
   - product catalog
   - product names
   - descriptions
   - prices
   - categories
   - attributes
   - stock information

2. knowledge
   - store policies
   - delivery information
   - returns/refunds
   - age policies
   - terms
   - guides
   - FAQs
   - other reference documents

3. conversation_products
   - products that were previously shown in this conversation

4. customer
   - customer/account information
   - orders
   - order status
   - customer-specific information

IMPORTANT:

Do not classify the customer into a growing list of intent types.

Instead determine WHAT INFORMATION IS REQUIRED.

The same customer request may require multiple sources.

Examples:

Customer:
"I want a steel knife under £100"

Required information:
- products

Customer:
"What is your return policy?"

Required information:
- knowledge

Customer:
"Compare these products"

Required information:
- conversation_products

Customer:
"Show me something cheaper than the second one"

Required information:
- conversation_products
- products

Customer:
"Where is my order?"

Required information:
- customer

Customer:
"Can I return this knife and what knives are under £100?"

Required information:
- knowledge
- products

Preserve information from the conversation when the customer
is referring to something already discussed or shown.

Do not invent product IDs.

If the customer refers to previous products, identify the
reference conceptually where possible, for example:

"second product"
"cheapest product"
"previous products"
"that knife"

The application will resolve actual product IDs later.

PRICE:

Extract explicit numeric price constraints when present.

Examples:

"under £100"
maximum price = 100

"over £50"
minimum price = 50

"between £50 and £100"
minimum price = 50
maximum price = 100

Do not invent a price constraint.

PRODUCT REQUIREMENTS:

Extract explicit characteristics that products must satisfy.

Examples:

"steel knife"
→ "steel blade"

"wooden handle"
→ "wooden handle"

"Damascus knife"
→ "Damascus"

Do not invent requirements.

PRODUCT SEARCH QUERY:

Create a concise product search query when product catalog
information is required.

Use the customer's actual product concept and important
requirements.

Do not generate unnecessary variations.

KNOWLEDGE QUERY:

Create a standalone knowledge query when knowledge is required.

It must contain enough context to search the knowledge base
without requiring the original customer message.

CONVERSATION PRODUCTS:

Set conversation_products to true when the answer depends
on products previously shown in this conversation.

CUSTOMER:

Set customer to true only when customer-specific information
is required.

REFERENCES:

References must be structured objects.

When the customer refers to products already shown:

- "these products"
- "those products"
- "compare them"
- "the products you showed"
- "previous products"

use:

{
  "type": "previous_products",
  "selector": "last_product_set"
}

When the customer refers to a specific position, use:

{
  "type": "previous_products",
  "selector": "position",
  "position": 2
}

For multiple positions, use:

{
  "type": "previous_products",
  "selector": "positions",
  "positions": [2, 3]
}

Do not describe the reference in natural-language prose.

Return JSON only.

Schema:

{
  "sources": {
    "products": false,
    "knowledge": false,
    "conversation_products": false,
    "customer": false
  },

  "product_query": "",

  "knowledge_query": "",

  "requirements": [],

  "preferences": [],

  "constraints": {
    "min_price": null,
    "max_price": null
  },

  "references": [
    {
        "type": "previous_products",
        "selector": "last_product_set"
    }
  ]

  "response_goal": ""
}

RULES:

- sources.products must be true when product catalog data is required.
- sources.knowledge must be true when knowledge-base information is required.
- sources.conversation_products must be true when previously shown products
  are required.
- sources.customer must be true when customer-specific information is required.
- Multiple sources may be true.
- requirements contain mandatory product characteristics.
- preferences contain non-mandatory preferences.
- constraints contain only explicit constraints.
- references describe things in the conversation that the answer depends on.
- response_goal briefly describes what the final response needs to accomplish.
- Do not include unsupported assumptions.
- Do not answer the customer.

CONVERSATION:

${JSON.stringify(recentHistory)}

CURRENT CUSTOMER MESSAGE:

${message}
`;

  try {

    const response = await openai.responses.create({
      model: "gpt-5.6",
      input: prompt
    });

    const raw = response.output_text?.trim();

    if (!raw) {
      throw new Error("Orchestrator returned an empty response.");
    }

    const plan = JSON.parse(raw);

    return normalizeRetrievalPlan(plan);

  } catch (error) {

    console.error(
      "ORCHESTRATOR ERROR:",
      error
    );

    throw error;
  }
}


/**
 * Keeps the orchestrator output predictable.
 *
 * This is intentionally deterministic.
 * We do not want malformed AI output propagating
 * throughout the application.
 */
function normalizeRetrievalPlan(plan = {}) {

  return {

    sources: {
      products:
        plan.sources?.products === true,

      knowledge:
        plan.sources?.knowledge === true,

      conversation_products:
        plan.sources?.conversation_products === true,

      customer:
        plan.sources?.customer === true
    },

    product_query:
      typeof plan.product_query === "string"
        ? plan.product_query.trim()
        : "",

    knowledge_query:
      typeof plan.knowledge_query === "string"
        ? plan.knowledge_query.trim()
        : "",

    requirements:
      Array.isArray(plan.requirements)
        ? plan.requirements
        : [],

    preferences:
      Array.isArray(plan.preferences)
        ? plan.preferences
        : [],

    constraints: {

      min_price:
        typeof plan.constraints?.min_price === "number"
          ? plan.constraints.min_price
          : null,

      max_price:
        typeof plan.constraints?.max_price === "number"
          ? plan.constraints.max_price
          : null
    },

    references:
    Array.isArray(plan.references)
        ? plan.references
            .filter(reference => reference?.type)
            .map(reference => ({
            type: reference.type,
            selector: reference.selector || null,
            position:
                typeof reference.position === "number"
                ? reference.position
                : null,
            positions:
                Array.isArray(reference.positions)
                ? reference.positions
                : []
            }))
        : [],

    response_goal:
      typeof plan.response_goal === "string"
        ? plan.response_goal.trim()
        : ""
  };
}
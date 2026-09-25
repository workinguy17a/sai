import axios from "axios";
import { pool } from "./databaseService.js";
import { decryptCredentials } from "./credentialCryptoService.js";

async function getStoreConnection(storeId) {
  const result = await pool.query(
    `SELECT stores.website_url, store_integrations.credentials_encrypted
     FROM stores
     JOIN store_integrations
       ON store_integrations.store_id = stores.id
     WHERE stores.id = $1
       AND store_integrations.platform = 'woocommerce'`,
    [storeId]
  );

  const store = result.rows[0];

  if (!store) {
    throw new Error(`WooCommerce connection not found for store ${storeId}.`);
  }

  const credentials = decryptCredentials(
    store.credentials_encrypted
  );

  const storeRoot = store.website_url.replace(/\/+$/, "");

  return {
    baseURL: `${storeRoot}/wp-json/wc/v3`,
    auth: {
      username: credentials.consumerKey,
      password: credentials.consumerSecret
    }
  };
}

// const baseURL =
//   "https://perkinknives.net/wp-json/wc/v3";


// --------------------------------------------------
// AUTH
// --------------------------------------------------
// Important:
// Read environment variables when the function runs,
// NOT when this module is first imported.

// function getAuth() {

//   return {
//     username: process.env.WC_KEY,
//     password: process.env.WC_SECRET
//   };

// }



// --------------------------------------------------
// SEARCH PRODUCTS
// --------------------------------------------------

export async function searchProducts(storeId, searchTerm) {

  try {

    const connection = await getStoreConnection(storeId);

    const response = await axios.get(
      `${connection.baseURL}/products`,
      {
        auth: connection.auth,

        params: {
          search: searchTerm,
          per_page: 30,
          status: "publish"
        }
      }
    );


    console.log(
      `PRODUCT SEARCH "${searchTerm}": ${response.data.length}`
    );


    return response.data;

  } catch (error) {

    console.error(
      "WooCommerce Product Search Error:",
      error.response?.data || error.message
    );

    return [];
  }

}

export async function searchSaleProducts(storeId) {
  try {
    const connection = await getStoreConnection(storeId);
    const response = await axios.get(
      `${connection.baseURL}/products`,
      {
        auth: connection.auth,
        params: {
          on_sale: true,
          per_page: 30,
          status: "publish"
        }
      }
    );

    console.log(`SALE PRODUCT SEARCH: ${response.data.length}`);

    return response.data;
  } catch (error) {
    console.error(
      "WooCommerce Sale Product Search Error:",
      error.response?.data || error.message
    );

    return [];
  }
}

export async function getStoreCurrency(storeId) {
  try {
    const connection = await getStoreConnection(storeId);
    const response = await axios.get(
      `${connection.baseURL}/data/currencies/current`,
      { auth: connection.auth }
    );

    return response.data;
  } catch (error) {
    console.error(
      "WooCommerce Currency Lookup Error:",
      error.response?.data || error.message
    );

    return null;
  }
}



// --------------------------------------------------
// SEARCH CATEGORIES
// --------------------------------------------------

export async function searchCategories(storeId, searchTerm) {

  try {
    const connection = await getStoreConnection(storeId);
    const response = await axios.get(
      `${connection.baseURL}/products/categories`,
      {
        auth: connection.auth,

        params: {
          search: searchTerm,
          per_page: 20,
          hide_empty: true
        }
      }
    );


    console.log(
      `CATEGORY SEARCH "${searchTerm}":`,
      response.data.map(category => ({
        id: category.id,
        name: category.name
      }))
    );


    return response.data;

  } catch (error) {

    console.error(
      "WooCommerce Category Search Error:",
      error.response?.data || error.message
    );

    return [];
  }

}


// --------------------------------------------------
// GET PRODUCTS FROM CATEGORY
// --------------------------------------------------

export async function getProductsByCategory(storeId, categoryId) {

  try {
    const connection = await getStoreConnection(storeId);
    const response = await axios.get(
      `${connection.baseURL}/products`,
      {
        auth: connection.auth,

        params: {
          category: categoryId,
          per_page: 30,
          status: "publish"
        }
      }
    );


    console.log(
      `CATEGORY PRODUCTS ${categoryId}: ${response.data.length}`
    );


    return response.data;

  } catch (error) {

    console.error(
      "WooCommerce Category Product Error:",
      error.response?.data || error.message
    );

    return [];
  }

}

export async function findOrderByNumberAndEmail(
  storeId,
  orderNumber,
  email
) {
  const normalizedOrderNumber = String(orderNumber || "").trim();
  const normalizedEmail = String(email || "").trim().toLowerCase();

  if (!normalizedOrderNumber || !normalizedEmail) {
    return null;
  }
  const connection = await getStoreConnection(storeId);
  
  const response = await axios.get(
    `${connection.baseURL}/orders`,
    {
      auth: connection.auth,
      params: {
        search: normalizedOrderNumber,
        per_page: 100
      }
    }
  );

  const order = response.data.find(item =>
    String(item.number || "").trim() === normalizedOrderNumber &&
    String(item.billing?.email || "").trim().toLowerCase() === normalizedEmail
  );

  if (!order) {
    return null;
  }

  return {
    number: order.number,
    status: order.status,
    date_created: order.date_created,
    total: order.total,
    currency: order.currency,
    items: (order.line_items || []).map(item => ({
      name: item.name,
      quantity: item.quantity
    }))
  };
}
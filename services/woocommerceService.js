import axios from "axios";

const baseURL =
  "https://perkinknives.net/wp-json/wc/v3";


// --------------------------------------------------
// AUTH
// --------------------------------------------------
// Important:
// Read environment variables when the function runs,
// NOT when this module is first imported.

function getAuth() {

  return {
    username: process.env.WC_KEY,
    password: process.env.WC_SECRET
  };

}


// --------------------------------------------------
// SEARCH PRODUCTS
// --------------------------------------------------

export async function searchProducts(searchTerm) {

  try {

    const response = await axios.get(
      `${baseURL}/products`,
      {
        auth: getAuth(),

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




// --------------------------------------------------
// SEARCH CATEGORIES
// --------------------------------------------------

export async function searchCategories(searchTerm) {

  try {

    const response = await axios.get(
      `${baseURL}/products/categories`,
      {
        auth: getAuth(),

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

export async function getProductsByCategory(categoryId) {

  try {

    const response = await axios.get(
      `${baseURL}/products`,
      {
        auth: getAuth(),

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
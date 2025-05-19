

// shopify/syncProduct.js

const express = require('express');
const axios = require('axios');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_HOST } = process.env;

// Assume accessTokens is imported or available in scope
const accessTokens = require('../index').accessTokens || {}; // Adjust as needed

/**
 * Helper: Find product by SKU in Shopify
 */
async function findProductBySKU(shop, accessToken, sku) {
  const query = `
    {
      products(first: 1, query: "sku:${sku}") {
        edges {
          node {
            id
            title
            variants(first: 10) {
              edges {
                node {
                  id
                  sku
                  inventoryItem {
                    id
                    inventoryLevels(first: 1) {
                      edges {
                        node {
                          id
                          available
                          location {
                            id
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;
  const resp = await axios.post(
    `https://${shop}/admin/api/2023-10/graphql.json`,
    { query },
    {
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      }
    }
  );
  const edges = resp.data.data.products.edges;
  return edges.length > 0 ? edges[0].node : null;
}

/**
 * Helper: Update inventory for a variant
 */
async function updateInventory(shop, accessToken, inventoryItemId, available) {
  // You need to get the locationId for your store. For demo, we fetch the first location.
  const locResp = await axios.get(
    `https://${shop}/admin/api/2023-10/locations.json`,
    {
      headers: {
        'X-Shopify-Access-Token': accessToken,
      }
    }
  );
  const locationId = locResp.data.locations[0].id;

  // Set inventory level
  await axios.post(
    `https://${shop}/admin/api/2023-10/inventory_levels/set.json`,
    {
      location_id: locationId,
      inventory_item_id: inventoryItemId,
      available,
    },
    {
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      }
    }
  );
}

/**
 * Helper: Create product in Shopify
 */
async function createProduct(shop, accessToken, productData) {
  // Map your productData to Shopify's expected structure
  const { title, description, price, compare_price, unit_price, stock_quantity, sku, media, attributes } = productData;

  // Build variants
  const variants = [
    {
      price: price,
      compareAtPrice: compare_price,
      sku: sku,
      inventoryQuantity: stock_quantity,
      // Add more fields as needed
    }
  ];

  // Build options (from attributes)
  const options = attributes.map(attr => attr.name);

  // Build images
  const images = media.map(m => ({
    src: m.media.startsWith('http') ? m.media : `${SHOPIFY_HOST}${m.media}`,
    // Optionally, set position or alt
  }));

  // GraphQL mutation for product creation
  const mutation = `
    mutation productCreate($input: ProductInput!) {
      productCreate(input: $input) {
        product {
          id
          title
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    input: {
      title: title,
      bodyHtml: description,
      variants: variants,
      options: options,
      images: images,
      // Add more fields as needed
    }
  };

  const resp = await axios.post(
    `https://${shop}/admin/api/2023-10/graphql.json`,
    { query: mutation, variables },
    {
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      }
    }
  );
  return resp.data;
}

/**
 * Main endpoint: POST /shopify/sync-product
 */
router.post('/shopify/sync-product', async (req, res) => {
  const { shop, product } = req.body;
  const accessToken = accessTokens[shop];

  if (!accessToken) return res.status(401).json({ error: 'Unauthorized: no token' });

  try {
    // 1. Try to find product by SKU
    const existingProduct = await findProductBySKU(shop, accessToken, product.sku);

    if (existingProduct) {
      // Product exists: update inventory
      const variant = existingProduct.variants.edges.find(
        v => v.node.sku === product.sku
      );
      if (variant) {
        await updateInventory(
          shop,
          accessToken,
          variant.node.inventoryItem.id,
          product.stock_quantity
        );
        return res.json({ message: 'Product exists, inventory updated', productId: existingProduct.id });
      }
    }

    // 2. Product does not exist: create it
    const createResp = await createProduct(shop, accessToken, product);
    if (createResp.data.productCreate.userErrors.length > 0) {
      return res.status(400).json({ errors: createResp.data.productCreate.userErrors });
    }
    return res.json({ message: 'Product created', product: createResp.data.productCreate.product });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to sync product', details: err.message });
  }
});

module.exports = router;


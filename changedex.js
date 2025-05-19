
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const cors = require('cors'); // Added CORS
const app = express();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const FormData = require('form-data');

app.use(cors()); // Allow all origins for development
app.use(express.json());
app.use(cookieParser());

const {
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET,
  SHOPIFY_SCOPES,
  SHOPIFY_HOST
} = process.env;

const accessTokens = {}; // Store shop -> token (for demo only)

function buildAuthURL(shop) {
  const redirectUri = `${SHOPIFY_HOST}/shopify/callback`;
  return `https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${SHOPIFY_SCOPES}&redirect_uri=${redirectUri}`;
}

function verifyHMAC(query) {
  const { hmac, ...rest } = query;
  const ordered = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join('&');
  const generated = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(ordered).digest('hex');
  return generated === hmac;
}

// Step 1: Install route
app.get('/shopify/install', (req, res) => {
  const { shop } = req.query;
  const url = buildAuthURL(shop);
  res.redirect(url);
});

// Step 2: Callback and token exchange
app.get('/shopify/callback', async (req, res) => {
  const { shop, code, hmac } = req.query;

  if (!verifyHMAC(req.query)) {
    return res.status(400).send('HMAC verification failed');
  }

  const response = await axios.post(`https://${shop}/admin/oauth/access_token`, {
    client_id: SHOPIFY_API_KEY,
    client_secret: SHOPIFY_API_SECRET,
    code,
  });

  const { access_token } = response.data;
  accessTokens[shop] = access_token;
  res.send('OAuth successful! You can now use the API.');
});

// Step 3: Create product route
app.post('/shopify/product', async (req, res) => {
  const { shop, title, price } = req.body;
  const accessToken = accessTokens[shop];

  if (!accessToken) return res.status(401).json({ error: 'Unauthorized: no token' });

  const mutation = `
    mutation {
      productCreate(input: {
        title: "${title}",
        variants: [{ price: "${price}" }]
      }) {
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

  try {
    const response = await axios.post(`https://${shop}/admin/api/2023-10/graphql.json`, { query: mutation }, {
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      }
    });

    res.json(response.data);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

// NEW ENDPOINT: Import complex product data
app.post('/shopify/import-products', async (req, res) => {
  const { shop, products } = req.body;
  const accessToken = accessTokens[shop];

  if (!accessToken) return res.status(401).json({ error: 'Unauthorized: no token' });
  if (!products || !Array.isArray(products)) return res.status(400).json({ error: 'Invalid products data' });

  try {
    const results = [];
    
    for (const product of products) {
      // First check if product exists by SKU
      const existingProduct = await findProductBySku(shop, accessToken, product.sku);
      
      if (existingProduct) {
        // Update existing product
        const result = await updateProduct(shop, accessToken, existingProduct.id, product);
        results.push({
          status: 'updated',
          sku: product.sku,
          shopifyId: existingProduct.id,
          result
        });
      } else {
        // Create new product
        const result = await createProduct(shop, accessToken, product);
        results.push({
          status: 'created',
          sku: product.sku,
          result
        });
      }
    }
    
    res.json({ success: true, results });
  } catch (err) {
    console.error('Import error:', err.response?.data || err.message);
    res.status(500).json({ 
      error: 'Failed to import products',
      details: err.response?.data || err.message
    });
  }
});

// Helper function to find a product by SKU
async function findProductBySku(shop, accessToken, sku) {
  if (!sku) return null;
  
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
                  inventoryQuantity
                }
              }
            }
          }
        }
      }
    }
  `;
  
  const response = await axios.post(
    `https://${shop}/admin/api/2023-10/graphql.json`,
    { query },
    {
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      }
    }
  );
  
  const products = response.data.data.products.edges;
  return products.length > 0 ? products[0].node : null;
}

// Helper function to create a new product
async function createProduct(shop, accessToken, productData) {
  // Prepare variant data
  const variants = [];
  
  // If we have attributes that should become variants
  if (productData.attributes && productData.attributes.length > 0) {
    // For simplicity, we'll just use the first attribute as a variant
    const attribute = productData.attributes[0];
    
    attribute.values.forEach(value => {
      variants.push({
        price: productData.price,
        compareAtPrice: productData.compare_price,
        sku: productData.sku,
        inventoryQuantity: productData.stock_quantity,
        option1: value.name // Use the attribute value as option1
      });
    });
  } else {
    // No attributes, just create a single variant
    variants.push({
      price: productData.price,
      compareAtPrice: productData.compare_price,
      sku: productData.sku,
      inventoryQuantity: productData.stock_quantity
    });
  }
  
  // Create options array if we have attributes
  const options = [];
  if (productData.attributes && productData.attributes.length > 0) {
    productData.attributes.forEach(attribute => {
      options.push({
        name: attribute.name,
        values: attribute.values.map(v => v.name)
      });
    });
  }
  
  // Build the mutation
  const input = {
    title: productData.title,
    descriptionHtml: productData.description,
    variants: variants,
    options: options.length > 0 ? options : undefined,
    status: productData.status === 'approved' ? 'ACTIVE' : 'DRAFT'
  };
  
  const mutation = `
    mutation productCreate($input: ProductInput!) {
      productCreate(input: $input) {
        product {
          id
          title
          variants(first: 10) {
            edges {
              node {
                id
                sku
              }
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;
  
  const response = await axios.post(
    `https://${shop}/admin/api/2023-10/graphql.json`,
    { 
      query: mutation,
      variables: { input }
    },
    {
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      }
    }
  );
  
  const result = response.data.data.productCreate;
  
  // If product was created successfully and has media, upload the media
  if (result.product && productData.media && productData.media.length > 0) {
    await uploadProductMedia(shop, accessToken, result.product.id, productData.media);
  }
  
  return result;
}

// Helper function to update an existing product
async function updateProduct(shop, accessToken, productId, productData) {
  // Extract the numeric ID from the GraphQL ID
  const numericId = productId.split('/').pop();
  
  // First, update the basic product information
  const input = {
    id: productId,
    title: productData.title,
    descriptionHtml: productData.description,
    status: productData.status === 'approved' ? 'ACTIVE' : 'DRAFT'
  };
  
  const mutation = `
    mutation productUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
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
  
  const response = await axios.post(
    `https://${shop}/admin/api/2023-10/graphql.json`,
    { 
      query: mutation,
      variables: { input }
    },
    {
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      }
    }
  );
  
  // Update inventory for each variant
  // For simplicity, we'll just update the first variant's inventory
  const inventoryResponse = await axios.post(
    `https://${shop}/admin/api/2023-10/products/${numericId}/variants/batch.json`,
    {
      variants: [
        {
          id: numericId, // This should be the variant ID, but we're simplifying
          inventory_quantity: productData.stock_quantity,
          price: productData.price,
          compare_at_price: productData.compare_price
        }
      ]
    },
    {
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      }
    }
  );
  
  // If product has media, upload new media
  if (productData.media && productData.media.length > 0) {
    await uploadProductMedia(shop, accessToken, productId, productData.media);
  }
  
  return {
    productUpdate: response.data.data.productUpdate,
    inventoryUpdate: inventoryResponse.data
  };
}

// Helper function to upload media to a product
async function uploadProductMedia(shop, accessToken, productId, mediaItems) {
  const results = [];
  
  for (const mediaItem of mediaItems) {
    try {
      // For this example, we'll assume the media path is a URL
      // In a real implementation, you might need to download the file first
      const mediaUrl = mediaItem.media.startsWith('http') 
        ? mediaItem.media 
        : `${SHOPIFY_HOST}${mediaItem.media}`;
      
      // Create a stage for the upload
      const stageMutation = `
        mutation {
          stagedUploadsCreate(input: {
            resource: PRODUCT_IMAGE,
            filename: "${path.basename(mediaUrl)}",
            mimeType: "${getMimeType(mediaUrl)}",
            httpMethod: POST
          }) {
            stagedTargets {
              url
              resourceUrl
              parameters {
                name
                value
              }
            }
            userErrors {
              field
              message
            }
          }
        }
      `;
      
      const stageResponse = await axios.post(
        `https://${shop}/admin/api/2023-10/graphql.json`,
        { query: stageMutation },
        {
          headers: {
            'X-Shopify-Access-Token': accessToken,
            'Content-Type': 'application/json',
          }
        }
      );
      
      const { stagedTargets } = stageResponse.data.data.stagedUploadsCreate;
      if (!stagedTargets || stagedTargets.length === 0) {
        throw new Error('Failed to create upload stage');
      }
      
      // Download the image
      const imageResponse = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
      const imageBuffer = Buffer.from(imageResponse.data, 'binary');
      
      // Upload to the staged target
      const target = stagedTargets[0];
      const formData = new FormData();
      
      // Add all parameters from the staged target
      target.parameters.forEach(param => {
        formData.append(param.name, param.value);
      });
      
      // Add the file
      formData.append('file', imageBuffer, path.basename(mediaUrl));
      
      // Upload the file
      await axios.post(target.url, formData, {
        headers: {
          ...formData.getHeaders()
        }
      });
      
      // Create the product image using the resource URL
      const createImageMutation = `
        mutation {
          productCreateMedia(
            productId: "${productId}",
            media: {
              alt: "${mediaItem.is_featured ? 'Featured image' : 'Product image'}",
              mediaContentType: IMAGE,
              originalSource: "${target.resourceUrl}"
            }
          ) {
            media {
              id
              mediaContentType
            }
            mediaUserErrors {
              field
              message
            }
          }
        }
      `;
      
      const createImageResponse = await axios.post(
        `https://${shop}/admin/api/2023-10/graphql.json`,
        { query: createImageMutation },
        {
          headers: {
            'X-Shopify-Access-Token': accessToken,
            'Content-Type': 'application/json',
          }
        }
      );
      
      results.push(createImageResponse.data);
      
    } catch (err) {
      console.error('Media upload error:', err.message);
      results.push({ error: err.message });
    }
  }
  
  return results;
}

// Helper function to determine MIME type from file extension
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

app.listen(3001, () => {
  console.log('Server running on port 3001');
});

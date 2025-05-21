
const express = require('express');
const axios = require('axios');
const router = express.Router();
const accessTokens = require('../lib/tokenStore');

// Set the base image URL for local Django server
const base_image_url = 'http://localhost:8000';

// Normalize input to a unified product structure
function normalizeProductInput(input) {
  // If attributes is an array of objects with 'values' arrays, treat as sample
  if (
    Array.isArray(input.attributes) &&
    input.attributes.length > 0 &&
    input.attributes[0].values &&
    Array.isArray(input.attributes[0].values)
  ) {
    // Sample object
    return {
      ...input,
      attributes: input.attributes.map(attr => ({
        name: attr.name,
        values: attr.values.map(val => val.name)
      })),
      // Flatten media from both product and attribute values
      media: [
        ...(input.media || []),
        ...input.attributes.flatMap(attr =>
          attr.values.flatMap(val =>
            (val.images || []).map(img => ({
              media: img.image
            }))
          )
        )
      ]
    };
  } else {
    // Product object (already flat)
    return {
      ...input,
      attributes: input.attributes || [],
      media: input.media || []
    };
  }
}

// Helper to extract options and variants from product JSON
function buildOptionsAndVariants(product) {
  const options = product.attributes.map(attr => attr.name);

  function cartesian(arr) {
    if (arr.length === 0) return [[]];
    return arr.reduce((a, b) =>
      a.flatMap(d => b.map(e => [].concat(d, e)))
    );
  }
  const valuesList = product.attributes.map(attr => attr.values);
  const combinations = cartesian(valuesList);

  const variants = combinations.map((combo) => {
    return {
      price: product.price,
      options: combo
    };
  });

  return { options, variants };
}

// Helper to build media array for mutation, prefixing image URLs
function buildMedia(product) {
  if (!product.media) return [];
  return product.media.map(m => ({
    mediaContentType: 'IMAGE',
    originalSource: m.media.startsWith('http') ? m.media : `${base_image_url}${m.media}`
  }));
}

// Helper to escape strings for GraphQL
function gqlEscape(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

router.post('/create', async (req, res) => {
  const { shop, product } = req.body;
  const accessToken = accessTokens[shop];

  if (!product) {
    return res.status(400).json({ error: 'Product JSON is required' });
  }

  // Normalize input for both product and sample object types
  const normalizedProduct = normalizeProductInput(product);

  const { options, variants } = buildOptionsAndVariants(normalizedProduct);
  const media = buildMedia(normalizedProduct);

  // Build GraphQL mutation string (without media)
  const mutation = `
mutation {
  productCreate(
    input: {
      title: "${gqlEscape(normalizedProduct.title)}",
      options: [${options.map(o => `"${gqlEscape(o)}"`).join(', ')}],
      variants: [
        ${variants.map(variant => `{
          price: "${variant.price}",
          options: [${variant.options.map(opt => `"${gqlEscape(opt)}"`).join(', ')}]
        }`).join(',\n        ')}
      ]
    }
  ) {
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
    // Step 1: Create the product
    const response = await axios.post(
      `https://${shop}/admin/api/2024-04/graphql.json`,
      { query: mutation },
      {
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json'
        }
      }
    );

    const productData = response.data.data.productCreate;
    if (productData.userErrors && productData.userErrors.length > 0) {
      return res.status(400).json({ errors: productData.userErrors });
    }

    // Step 2: Attach media if present
    if (media.length > 0 && productData.product && productData.product.id) {
      const mediaMutation = `
mutation {
  productCreateMedia(
    productId: "${productData.product.id}",
    media: [
      ${media.map(m => `{
        mediaContentType: ${m.mediaContentType},
        originalSource: "${gqlEscape(m.originalSource)}"
      }`).join(',\n      ')}
    ]
  ) {
    media {
      ... on MediaImage {
        id
        status
      }
    }
    mediaUserErrors {
      field
      message
    }
  }
}
      `;
      const mediaResponse = await axios.post(
        `https://${shop}/admin/api/2024-04/graphql.json`,
        { query: mediaMutation },
        {
          headers: {
            'X-Shopify-Access-Token': accessToken,
            'Content-Type': 'application/json'
          }
        }
      );
      return res.status(200).json({
        product: productData.product,
        media: mediaResponse.data.data.productCreateMedia
      });
    }

    return res.status(200).json({ product: productData.product });
  } catch (error) {
    if (error.response) {
      return res.status(error.response.status || 500).json({
        error: error.response.data,
        message: error.response.data.errors || error.response.data.message || 'Shopify API error'
      });
    } else {
      return res.status(500).json({
        error: error.message || 'Unknown error'
      });
    }
  }
});

module.exports = router;

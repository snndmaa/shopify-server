
const express = require('express');
const axios = require('axios');
const router = express.Router();
const accessTokens = require('../lib/tokenStore');

// Set the base image URL for local Django server
const base_image_url = 'http://localhost:8000';

// Normalize input to a unified product structure
function normalizeProductInput(input) {
  // Check if this is the new format with nested sample
  if (input.sample && input.sample.sample_attributes) {
    // Extract data from the nested structure
    const sample = input.sample;
    
    // Transform sample_attributes to flat attributes structure
    const attributes = sample.sample_attributes.map(attr => ({
      name: attr.name,
      values: attr.values.map(val => ({
        name: val.name,
        price: val.price,
        compare_price: val.compare_price,
        sku: val.sku,
        images: val.images
      }))
    }));

    // Extract media from sample_media and attribute value images
    const media = [
      ...(sample.sample_media || []).map(m => ({
        media: m.media,
        is_featured: m.is_featured
      })),
      ...attributes.flatMap(attr =>
        attr.values.flatMap(val =>
          (val.images || []).map(img => ({
            media: img.image
          }))
        )
      )
    ];

    // Generate tags from various sources
    const tags = ['spade-product'];
    
    // Add explicit tags if provided
    if (input.tags) {
      tags.push(...(Array.isArray(input.tags) ? input.tags : [input.tags]));
    }
    
    // Add store name as tag if available
    if (input.store && input.store.name) {
      tags.push(input.store.name);
    }
    
    // Add manufacturer as tag if available
    if (sample.manufacturer && sample.manufacturer.first_name) {
      tags.push(`${sample.manufacturer.first_name} ${sample.manufacturer.last_name}`.trim());
    }
    
    // Add attribute names as tags
    attributes.forEach(attr => {
      tags.push(attr.name);
    });
    
    // Add product name/title as tag
    if (input.name) {
      tags.push(input.name);
    }

    return {
      id: input.id,
      title: input.name || sample.title,
      description: input.description || sample.description,
      attributes: attributes,
      media: media,
      stock: input.stock,
      is_active: input.is_active,
      price_range: input.price_range,
      tags: [...new Set(tags)] // Remove duplicates
    };
  } 
  // Handle old format or already normalized input
  else if (Array.isArray(input.attributes)) {
    return {
      ...input,
      attributes: input.attributes.map(attr => ({
        name: attr.name,
        values: Array.isArray(attr.values) && typeof attr.values[0] === 'object' 
          ? attr.values 
          : attr.values.map(val => ({ name: val }))
      })),
      media: input.media || [],
      tags: input.tags || []
    };
  }
  // Default case
  else {
    return {
      ...input,
      attributes: input.attributes || [],
      media: input.media || [],
      tags: input.tags || []
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

  // Extract just the value objects for cartesian product
  const valuesList = product.attributes.map(attr => attr.values);
  const combinations = cartesian(valuesList);

  const variants = combinations.map((combo) => {
    // Calculate price for this variant combination
    // Use the maximum price from the selected attribute values
    const variantPrice = Math.max(...combo.map(val => 
      parseFloat(val.price || product.price || '0')
    ));

    // Extract SKUs if available
    const skus = combo.map(val => val.sku).filter(Boolean);
    const sku = skus.length > 0 ? skus.join('-') : undefined;

    return {
      price: variantPrice.toFixed(2),
      sku: sku,
      options: combo.map(val => val.name)
    };
  });

  return { options, variants };
}

// Helper to build media array for mutation, prefixing image URLs
function buildMedia(product) {
  if (!product.media || product.media.length === 0) return [];
  
  return product.media.map(m => {
    let mediaUrl = m.media || m.image || '';
    
    // Check if URL is already complete
    if (!mediaUrl.startsWith('http')) {
      // Handle relative URLs
      if (mediaUrl.startsWith('/media/')) {
        mediaUrl = `${base_image_url}${mediaUrl}`;
      } else {
        mediaUrl = `${base_image_url}/${mediaUrl}`;
      }
    }
    
    return {
      mediaContentType: 'IMAGE',
      originalSource: mediaUrl
    };
  });
}

// Helper to escape strings for GraphQL
function gqlEscape(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Helper to format tags for GraphQL
function formatTags(tags) {
  if (!tags || tags.length === 0) return '';
  
  // Ensure tags is an array
  const tagArray = Array.isArray(tags) ? tags : [tags];
  
  // Clean and format tags
  const cleanedTags = tagArray
    .filter(tag => tag && tag.trim()) // Remove empty tags
    .map(tag => gqlEscape(tag.trim())); // Trim and escape each tag
  
  if (cleanedTags.length === 0) return '';
  
  return `tags: [${cleanedTags.map(tag => `"${tag}"`).join(', ')}],`;
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

  // Build GraphQL mutation string
  const mutation = `
mutation {
  productCreate(
    input: {
      title: "${gqlEscape(normalizedProduct.title)}",
      ${normalizedProduct.description ? `descriptionHtml: "${gqlEscape(normalizedProduct.description)}",` : ''}
      ${normalizedProduct.is_active !== undefined ? `status: ${normalizedProduct.is_active ? 'ACTIVE' : 'DRAFT'},` : ''}
      ${formatTags(normalizedProduct.tags)}
      options: [${options.map(o => `"${gqlEscape(o)}"`).join(', ')}],
      variants: [
        ${variants.map(variant => `{
          price: "${variant.price}",
          ${variant.sku ? `sku: "${gqlEscape(variant.sku)}",` : ''}
          options: [${variant.options.map(opt => `"${gqlEscape(opt)}"`).join(', ')}]
        }`).join(',\n        ')}
      ]
    }
  ) {
    product {
      id
      title
      status
      tags
      variants(first: 100) {
        edges {
          node {
            id
            title
            price
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
    let mediaResponse = null;
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
        image {
          url
        }
      }
    }
    mediaUserErrors {
      field
      message
    }
  }
}
      `;
      
      try {
        const mediaRes = await axios.post(
          `https://${shop}/admin/api/2024-04/graphql.json`,
          { query: mediaMutation },
          {
            headers: {
              'X-Shopify-Access-Token': accessToken,
              'Content-Type': 'application/json'
            }
          }
        );
        mediaResponse = mediaRes.data.data.productCreateMedia;
      } catch (mediaError) {
        console.error('Media upload error:', mediaError.response?.data || mediaError.message);
        // Continue even if media upload fails
      }
    }

    // Return comprehensive response
    return res.status(200).json({
      product: productData.product,
      media: mediaResponse,
      source_data: {
        original_id: normalizedProduct.id,
        price_range: normalizedProduct.price_range,
        stock: normalizedProduct.stock,
        tags: normalizedProduct.tags
      }
    });
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

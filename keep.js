
const express = require('express');
const axios = require('axios');
const router = express.Router();
const accessTokens = require('../lib/tokenStore');

router.post('/create', async (req, res) => {
  const shop = req.body.shop;
  const accessToken = accessTokens[shop];

  const query = `
mutation {
  productCreate(
    input: {
      title: "T-shirt",
      options: ["Color", "Size"],
      variants: [
        {
          price: "19.99",
          options: ["Red", "M"],
          mediaSrc: ["https://cdn.come/red_t_shirt.jpg"]
        },
        {
          price: "19.99",
          options: ["Red", "L"],
          mediaSrc: ["https://cdn.come/red_t_shirt.jpg"]
        },
        {
          price: "21.99",
          options: ["Yellow", "M"],
          mediaSrc: ["https://cdn.come/yellow_t_shirt.jpg"]
        },
        {
          price: "21.99",
          options: ["Yellow", "L"],
          mediaSrc: ["https://cdn.come/yellow_t_shirt.jpg"]
        }
      ]
    },
    media: [
      {
        mediaContentType: IMAGE,
        originalSource: "https://cdn.come/red_t_shirt.jpg"
      },
      {
        mediaContentType: IMAGE,
        originalSource: "https://cdn.come/yellow_t_shirt.jpg"
      }
    ]
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
    const response = await axios.post(
      `https://${shop}/admin/api/2024-04/graphql.json`,
      { query },
      {
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json'
        }
      }
    );
    // Return the API response as JSON
    return res.status(200).json(response.data);
  } catch (error) {
    // Return error details as JSON
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

module.exports = router
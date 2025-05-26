
const express = require('express');
const axios = require('axios');
const router = express.Router();
const accessTokens = require('../lib/tokenStore');

router.get('/spade', async (req, res) => {
  const { shop } = req.query;
  const accessToken = accessTokens[shop];

  if (!accessToken) {
    return res.status(401).send('Unauthorized: No access token found for this shop');
  }

  const graphqlQuery = `
    query getSpadeOrders($first: Int!, $query: String!) {
      orders(first: $first, query: $query) {
        edges {
          node {
            id
            name
            createdAt
            displayFinancialStatus
            displayFulfillmentStatus
            totalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            customer {
              id
              email
              firstName
              lastName
            }
            lineItems(first: 10) {
              edges {
                node {
                  id
                  title
                  quantity
                  variant {
                    id
                    title
                    price
                  }
                }
              }
            }
            tags
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  try {
    const response = await axios.post(
      `https://${shop}/admin/api/2023-10/graphql.json`,
      {
        query: graphqlQuery,
        variables: {
          first: 100,
          query: 'tag:spade-order'
        }
      },
      {
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json'
        }
      }
    );

    if (response.data.errors) {
      console.error('GraphQL errors:', response.data.errors);
      return res.status(400).json({ errors: response.data.errors });
    }

    // Extract orders from GraphQL response structure
    const orders = response.data.data.orders.edges.map(edge => edge.node);
    
    res.json(orders);
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).send('Internal Server Error');
  }
});

module.exports = router;

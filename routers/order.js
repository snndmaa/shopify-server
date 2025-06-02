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
    query OrdersWithSpadeOrderTag($first: Int!) {
      orders(first: $first, query: "tag:spade-order") {
        nodes {
          id
          name
          tags
          createdAt
          updatedAt
          processedAt
          displayFinancialStatus
          displayFulfillmentStatus
          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          subtotalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          totalTaxSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          totalShippingPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          totalDiscountsSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          currencyCode
          customer {
            id
            email
            firstName
            lastName
            phone
            tags
          }
          billingAddress {
            address1
            address2
            city
            province
            country
            zip
            phone
            name
          }
          shippingAddress {
            address1
            address2
            city
            province
            country
            zip
            phone
            name
          }
          lineItems(first: 50) {
            nodes {
              id
              title
              quantity
              sku
              vendor
              product {
                id
                title
                tags
              }
              variant {
                id
                title
                price
              }
              originalUnitPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
            }
          }
          fulfillments(first: 10) {
            id
            status
            trackingInfo {
              number
              url
            }
          }
          metafields(first: 10) {
            edges {
              node {
                namespace
                key
                value
              }
            }
          }
          note
          paymentGatewayNames
          test
          totalWeight
          totalTipReceivedSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          refunds(first: 10) {
            id
            createdAt
            note
            refundLineItems(first: 10) {
              nodes {
                lineItem {
                  id
                }
              }
            }
          }
          shippingLines(first: 10) {
            nodes {
              code
              originalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              discountedPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
            }
          }
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
          first: 50
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

    // Extract orders from GraphQL response structure - now using nodes instead of edges
    const orders = response.data.data.orders.nodes;
    
    res.json(orders);
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).send('Internal Server Error');
  }
});

module.exports = router;
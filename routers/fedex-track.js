const express = require('express');
const router = express.Router();
const axios = require('axios');
const accessTokens = require('../lib/tokenStore');

const {
  FEDEX_CLIENT_ID,
  FEDEX_CLIENT_SECRET,
  FEDEX_SANDBOX_CLIENT_ID,
  FEDEX_SANDBOX_CLIENT_SECRET,
  USE_FEDEX_SANDBOX,
} = process.env;

const isSandbox = USE_FEDEX_SANDBOX === 'true';
const BASE_URL = isSandbox ? 'https://apis-sandbox.fedex.com' : 'https://apis.fedex.com';
const CLIENT_ID = isSandbox ? FEDEX_SANDBOX_CLIENT_ID : FEDEX_CLIENT_ID;
const CLIENT_SECRET = isSandbox ? FEDEX_SANDBOX_CLIENT_SECRET : FEDEX_CLIENT_SECRET;

// Helper function to find Shopify order by tracking number
async function findOrderByTrackingNumber(shop, trackingNumber) {
  const accessToken = accessTokens[shop];
  if (!accessToken) {
    throw new Error('No access token found for shop');
  }

  const graphqlQuery = `
    query FindOrderByTrackingNumber($query: String!) {
      orders(first: 50, query: $query) {
        nodes {
          id
          name
          displayFulfillmentStatus
          fulfillments(first: 10) {
            id
            status
            trackingInfo {
              number
              url
            }
          }
        }
      }
    }
  `;

  const response = await axios.post(
    `https://${shop}/admin/api/2023-10/graphql.json`,
    {
      query: graphqlQuery,
      variables: {
        query: `fulfillment_status:unfulfilled OR fulfillment_status:partial`
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
    throw new Error(`GraphQL errors: ${JSON.stringify(response.data.errors)}`);
  }

  // Find order with matching tracking number
  const orders = response.data.data.orders.nodes;
  for (const order of orders) {
    for (const fulfillment of order.fulfillments) {
      if (fulfillment.trackingInfo.some(info => info.number === trackingNumber)) {
        return order;
      }
    }
  }

  return null;
}

// Helper function to fulfill order on Shopify
async function fulfillOrder(shop, orderId, fulfillmentId) {
  const accessToken = accessTokens[shop];
  if (!accessToken) {
    throw new Error('No access token found for shop');
  }

  const graphqlMutation = `
    mutation fulfillmentOpen($id: ID!) {
      fulfillmentOpen(id: $id) {
        fulfillment {
          id
          status
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
      query: graphqlMutation,
      variables: {
        id: fulfillmentId
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
    throw new Error(`GraphQL errors: ${JSON.stringify(response.data.errors)}`);
  }

  if (response.data.data.fulfillmentOpen.userErrors.length > 0) {
    throw new Error(`Fulfillment errors: ${JSON.stringify(response.data.data.fulfillmentOpen.userErrors)}`);
  }

  return response.data.data.fulfillmentOpen.fulfillment;
}

// Helper function to check if package is delivered
function isPackageDelivered(trackingData) {
  try {
    const trackingInfo = trackingData.output?.completeTrackResults?.[0]?.trackResults?.[0];
    if (!trackingInfo) return false;

    // Check latest scan event
    const latestScan = trackingInfo.scanEvents?.[0];
    if (!latestScan) return false;

    // FedEx delivery status codes
    const deliveryStatuses = ['DL', 'Delivered'];
    return deliveryStatuses.some(status => 
      latestScan.eventType?.includes(status) || 
      latestScan.eventDescription?.toLowerCase().includes('delivered')
    );
  } catch (error) {
    console.error('Error checking delivery status:', error);
    return false;
  }
}

// GET /track?tracking_number=123456789012&shop=myshop.myshopify.com
router.get('/track', async (req, res) => {
  const { tracking_number: trackingNumber, shop } = req.query;

  if (!trackingNumber) {
    return res.status(400).json({ error: 'Missing tracking_number' });
  }

  try {
    // Step 1: Get FedEx access token
    const tokenRes = await axios.post(
      `${BASE_URL}/oauth/token`,
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }
    );

    const token = tokenRes.data.access_token;

    // Step 2: Track package
    const trackRes = await axios.post(
      `${BASE_URL}/track/v1/trackingnumbers`,
      {
        trackingInfo: [
          {
            trackingNumberInfo: {
              trackingNumber,
            },
          },
        ],
        includeDetailedScans: true,
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const trackingData = trackRes.data;

    // Step 3: Check if package is delivered and update Shopify if shop is provided
    let fulfillmentResult = null;
    if (shop && isPackageDelivered(trackingData)) {
      try {
        // Find the order with this tracking number
        const order = await findOrderByTrackingNumber(shop, trackingNumber);
        
        if (order) {
          // Find the fulfillment with this tracking number
          const fulfillment = order.fulfillments.find(f => 
            f.trackingInfo.some(info => info.number === trackingNumber)
          );

          if (fulfillment && fulfillment.status !== 'success') {
            // Fulfill the order
            fulfillmentResult = await fulfillOrder(shop, order.id, fulfillment.id);
            console.log(`Order ${order.name} fulfilled successfully for tracking ${trackingNumber}`);
          }
        }
      } catch (fulfillmentError) {
        console.error('Error fulfilling order:', fulfillmentError.message);
        // Don't fail the entire request if fulfillment fails
      }
    }

    res.json({
      tracking: trackingData,
      delivered: isPackageDelivered(trackingData),
      fulfillment: fulfillmentResult
    });

  } catch (error) {
    console.error('FedEx tracking error:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to fetch tracking info',
      details: error.response?.data || error.message,
    });
  }
});

module.exports = router;
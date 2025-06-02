const express = require('express');
const router = express.Router();
const axios = require('axios');

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

// GET /track?tracking_number=123456789012
router.get('/track', async (req, res) => {
  const trackingNumber = req.query.tracking_number;

  if (!trackingNumber) {
    return res.status(400).json({ error: 'Missing tracking_number' });
  }

  try {
    // Step 1: Get access token
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

    res.json(trackRes.data);
  } catch (error) {
    console.error('FedEx tracking error:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to fetch tracking info',
      details: error.response?.data || error.message,
    });
  }
});

module.exports = router;

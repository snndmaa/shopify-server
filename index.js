
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
const morgan = require('morgan')

app.use(cors()); // Allow all origins for development
app.use(express.json());
app.use(cookieParser());
app.use(morgan('tiny'))

const {
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET,
  SHOPIFY_SCOPES,
  SHOPIFY_HOST
} = process.env;

const accessTokens = require('./lib/tokenStore');

app.use('/shopify/products', require('./routers/products'))

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

app.get('/', (req, res) => {
  res.send('Spade-Shopify Backend Working')
})

// Step 1: Install route
app.get('/shopify/install', (req, res) => {
  const { shop } = req.query;
  const url = buildAuthURL(shop);
  res.redirect(url);
});

// Step 2: Callback and token exchange
app.get('/shopify/callback', async (req, res) => {
  const { shop, code, hmac, host } = req.query;

  if (!verifyHMAC(req.query)) {
    return res.status(400).send('HMAC verification failed');
  }

  try {
    const response = await axios.post(`https://${shop}/admin/oauth/access_token`, {
      client_id: SHOPIFY_API_KEY,
      client_secret: SHOPIFY_API_SECRET,
      code,
    });

    const { access_token } = response.data;
    accessTokens[shop] = access_token;
    
    // Redirect back to the app within Shopify Admin
    const redirectUrl = `https://${shop}/admin/apps/${SHOPIFY_API_KEY}`;
    
    // If we have a host parameter, use it for embedded app redirect
    if (host) {
      const embeddedAppUrl = `https://${shop}/admin/apps/${SHOPIFY_API_KEY}?host=${host}`;
      return res.redirect(embeddedAppUrl);
    }
    
    return res.redirect(redirectUrl);
  } catch (error) {
    console.error('Error exchanging code for access token:', error.message);
    res.status(500).send('Authentication failed');
  }
})
app.get('/shopify/authenticated', async (req, res) => {
  const { shop } = req.query;
  
  if (!shop) {
    return res.status(400).json({ error: 'Shop parameter is required' });
  }

  // Check if we have an access token for this shop
  const accessToken = accessTokens[shop];
  if (!accessToken) {
    return res.json({ authenticated: false });
  }
  
  try {
    // Verify the token is still valid by making a simple API call
    await axios.get(`https://${shop}/admin/api/2023-10/shop.json`, {
      headers: {
        'X-Shopify-Access-Token': accessToken
      }
    });
    
    // If the request doesn't throw an error, the token is valid
    return res.json({ authenticated: true });
  } catch (error) {
    console.error('Token validation error:', error.message);
    // If the token is invalid, remove it
    delete accessTokens[shop];
    return res.json({ authenticated: false });
  }
});

// Step 3: Create product route
app.post('/shopify/test/product', async (req, res) => {
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

app.listen(3001, () => {
  console.log('Server running on port 3001');
});
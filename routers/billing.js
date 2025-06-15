const express = require('express');
const { Shopify } = require('@shopify/shopify-api');
const accessTokens = require('../lib/tokenStore');

// const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const router = express.Router();

// Shopify subscription plan creation
router.post('/subscription', async (req, res) => {
  const { shop, planName, price, returnUrl } = req.body;

  // Retrieve access token from tokenStore
  const accessToken = accessTokens[shop];
  if (!accessToken) {
    return res.status(401).json({ error: 'Shop not authenticated or access token not found' });
  }

  const client = new Shopify.Clients.Graphql(shop, accessToken);
  const query = `
    mutation {
      appSubscriptionCreate(
        name: "${planName}"
        returnUrl: "${returnUrl}"
        test: true
        lineItems: [{
          plan: {
            appRecurringPricingDetails: {
              price: {
                amount: ${price},
                currencyCode: USD
              }
            }
          }
        }]
      ) {
        userErrors {
          field
          message
        }
        confirmationUrl
      }
    }
  `;

  try {
    const response = await client.query({ data: query });
    const confirmationUrl = response.body.data.appSubscriptionCreate.confirmationUrl;
    res.json({ confirmationUrl });
  } catch (error) {
    console.error('Error creating subscription:', error);
    res.status(500).json({ error: 'Failed to create subscription' });
  }
});

// Shopify usage charge
router.post('/usage', async (req, res) => {
  const { shop, subscriptionId, description, amount } = req.body;

  // Retrieve access token from tokenStore
  const accessToken = accessTokens[shop];
  if (!accessToken) {
    return res.status(401).json({ error: 'Shop not authenticated or access token not found' });
  }

  const client = new Shopify.Clients.Graphql(shop, accessToken);
  const query = `
    mutation {
      appUsageRecordCreate(
        subscriptionId: "${subscriptionId}",
        description: "${description}",
        price: { amount: ${amount}, currencyCode: USD }
      ) {
        appUsageRecord {
          id
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  try {
    const response = await client.query({ data: query });
    const result = response.body.data.appUsageRecordCreate;
    res.json(result);
  } catch (error) {
    console.error('Error creating usage charge:', error);
    res.status(500).json({ error: 'Failed to create usage charge' });
  }
});

// Stripe external service payment
// router.post('/stripe/checkout', async (req, res) => {
//   const { email, amount, description } = req.body;

//   try {
//     const session = await stripe.checkout.sessions.create({
//       payment_method_types: ['card'],
//       customer_email: email,
//       line_items: [{
//         price_data: {
//           currency: 'usd',
//           product_data: { name: description },
//           unit_amount: Math.round(amount * 100), // in cents
//         },
//         quantity: 1,
//       }],
//       mode: 'payment',
//       success_url: 'https://yourapp.com/payment-success',
//       cancel_url: 'https://yourapp.com/payment-cancelled',
//     });

//     res.json({ url: session.url });
//   } catch (error) {
//     console.error('Stripe checkout error:', error);
//     res.status(500).json({ error: 'Stripe checkout failed' });
//   }
// });

// Shopify app uninstall webhook
router.post('/webhooks/app-uninstalled', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const shop = req.headers['x-shopify-shop-domain'];
    
    // Clean up tokenStore when app is uninstalled
    if (accessTokens[shop]) {
      delete accessTokens[shop];
      console.log(`Access token removed for ${shop}`);
    }
    
    // TODO: Clean up database (e.g., delete subscription info, user data)
    console.log(`App uninstalled by ${shop}`);
    res.status(200).send('Webhook received');
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).send('Webhook error');
  }
});

module.exports = router;
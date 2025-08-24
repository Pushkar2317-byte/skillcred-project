// netlify/functions/create-checkout-session.js
// Node 18+ Netlify function that creates a Stripe Checkout session.
//
// Required env vars:
//   STRIPE_SECRET_KEY  -> your Stripe API secret (sk_test_...)
// Optional:
//   DEFAULT_CURRENCY   -> default currency (e.g., "inr" or "usd")
//
// Notes:
// - This function expects a POST with JSON body: { name, email, amount, currency? }
// - Amount in the request must be an integer representing the main currency unit
//   (e.g., 500 means ₹500 / $500). We multiply by 100 for smallest unit for Stripe.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fs = require('fs');
const path = require('path');

exports.handler = async function (event) {
  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Parse body (Netlify may base64-encode; but usually event.body is raw string)
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    return { statusCode: 400, body: 'Invalid JSON body' };
  }

  const donorName = (body.name || '').trim();
  const donorEmail = (body.email || '').trim();
  let amount = Number(body.amount); // expected in main currency units (e.g., 500)
  let currency = (body.currency || process.env.DEFAULT_CURRENCY || 'inr').toLowerCase();

  // Basic validation
  if (!donorEmail) {
    return { statusCode: 400, body: 'Email is required' };
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return { statusCode: 400, body: 'Invalid amount' };
  }

  // Normalize amount to integer (ensure no floating cent issues)
  // If user passed decimal (e.g., 12.50), convert to smallest unit below by *100
  // But here we treat incoming amount as whole units (as front-end uses integers).
  const unitAmount = Math.round(amount * 100); // Stripe expects smallest currency unit

  // Try to read campaign.json (optional) to form product name/description
  let productName = 'Donation';
  try {
    const campaignPath = path.join(__dirname, '..', '..', 'data', 'campaign.json');
    if (fs.existsSync(campaignPath)) {
      const raw = fs.readFileSync(campaignPath, 'utf8');
      const campaign = JSON.parse(raw);
      const title = campaign.campaignTitle || '';
      const org = campaign.organizationName || '';
      productName = (title && org) ? `${title} — ${org}` : (title || org || productName);
    }
  } catch (err) {
    // non-fatal; proceed with default productName
    console.warn('Could not load campaign.json', err?.message || err);
  }

  // Build origin for redirect URLs. Prefer x-forwarded-* headers set by Netlify.
  const proto = event.headers['x-forwarded-proto'] || event.headers['x-forwarded-proto'.toLowerCase()] || 'https';
  const host = event.headers['x-forwarded-host'] || event.headers['host'] || event.headers['x-forwarded-host'.toLowerCase()] || 'localhost:8888';
  const origin = `${proto}://${host}`;

  try {
    // Create Stripe Checkout session
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: currency,
            product_data: {
              name: productName,
            },
            unit_amount: unitAmount
          },
          quantity: 1
        }
      ],
      // Set customer email so Stripe knows the donor email
      customer_email: donorEmail,
      // Optional metadata you can inspect later in webhooks
      metadata: {
        donor_name: donorName || '',
        source: 'onepage-site'
      },
      // Optional: collect optional donor name using Checkout custom_fields if you want
      // custom_fields: donorName ? [] : [{ key: 'donor_name', label: { type: 'custom', custom: 'Your full name' }, type: 'text' }],
      success_url: `${origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/`
    });

    // Return the redirect URL for the frontend to send the user to Stripe Checkout
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url })
    };

  } catch (err) {
    console.error('Error creating Stripe Checkout session:', err);
    // Avoid leaking secrets in responses
    return {
      statusCode: 500,
      body: 'Internal Server Error: could not create checkout session'
    };
  }
};

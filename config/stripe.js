// config/stripe.js
const Stripe = require('stripe');

let stripeInstance;

// Function to initialize Stripe SDK
const initializeStripe = (secretKey) => {
  if (!secretKey) {
    console.error("Stripe Secret Key is not provided. Please set STRIPE_SECRET_KEY in your .env file.");
    process.exit(1); // Exit if secret key is missing
  }
  stripeInstance = new Stripe(secretKey);
  console.log('Stripe SDK initialized.');
  return stripeInstance;
};

// Function to get the initialized Stripe instance
const getStripeInstance = () => {
  if (!stripeInstance) {
    console.error("Stripe SDK not initialized. Call initializeStripe first.");
    process.exit(1); // Or throw an error depending on desired behavior
  }
  return stripeInstance;
};

module.exports = {
  initializeStripe,
  getStripeInstance
};

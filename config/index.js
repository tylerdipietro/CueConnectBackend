// config/index.js
// Centralizes configuration loading and initializes external services.

const connectDB = require('./db');
const { initializeFirebaseAdmin } = require('./firebase');
const { initializeStripe } = require('./stripe');

// Load environment variables
require('dotenv').config();

// Export all necessary environment variables
const config = {
  MONGODB_URI: process.env.MONGODB_URI,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
  FIREBASE_SERVICE_ACCOUNT_KEY_BASE64: process.env.FIREBASE_SERVICE_ACCOUNT_KEY_BASE64, // Base64 encoded JSON
  FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
  PORT: process.env.PORT || 3000,
};

// Function to initialize all services
const initializeServices = () => {
  // Connect to MongoDB
  connectDB(config.MONGODB_URI);

  // Initialize Firebase Admin SDK
  initializeFirebaseAdmin(config.FIREBASE_SERVICE_ACCOUNT_KEY_BASE64, config.FIREBASE_PROJECT_ID);

  // Initialize Stripe SDK
  initializeStripe(config.STRIPE_SECRET_KEY);
};

module.exports = {
  config,
  initializeServices
};

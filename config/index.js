// config/index.js
// Centralizes configuration loading and initializes external services.

const connectDB = require('./db');
const { initializeFirebaseAdmin } = require('./firebase'); // Now imports the function that returns admin instance
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
// It now accepts the Express 'app' instance
const initializeServices = (app) => { // <--- MODIFIED: Accepts 'app'
  // Connect to MongoDB
  connectDB(config.MONGODB_URI);

  // Initialize Firebase Admin SDK and get the instance
  const adminInstance = initializeFirebaseAdmin(config.FIREBASE_SERVICE_ACCOUNT_KEY_BASE64, config.FIREBASE_PROJECT_ID);
  
  // CRITICAL: Attach the Firebase Admin instance to the Express app object
  if (app && adminInstance) {
    app.set('admin', adminInstance); // <--- CRITICAL: Set 'admin' on the app object
    console.log("[config/index.js] Firebase Admin SDK instance attached to Express app.");
  } else {
    console.warn("[config/index.js] Could not attach Firebase Admin SDK to Express app. 'app' or 'adminInstance' is missing.");
  }

  // Initialize Stripe SDK
  initializeStripe(config.STRIPE_SECRET_KEY);
};

module.exports = {
  config,
  initializeServices
};

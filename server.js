// backend/server.js
// Main entry point for the CueConnect Node.js/Express backend server.
// This file sets up the Express app, configures middleware, initializes services,
// mounts route handlers, and starts the server.

const express = require('express');
const http = require('http'); // Used to create HTTP server for Socket.IO
const { config, initializeServices } = require('./config'); // Centralized config and service initialization
const { initializeSocketIO } = require('./services/socketService'); // Socket.IO service
const { getStripeInstance } = require('./config/stripe'); // Stripe instance for webhooks

// Import route modules
const verifyFirebaseToken = require('./routes/authRoutes'); // Auth middleware
const userRoutes = require('./routes/userRoutes');
const venueRoutes = require('./routes/venueRoutes');
const tableRoutes = require('./routes/tableRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const Session = require('./models/Session'); // Session model for webhook
const User = require('./models/User'); // User model for webhook

// --- Initialize Express App and HTTP Server ---
const app = express();
const server = http.createServer(app); // Create HTTP server for Socket.IO attachment

// --- Initialize Services (MongoDB, Firebase Admin, Stripe SDK) ---
initializeServices();

// --- Initialize Socket.IO ---
// Pass the HTTP server instance and CORS options to the socket service
const io = initializeSocketIO(server, {
  cors: {
    origin: "*", // IMPORTANT: Adjust this to your React Native app's specific origin in production
    methods: ["GET", "POST"]
  }
});

// --- Stripe Webhook Endpoint (MUST be before express.json() for raw body) ---
// This endpoint receives events from Stripe.
app.post('/stripe-webhook', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  const stripe = getStripeInstance(); // Get the initialized Stripe instance

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, config.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error(`Webhook signature verification failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle different Stripe event types
  switch (event.type) {
    case 'payment_intent.succeeded':
      const paymentIntent = event.data.object;
      console.log(`Webhook: PaymentIntent ${paymentIntent.id} succeeded!`);

      // Extract custom metadata added during PaymentIntent creation
      const userId = paymentIntent.metadata.userId;
      const purchasedTokens = parseInt(paymentIntent.metadata.tokensAmount);
      const sessionType = paymentIntent.metadata.sessionType;
      const sessionId = paymentIntent.metadata.sessionId;

      if (userId && purchasedTokens && sessionType === 'token_purchase' && sessionId) {
        try {
          const user = await User.findById(userId);
          if (user) {
            user.tokenBalance += purchasedTokens;
            await user.save();
            console.log(`Webhook: User ${userId} token balance updated to ${user.tokenBalance}.`);

            const session = await Session.findById(sessionId);
            if (session) {
                session.status = 'completed';
                session.stripePaymentIntentId = paymentIntent.id;
                session.endTime = new Date();
                await session.save();
                console.log(`Webhook: Internal session ${sessionId} marked as completed.`);
            } else {
                console.warn(`Webhook: No internal session found for sessionId ${sessionId} linked to PaymentIntent ${paymentIntent.id}. Creating new record as fallback.`);
                const newSession = new Session({
                    tableId: null, venueId: null, player1Id: userId,
                    startTime: new Date(paymentIntent.created * 1000), endTime: new Date(),
                    cost: paymentIntent.amount / 100, status: 'completed', type: 'token_purchase',
                    purchasedTokens: purchasedTokens, stripePaymentIntentId: paymentIntent.id,
                });
                await newSession.save();
            }

            // Emit Socket.IO event to the specific user to update their balance in real-time
            io.to(userId).emit('tokenBalanceUpdate', { newBalance: user.tokenBalance });
          } else {
            console.error(`Webhook: User ${userId} not found in DB for PaymentIntent ${paymentIntent.id}.`);
          }
        } catch (err) {
          console.error(`Webhook: Error processing payment_intent.succeeded for ${paymentIntent.id}:`, err.message);
        }
      } else {
        console.warn(`Webhook: PaymentIntent ${paymentIntent.id} has missing or invalid metadata.`);
      }
      break;

    case 'payment_intent.payment_failed':
      const paymentIntentFailed = event.data.object;
      console.log(`Webhook: PaymentIntent ${paymentIntentFailed.id} failed. Reason: ${paymentIntentFailed.last_payment_error?.message || 'Unknown reason'}.`);
      // Implement logic to update session status or notify user about failed payment
      break;
    default:
      console.log(`Webhook: Unhandled event type ${event.type}.`);
  }

  res.status(200).json({ received: true });
});

// --- Middleware Setup ---
// Enable Express to parse JSON request bodies.
// This must be after the raw body webhook handler if it's used.
app.use(express.json());

// Apply Firebase token verification middleware to all API routes below this point.
app.use('/api/*', verifyFirebaseToken);

// --- API Route Mounting ---
app.use('/api/users', userRoutes);
app.use('/api/venues', venueRoutes);
app.use('/api/tables', tableRoutes);
app.use('/api/payments', paymentRoutes);

// --- Root Route (Optional) ---
app.get('/', (req, res) => {
  res.send('CueConnect Backend is running!');
});

// --- Start the HTTP Server ---
server.listen(config.PORT, () => {
  console.log(`Server running on port ${config.PORT}`);
  console.log(`MongoDB URI: ${config.MONGODB_URI ? 'Set' : 'Not Set'}`);
  console.log(`Stripe Secret Key: ${config.STRIPE_SECRET_KEY ? 'Set' : 'Not Set'}`);
  console.log(`Stripe Webhook Secret: ${config.STRIPE_WEBHOOK_SECRET ? 'Set' : 'Not Set'}`);
  console.log(`Firebase Service Account Key: ${config.FIREBASE_SERVICE_ACCOUNT_KEY_BASE64 ? 'Set (Base64)' : 'Not Set'}`);
  console.log(`Firebase Project ID: ${config.FIREBASE_PROJECT_ID ? 'Set' : 'Not Set'}`);
});

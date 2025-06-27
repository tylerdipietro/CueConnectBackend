// backend/server.js
const express = require('express');
const http = require('http');
const { config, initializeServices } = require('./config');
const { initializeSocketIO } = require('./services/socketService');
const { getStripeInstance } = require('./config/stripe');

// Import route modules
// const verifyFirebaseToken = require('./routes/authRoutes'); // We'll modify this directly here or integrate it.
const userRoutes = require('./routes/userRoutes');
const venueRoutes = require('./routes/venueRoutes');
const tableRoutes = require('./routes/tableRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const Session = require('./models/Session');
const User = require('./models/User'); // Import User model
const admin = require('firebase-admin'); // Import Firebase Admin SDK

// --- Initialize Express App and HTTP Server ---
const app = express();
const server = http.createServer(app);

// --- Initialize Services (MongoDB, Firebase Admin, Stripe SDK) ---
initializeServices();

// --- Initialize Socket.IO ---
const io = initializeSocketIO(server, {
  cors: {
    origin: "*", // IMPORTANT: Adjust this to your React Native app's specific origin in production
    methods: ["GET", "POST"]
  }
});

// --- Stripe Webhook Endpoint (MUST be before express.json() for raw body) ---
app.post('/stripe-webhook', express.raw({type: 'application/json'}), async (req, res) => {
  // ... (Keep your existing Stripe webhook logic here, no changes needed) ...
  const sig = req.headers['stripe-signature'];
  let event;
  const stripe = getStripeInstance();

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, config.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error(`Webhook signature verification failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'payment_intent.succeeded':
      const paymentIntent = event.data.object;
      console.log(`Webhook: PaymentIntent ${paymentIntent.id} succeeded!`);

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
      break;
    default:
      console.log(`Webhook: Unhandled event type ${event.type}.`);
  }

  res.status(200).json({ received: true });
});

// --- Middleware Setup ---
app.use(express.json());

// --- Custom Firebase Token Verification and User Data Fetching Middleware ---
// This middleware will be used for all protected API routes.
const verifyFirebaseToken = async (req, res, next) => {
  const headerToken = req.headers.authorization;
  if (!headerToken || !headerToken.startsWith('Bearer ')) {
    return res.status(401).send('Unauthorized: No token provided or token format is invalid.');
  }
  const idToken = headerToken.split('Bearer ')[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken; // Attach Firebase decoded token to request object

    // Fetch user details from MongoDB using the Firebase UID
    const dbUser = await User.findById(decodedToken.uid);

    if (!dbUser) {
      // If user doesn't exist in your DB, create a new entry.
      // This handles initial sign-ups where user info might not be in MongoDB yet.
      const newUser = new User({
        _id: decodedToken.uid, // Use Firebase UID as _id
        displayName: decodedToken.name || decodedToken.email.split('@')[0],
        email: decodedToken.email,
        tokenBalance: 0,
        isAdmin: false, // Default to non-admin for new users
        fcmTokens: []
      });
      await newUser.save();
      req.user.isAdmin = false; // Set isAdmin for the current request
      console.log(`[Auth] New user ${decodedToken.uid} created in MongoDB.`);
    } else {
      // Attach isAdmin status from MongoDB to the request user object
      req.user.isAdmin = dbUser.isAdmin;
      req.user.tokenBalance = dbUser.tokenBalance; // Also attach token balance
    }
    next(); // Proceed to the next middleware/route handler
  } catch (error) {
    console.error('Error verifying Firebase ID token or fetching user data:', error);
    res.status(401).send('Unauthorized: Invalid or expired token or user data issue.');
  }
};

// --- Define an API Router and apply authentication middleware to it ---
const apiRouter = express.Router();
apiRouter.use(verifyFirebaseToken); // Apply Firebase token verification to all routes mounted on apiRouter

// --- Mount the /api/user/profile route ---
// This route is now simpler as `req.user` will have `isAdmin` already populated.
apiRouter.get('/user/profile', (req, res) => {
  // `req.user` is populated by `verifyFirebaseToken` middleware
  if (req.user) {
    res.json({
      uid: req.user.uid,
      email: req.user.email,
      displayName: req.user.name,
      isAdmin: req.user.isAdmin || false, // Ensure isAdmin is always a boolean
      tokenBalance: req.user.tokenBalance || 0, // Ensure tokenBalance is available
    });
  } else {
    res.status(401).send('User not authenticated.');
  }
});


// --- Mount all other route modules to the API Router ---
apiRouter.use('/users', userRoutes);
apiRouter.use('/venues', venueRoutes);
apiRouter.use('/tables', tableRoutes);
apiRouter.use('/payments', paymentRoutes);

// --- Mount the API Router to the main app under '/api' prefix ---
app.use('/api', apiRouter);


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

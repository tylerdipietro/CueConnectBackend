// routes/paymentRoutes.js
const express = require('express');
const router = express.Router();
const { getStripeInstance } = require('../config/stripe'); // Stripe instance from your config
const Session = require('../models/Session'); // Session model
const User = require('../models/User'); // User model
const { getSocketIO } = require('../services/socketService'); // Socket.IO instance
const { sendPushNotification } = require('../services/notificationService'); // Push notification service
const Table = require('../models/Table'); // Table model (for gameStartConfirmation)

// Define your token to USD conversion rate
// Example: 10 tokens = $1.00 USD, so 1 token = $0.10 USD
const TOKEN_PRICE_PER_UNIT_USD = 0.10; // $0.10 per token

/**
 * @route POST /api/payments/create-token-payment-intent
 * @description Creates a Stripe Payment Intent for purchasing in-app tokens.
 * This endpoint will also handle creating/retrieving a Stripe Customer and an Ephemeral Key.
 * @access Private (requires Firebase auth token)
 * @body {number} amountTokens - The number of tokens the user wants to purchase.
 */
router.post('/create-token-payment-intent', async (req, res) => {
  const { amountTokens } = req.body;
  const userId = req.user.uid; // Firebase UID from authenticated user (set by authMiddleware)
  const stripe = getStripeInstance(); // Get the initialized Stripe instance

  if (!userId) {
    return res.status(401).json({ message: 'Authentication required.' });
  }
  if (!amountTokens || typeof amountTokens !== 'number' || amountTokens <= 0) {
    return res.status(400).json({ message: 'Invalid amount of tokens specified.' });
  }

  try {
    const user = await User.findOne({ firebaseUid: userId });
    if (!user) {
      return res.status(404).json({ message: 'User not found in database.' });
    }

    // Calculate the amount in cents (Stripe requires amount in smallest currency unit)
    const amountUSD = amountTokens * TOKEN_PRICE_PER_UNIT_USD;
    const amountCents = Math.round(amountUSD * 100); // Convert to cents

    // Stripe's minimum amount is typically 50 cents ($0.50 USD)
    // Adjust this based on your minimum token package (e.g., if 1 token is $0.10, min 5 tokens)
    if (amountCents < 50) {
      return res.status(400).json({ message: `Minimum purchase amount is ${Math.ceil(50 / (TOKEN_PRICE_PER_UNIT_USD * 100))} tokens ($0.50).` });
    }

    let customerId = user.stripeCustomerId;

    // 1. Create or retrieve a Stripe Customer
    if (!customerId) {
      console.log(`[Stripe] Creating new customer for user ${userId}`);
      const customer = await stripe.customers.create({
        metadata: { firebaseUid: userId, email: user.email },
        name: user.displayName || user.email,
        email: user.email,
      });
      customerId = customer.id;
      user.stripeCustomerId = customerId; // Save customer ID to user profile
      await user.save();
    } else {
      console.log(`[Stripe] Using existing customer ${customerId} for user ${userId}`);
    }

    // 2. Create an Ephemeral Key (for client-side security)
    // The API version should match the version you're using in your Stripe dashboard
    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customerId },
      { apiVersion: '2024-06-20' } // IMPORTANT: Use your Stripe API version here
    );

    // 3. Create a Payment Intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents, // Amount in cents
      currency: 'usd',
      customer: customerId,
      setup_future_usage: 'off_session', // Optional: if you want to save card details for future use
      automatic_payment_methods: {
        enabled: true, // Enables all supported payment methods
      },
      metadata: {
        firebaseUid: userId,
        amountTokens: amountTokens, // Store token quantity in metadata
        type: 'token_purchase', // Custom metadata for your records
      },
      description: `Purchase of ${amountTokens} tokens by ${user.email}`,
    });

    // Send the necessary client secrets and keys back to the frontend
    res.json({
      paymentIntent: paymentIntent.client_secret,
      ephemeralKey: ephemeralKey.secret,
      customer: customerId,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY, // Send publishable key from backend
    });

  } catch (error) {
    console.error('[Stripe Error] Failed to create payment intent:', error.message);
    res.status(500).json({ message: 'Failed to initiate payment. Please try again.', error: error.message });
  }
});

/**
 * @route POST /api/payments/confirm-token-purchase
 * @description Confirms a successful token purchase after Stripe Payment Sheet completes.
 * This endpoint should be called by the frontend AFTER the payment is successful on Stripe's side.
 * A more robust solution involves Stripe Webhooks for ultimate source of truth.
 * @access Private
 * @body {string} paymentIntentId - The ID of the Stripe Payment Intent.
 * @body {number} amountTokens - The number of tokens purchased (for verification).
 */
router.post('/confirm-token-purchase', async (req, res) => {
  const { paymentIntentId, amountTokens } = req.body;
  const userId = req.user.uid; // Authenticated user ID
  const stripe = getStripeInstance();
  const io = getSocketIO();

  if (!userId || !paymentIntentId || !amountTokens || typeof amountTokens !== 'number' || amountTokens <= 0) {
    return res.status(400).json({ message: 'Missing or invalid required fields.' });
  }

  try {
    // 1. Retrieve and verify the Payment Intent from Stripe
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    // Basic verification:
    // - Payment Intent status is 'succeeded'
    // - Metadata matches the user and amountTokens (important for security and idempotency)
    if (
      paymentIntent.status !== 'succeeded' ||
      paymentIntent.metadata.firebaseUid !== userId ||
      parseInt(paymentIntent.metadata.amountTokens, 10) !== amountTokens
    ) {
      console.error(`[Stripe] Payment Intent verification failed for ${paymentIntentId}. Status: ${paymentIntent.status}, User ID mismatch: ${paymentIntent.metadata.firebaseUid} vs ${userId}, Tokens mismatch: ${paymentIntent.metadata.amountTokens} vs ${amountTokens}`);
      return res.status(400).json({ message: 'Payment verification failed or details mismatch.' });
    }

    // 2. Check for idempotency: Has this payment intent already been processed?
    // This prevents double-crediting tokens if the frontend calls this endpoint multiple times.
    const existingSession = await Session.findOne({
      paymentIntentId: paymentIntentId,
      type: 'token_purchase',
    });

    if (existingSession) {
      console.warn(`[Stripe] Tokens for PaymentIntent ${paymentIntentId} already credited. Skipping re-credit.`);
      return res.status(200).json({ message: 'Tokens already credited.', newBalance: existingSession.purchasedTokens });
    }

    // 3. Find the user and update their token balance
    const user = await User.findOne({ firebaseUid: userId });
    if (!user) {
      return res.status(404).json({ message: 'User not found in database.' });
    }

    user.tokenBalance += amountTokens;
    await user.save();
    console.log(`[Stripe] User ${userId} credited with ${amountTokens} tokens. New balance: ${user.tokenBalance}`);

    // 4. Record the token purchase in your Session model
    const newSession = new Session({
      tableId: null, // Not associated with a table game
      venueId: null, // Not associated with a venue
      player1Id: userId, // The user who made the purchase
      player2Id: null,
      startTime: new Date(),
      endTime: new Date(),
      cost: paymentIntent.amount / 100, // Store cost in USD
      status: 'completed',
      type: 'token_purchase',
      purchasedTokens: amountTokens,
      stripePaymentIntentId: paymentIntentId, // Store the payment intent ID for idempotency
    });
    await newSession.save();
    console.log(`[Stripe] Recorded token purchase session ${newSession._id} for PaymentIntent ${paymentIntentId}`);


    // 5. Emit Socket.IO event to update frontend token balance in real-time
    io.to(userId).emit('tokenBalanceUpdate', { newBalance: user.tokenBalance });

    res.status(200).json({ message: 'Tokens loaded successfully!', newBalance: user.tokenBalance });

  } catch (error) {
    console.error('[Stripe Error] Error confirming token purchase:', error.message);
    res.status(500).json({ message: 'Failed to confirm token purchase.', error: error.message });
  }
});


/**
 * @route POST /api/payments/confirm
 * @description Confirms an internal game payment (deduction from user's token balance).
 * This is your existing game payment confirmation, kept as is.
 * @access Private
 */
router.post('/confirm', async (req, res) => {
  const { sessionId } = req.body; // sessionId links to our internal game session
  const userId = req.user.uid; // The user making the payment
  const io = getSocketIO();

  try {
    const session = await Session.findById(sessionId);
    if (!session || (session.player1Id !== userId && session.player2Id !== userId)) {
      return res.status(403).send('Unauthorized or game session not found for this user.');
    }

    const user = await User.findById(userId);
    if (!user || user.tokenBalance < session.cost) {
      return res.status(400).send('Insufficient tokens. Please purchase more or try again.');
    }

    user.tokenBalance -= session.cost;
    await user.save();

    session.status = 'active';
    session.endTime = null;
    await session.save();

    const table = await Table.findById(session.tableId);
    io.to(session.player1Id).emit('gameStartConfirmation', {
        tableId: session.tableId,
        tableNumber: table ? table.tableNumber : 'Unknown',
        esp32DeviceId: table ? table.esp32DeviceId : null,
        player2Id: session.player2Id
    });
    if (session.player2Id) {
        io.to(session.player2Id).emit('gameStartConfirmation', {
            tableId: session.tableId,
            tableNumber: table ? table.tableNumber : 'Unknown',
            esp32DeviceId: table ? table.esp32DeviceId : null,
            player1Id: session.player1Id
        });
    }

    io.to(userId).emit('tokenBalanceUpdate', { newBalance: user.tokenBalance });

    res.status(200).send('Payment confirmed. Game is starting.');

  } catch (error) {
    console.error('Payment confirmation error:', error.message);
    res.status(500).send('Payment failed due to an internal server error.');
  }
});

module.exports = router;

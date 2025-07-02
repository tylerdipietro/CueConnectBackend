// routes/paymentRoutes.js
const express = require('express');
const router = express.Router();
const { getStripeInstance } = require('../config/stripe');
const Session = require('../models/Session');
const User = require('../models/User'); // CORRECTED: Removed the extra '=' here
const { getSocketIO } = require('../services/socketService');
const { sendPushNotification } = require('../services/notificationService');
const Table = require('../models/Table');

const TOKEN_PRICE_PER_UNIT_USD = 0.10;

/**
 * @route POST /api/payments/create-token-payment-intent
 * @description Creates a Stripe Payment Intent for purchasing in-app tokens.
 * @access Private (requires Firebase auth token)
 * @body {number} amountTokens - The number of tokens the user wants to purchase.
 */
router.post('/create-token-payment-intent', async (req, res) => {
  const { amountTokens } = req.body;
  const userId = req.user.uid; // Firebase UID from authenticated user (set by authMiddleware)
  const stripe = getStripeInstance();

  console.log(`[PaymentRoutes:/create-token-payment-intent] Request received for user ${userId}, tokens: ${amountTokens}`);

  if (!userId) {
    console.error('[PaymentRoutes:/create-token-payment-intent] Missing userId in req.user.');
    return res.status(401).json({ message: 'Authentication required.' });
  }
  if (!amountTokens || typeof amountTokens !== 'number' || amountTokens <= 0) {
    console.error('[PaymentRoutes:/create-token-payment-intent] Invalid amountTokens:', amountTokens);
    return res.status(400).json({ message: 'Invalid amount of tokens specified.' });
  }

  try {
    const user = await User.findById(userId);
    if (!user) {
      console.error(`[PaymentRoutes:/create-token-payment-intent] User NOT FOUND in DB for UID: ${userId}`);
      return res.status(404).json({ message: 'User not found in database.' });
    }
    console.log(`[PaymentRoutes:/create-token-payment-intent] User found in DB for UID: ${userId}. StripeCustomerId: ${user.stripeCustomerId}`);

    const amountUSD = amountTokens * TOKEN_PRICE_PER_UNIT_USD;
    const amountCents = Math.round(amountUSD * 100);

    if (amountCents < 50) {
      console.warn(`[PaymentRoutes:/create-token-payment-intent] Amount too low: ${amountCents} cents.`);
      return res.status(400).json({ message: `Minimum purchase amount is ${Math.ceil(50 / (TOKEN_PRICE_PER_UNIT_USD * 100))} tokens ($0.50).` });
    }

    let customerId = user.stripeCustomerId;

    if (!customerId) {
      console.log(`[Stripe] Creating new customer for user ${userId} (${user.email})...`);
      const customer = await stripe.customers.create({
        metadata: { firebaseUid: userId, email: user.email },
        name: user.displayName || user.email,
        email: user.email,
      });
      customerId = customer.id;
      user.stripeCustomerId = customerId;
      await user.save();
      console.log(`[Stripe] New customer created: ${customerId}. Saved to user ${userId}.`);
    } else {
      console.log(`[Stripe] Using existing customer ${customerId} for user ${userId}.`);
    }

    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customerId },
      { apiVersion: '2024-06-20' }
    );
    console.log('[Stripe] Ephemeral key created.');

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      customer: customerId,
      setup_future_usage: 'off_session',
      automatic_payment_methods: {
        enabled: true,
      },
      metadata: {
        firebaseUid: userId,
        amountTokens: amountTokens,
        type: 'token_purchase',
      },
      description: `Purchase of ${amountTokens} tokens by ${user.email}`,
    });
    console.log(`[Stripe] Payment Intent created: ${paymentIntent.id}. Client Secret: ${paymentIntent.client_secret.substring(0, 20)}...`);

    res.json({
      paymentIntent: paymentIntent.client_secret,
      ephemeralKey: ephemeralKey.secret,
      customer: customerId,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    });

  } catch (error) {
    console.error('[Stripe Error] Failed to create payment intent:', error.message);
    res.status(500).json({ message: 'Failed to initiate payment. Please try again.', error: error.message });
  }
});

/**
 * @route POST /api/payments/confirm-token-purchase
 * @description Confirms a successful token purchase after Stripe Payment Sheet completes.
 * @access Private
 * @body {string} paymentIntentId - The ID of the Stripe Payment Intent.
 * @body {number} amountTokens - The number of tokens purchased (for verification).
 */
router.post('/confirm-token-purchase', async (req, res) => {
  const { paymentIntentId, amountTokens } = req.body;
  const userId = req.user.uid;
  const stripe = getStripeInstance();
  const io = getSocketIO();

  console.log(`[PaymentRoutes:/confirm-token-purchase] Request received for user ${userId}, PI: ${paymentIntentId}, tokens: ${amountTokens}`);

  if (!userId || !paymentIntentId || !amountTokens || typeof amountTokens !== 'number' || amountTokens <= 0) {
    console.error('[PaymentRoutes:/confirm-token-purchase] Missing or invalid required fields.');
    return res.status(400).json({ message: 'Missing or invalid required fields.' });
  }

  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    console.log(`[PaymentRoutes:/confirm-token-purchase] Retrieved Payment Intent status: ${paymentIntent.status}`);

    if (
      paymentIntent.status !== 'succeeded' ||
      paymentIntent.metadata.firebaseUid !== userId ||
      parseInt(paymentIntent.metadata.amountTokens, 10) !== amountTokens
    ) {
      console.error(`[Stripe] Payment Intent verification failed for ${paymentIntentId}. Status: ${paymentIntent.status}, User ID mismatch: ${paymentIntent.metadata.firebaseUid} vs ${userId}, Tokens mismatch: ${paymentIntent.metadata.amountTokens} vs ${amountTokens}`);
      return res.status(400).json({ message: 'Payment verification failed or details mismatch.' });
    }
    console.log('[Stripe] Payment Intent verification successful.');

    const existingSession = await Session.findOne({
      stripePaymentIntentId: paymentIntentId,
      type: 'token_purchase',
    });

    if (existingSession) {
      console.warn(`[Stripe] Tokens for PaymentIntent ${paymentIntentId} already credited. Skipping re-credit.`);
      return res.status(200).json({ message: 'Tokens already credited.', newBalance: existingSession.purchasedTokens });
    }
    console.log('[Stripe] Payment Intent not previously credited.');

    const user = await User.findById(userId);
    if (!user) {
      console.error(`[PaymentRoutes:/confirm-token-purchase] User NOT FOUND in DB for UID: ${userId}`);
      return res.status(404).json({ message: 'User not found in database.' });
    }
    console.log(`[PaymentRoutes:/confirm-token-purchase] User found in DB for UID: ${userId}. Current balance: ${user.tokenBalance}`);

    user.tokenBalance += amountTokens;
    await user.save();
    console.log(`[Stripe] User ${userId} credited with ${amountTokens} tokens. New balance: ${user.tokenBalance}`);

    const newSession = new Session({
      tableId: null,
      venueId: null,
      player1Id: userId,
      player2Id: null,
      startTime: new Date(),
      endTime: new Date(),
      cost: paymentIntent.amount / 100,
      status: 'completed',
      type: 'token_purchase',
      purchasedTokens: amountTokens,
      stripePaymentIntentId: paymentIntentId,
    });
    await newSession.save();
    console.log(`[Stripe] Recorded token purchase session ${newSession._id} for PaymentIntent ${paymentIntentId}`);

    io.to(userId).emit('tokenBalanceUpdate', { newBalance: user.tokenBalance });
    console.log(`[Socket.IO] Emitted tokenBalanceUpdate for user ${userId} with new balance: ${user.tokenBalance}`);

    res.status(200).json({ message: 'Tokens loaded successfully!', newBalance: user.tokenBalance });

  } catch (error) {
    console.error('[Stripe Error] Error confirming token purchase:', error.message);
    res.status(500).json({ message: 'Failed to confirm token purchase.', error: error.message });
  }
});


/**
 * @route POST /api/payments/confirm
 * @description Confirms an internal game payment (deduction from user's token balance).
 * @access Private
 */
router.post('/confirm', async (req, res) => {
  const { sessionId } = req.body;
  const userId = req.user.uid;
  const io = getSocketIO();

  console.log(`[PaymentRoutes:/confirm] Game payment confirmation for user ${userId}, session ${sessionId}`);

  try {
    const session = await Session.findById(sessionId);
    if (!session || (session.player1Id !== userId && session.player2Id !== userId)) {
      console.warn(`[PaymentRoutes:/confirm] Unauthorized or session not found for user ${userId}, session ${sessionId}`);
      return res.status(403).send('Unauthorized or game session not found for this user.');
    }

    const user = await User.findById(userId);
    if (!user || user.tokenBalance < session.cost) {
      console.warn(`[PaymentRoutes:/confirm] Insufficient tokens for user ${userId}. Balance: ${user?.tokenBalance}, Cost: ${session.cost}`);
      return res.status(400).send('Insufficient tokens. Please purchase more or try again.');
    }

    user.tokenBalance -= session.cost;
    await user.save();
    console.log(`[PaymentRoutes:/confirm] Tokens deducted for user ${userId}. New balance: ${user.tokenBalance}`);

    session.status = 'active';
    session.endTime = null;
    await session.save();
    console.log(`[PaymentRoutes:/confirm] Session ${sessionId} status set to active.`);

    const table = await Table.findById(session.tableId);
    if (table) {
      console.log(`[PaymentRoutes:/confirm] Table ${table.tableNumber} found for session ${sessionId}.`);
    } else {
      console.warn(`[PaymentRoutes:/confirm] Table not found for session ${sessionId}.`);
    }

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
    console.log(`[Socket.IO] Emitted gameStartConfirmation for players in session ${sessionId}.`);

    io.to(userId).emit('tokenBalanceUpdate', { newBalance: user.tokenBalance });
    console.log(`[Socket.IO] Emitted tokenBalanceUpdate for user ${userId} with new balance: ${user.tokenBalance}`);

    res.status(200).send('Payment confirmed. Game is starting.');

  } catch (error) {
    console.error('Payment confirmation error:', error.message);
    res.status(500).send('Payment failed due to an internal server error.');
  }
});

module.exports = router;

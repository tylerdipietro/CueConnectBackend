// routes/paymentRoutes.js
const express = require('express');
const router = express.Router();
const { getStripeInstance } = require('../config/stripe'); // Stripe instance
const Session = require('../models/Session'); // Session model
const User = require('../models/User'); // User model
const { getSocketIO } = require('../services/socketService'); // Socket.IO instance
const { sendPushNotification } = require('../services/notificationService'); // Push notification service
const Table = require('../models/Table'); // Table model (for gameStartConfirmation)

/**
 * @route POST /api/payments/create-payment-intent
 * @description Creates a Stripe PaymentIntent for purchasing in-app tokens.
 * @access Private
 */
router.post('/create-payment-intent', async (req, res) => {
  const { amount, userId } = req.body; // `amount` in cents, `userId` is Firebase UID
  const stripe = getStripeInstance(); // Get the initialized Stripe instance

  if (!amount || typeof amount !== 'number' || amount <= 0 || !userId) {
    return res.status(400).json({ error: { message: 'Invalid amount or user ID provided.' } });
  }

  try {
    // Create a new internal session record for this token purchase (status 'pending')
    const tokenPurchaseSession = new Session({
      tableId: null,
      venueId: null,
      player1Id: userId, // The user making the purchase
      startTime: new Date(),
      cost: amount / 100, // Store cost in dollars
      status: 'pending',
      type: 'token_purchase',
      purchasedTokens: amount / 100, // Example: 1 token = 1 cent
      stripePaymentIntentId: null, // Will be updated by webhook
    });
    await tokenPurchaseSession.save();

    // Create the Stripe PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount, // amount must be in cents
      currency: 'usd',
      metadata: {
        userId: userId,
        tokensAmount: amount / 100, // Store token quantity in metadata
        sessionType: 'token_purchase',
        sessionId: tokenPurchaseSession._id.toString() // Link to our internal session record
      },
    });

    res.status(200).json({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    console.error('Error creating PaymentIntent:', error.message);
    res.status(500).json({ error: { message: error.message || 'Failed to create payment intent.' } });
  }
});

/**
 * @route POST /api/payments/confirm
 * @description Confirms an internal game payment (deduction from user's token balance).
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

// routes/userRoutes.js
const express = require('express');
const router = express.Router();
const User = require('../models/User'); // User model

/**
 * @route POST /api/users/fcm-token
 * @description Registers a device's FCM token for push notifications.
 * @access Private (requires Firebase auth token)
 */
router.post('/fcm-token', async (req, res) => {
  const { fcmToken } = req.body;
  const userId = req.user.uid; // User ID from authenticated request

  if (!fcmToken) {
    return res.status(400).send('FCM token is required.');
  }

  try {
    // Add the new FCM token to the user's fcmTokens array if it's not already present.
    await User.findByIdAndUpdate(userId, { $addToSet: { fcmTokens: fcmToken } });
    res.status(200).send('FCM token registered successfully.');
  } catch (error) {
    console.error('Error registering FCM token:', error.message);
    res.status(500).send('Failed to register FCM token.');
  }
});

/**
 * @route GET /api/users/balance
 * @description Gets the current authenticated user's token balance.
 * @access Private (requires Firebase auth token)
 */
router.get('/balance', async (req, res) => {
  try {
    // req.user.tokenBalance is already populated by the `verifyFirebaseToken` middleware
    res.json({ balance: req.user.tokenBalance });
  } catch (error) {
    console.error('Error fetching user balance:', error.message);
    res.status(500).send('Failed to fetch user balance.');
  }
});

module.exports = router;

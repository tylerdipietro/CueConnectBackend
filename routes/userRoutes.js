// routes/userRoutes.js
const express = require('express');
const router = express.Router();
const User = require('../models/User'); // User model

/**
 * @route POST /api/users/update-fcm-token
 * @description Registers or updates a device's FCM token for push notifications.
 * @access Private (requires Firebase auth token)
 */
router.post('/update-fcm-token', async (req, res) => {
  const { fcmToken } = req.body;
  const userId = req.user.uid; // User ID from authenticated request

  if (!fcmToken) {
    return res.status(400).json({ message: 'FCM token is required.' });
  }

  try {
    // Find the user by ID
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    // Use $addToSet to add the FCM token only if it's not already present in the array
    if (!user.fcmTokens.includes(fcmToken)) {
      user.fcmTokens.push(fcmToken);
      await user.save();
      console.log(`[UserRoutes] FCM token '${fcmToken}' added for user '${userId}'.`);
    } else {
      console.log(`[UserRoutes] FCM token '${fcmToken}' already exists for user '${userId}'.`);
    }
    
    res.status(200).json({ message: 'FCM token updated successfully.' });
  } catch (error) {
    console.error('[UserRoutes] Error updating FCM token:', error.message);
    res.status(500).json({ message: 'Failed to update FCM token.' });
  }
});

/**
 * @route POST /api/users/sync
 * @description Ensures a user document exists in MongoDB for the authenticated Firebase user.
 * @access Private (requires Firebase auth token)
 */
router.post('/sync', async (req, res) => {
  try {
    const uid = req.user.uid;
    const displayName = req.user.name || 'Unnamed User'; // Use Firebase displayName if available
    const email = req.user.email;

    let user = await User.findById(uid);

    if (!user) {
      user = new User({
        _id: uid,
        displayName,
        email,
        fcmTokens: [], // Initialize fcmTokens array for new users
      });
      await user.save();
      console.log(`[User Sync] Created user: ${displayName} (${uid})`);
    } else if (!user.displayName && displayName) {
      user.displayName = displayName;
      await user.save();
      console.log(`[User Sync] Updated missing displayName for user: ${uid}`);
    }

    res.json({ success: true, user });
  } catch (error) {
    console.error('[User Sync] Error syncing user:', error.message);
    res.status(500).json({ message: 'Failed to sync user.' });
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
    res.status(500).json({ message: 'Failed to fetch user balance.' });
  }
});

module.exports = router;

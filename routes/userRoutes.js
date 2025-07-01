// routes/userRoutes.js
const express = require('express');
const router = express.Router();
const User = require('../models/User'); // User model
const { getSocketIO } = require('../services/socketService'); // Import Socket.IO instance (if used in other user-related routes)

/**
 * @route GET /api/user/profile
 * @description Get the authenticated user's full profile information, including token balance and Stripe Customer ID.
 * This route is expected by the frontend's App.tsx to populate the main user state.
 * @access Private (requires Firebase auth token, handled by middleware)
 */
router.get('/profile', async (req, res) => {
  // req.user is populated by the verifyFirebaseToken middleware
  // It contains basic Firebase info + isAdmin, tokenBalance, stripeCustomerId from MongoDB
  if (!req.user || !req.user.uid) {
    return res.status(401).json({ message: 'User not authenticated or UID missing.' });
  }

  try {
    // Fetch the full user object from MongoDB to ensure the latest data,
    // especially tokenBalance and stripeCustomerId, which might be updated independently.
    const dbUser = await User.findById(req.user.uid).lean();

    if (!dbUser) {
        // This case should ideally not be hit if authMiddleware creates the user,
        // but it's a safeguard.
        return res.status(404).json({ message: 'User profile not found in database after authentication.' });
    }

    res.status(200).json({
      uid: dbUser._id, // Use dbUser._id as the UID
      email: dbUser.email,
      displayName: dbUser.displayName,
      photoURL: dbUser.photoURL,
      isAdmin: dbUser.isAdmin,
      tokenBalance: dbUser.tokenBalance, // Ensure tokenBalance is sent
      stripeCustomerId: dbUser.stripeCustomerId, // Include Stripe Customer ID
      // Do NOT send sensitive data like fcmTokens directly unless necessary and secured
    });
  } catch (error) {
    console.error('[UserRoutes] Error fetching user profile:', error.message);
    res.status(500).json({ message: 'Failed to fetch user profile.' });
  }
});


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
    // Find the user by ID (using _id as per your schema)
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    // Use $addToSet to add the FCM token only if it's not already present in the array
    if (!user.fcmTokens.includes(fcmToken)) {
      user.fcmTokens.push(fcmToken); // Direct push is fine if you're not using $addToSet in update query
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
 * This route can be used for initial user sync or to update basic profile info.
 * @access Private (requires Firebase auth token)
 */
router.post('/sync', async (req, res) => {
  try {
    const uid = req.user.uid;
    // req.user.name is from Firebase decoded token, req.user.displayName is from MongoDB user
    const displayNameFromFirebase = req.user.name || 'Unnamed User';
    const emailFromFirebase = req.user.email;

    let user = await User.findById(uid);

    if (!user) {
      user = new User({
        _id: uid,
        displayName: displayNameFromFirebase,
        email: emailFromFirebase,
        fcmTokens: [], // Initialize fcmTokens array for new users
        tokenBalance: 0, // Initialize token balance for new users
        isAdmin: false, // Default admin status
        // stripeCustomerId will be null initially, populated on first purchase
      });
      await user.save();
      console.log(`[User Sync] Created user: ${displayNameFromFirebase} (${uid})`);
    } else if (!user.displayName && displayNameFromFirebase) {
      // Update displayName if it's missing in DB but available from Firebase
      user.displayName = displayNameFromFirebase;
      await user.save();
      console.log(`[User Sync] Updated missing displayName for user: ${uid}`);
    }

    // Return the updated/found user object, ensuring it includes all relevant fields
    res.json({ success: true, user: {
        _id: user._id,
        displayName: user.displayName,
        email: user.email,
        tokenBalance: user.tokenBalance,
        isAdmin: user.isAdmin,
        stripeCustomerId: user.stripeCustomerId, // Ensure stripeCustomerId is included
        // Do NOT send sensitive data like fcmTokens here
    }});
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
    // However, for the absolute latest balance, it's safer to fetch from DB again.
    const user = await User.findById(req.user.uid).select('tokenBalance').lean();
    if (!user) {
        return res.status(404).json({ message: 'User not found.' });
    }
    res.json({ balance: user.tokenBalance });
  } catch (error) {
    console.error('Error fetching user balance:', error.message);
    res.status(500).json({ message: 'Failed to fetch user balance.' });
  }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const User = require('../models/User');
const authMiddleware = require('../middleware/authMiddleware');

// Apply authMiddleware to all routes in this router
router.use(authMiddleware);

/**
 * @route GET /api/user/profile
 * @description Get the authenticated user's full profile information, including token balance and Stripe Customer ID.
 * This route is expected by the frontend's App.tsx to populate the main user state.
 * @access Private (requires Firebase auth token, handled by middleware)
 */
router.get('/profile', async (req, res) => {
  if (!req.user || !req.user.uid) {
    console.warn('[UserRoutes:/profile] req.user is null or missing UID. This should not happen if authMiddleware is working.');
    return res.status(401).json({ message: 'User not authenticated or UID missing.' });
  }
  console.log(`[UserRoutes:/profile] Attempting to fetch profile for UID: ${req.user.uid}`);

  try {
    const dbUser = await User.findById(req.user.uid).lean();

    if (!dbUser) {
        console.error(`[UserRoutes:/profile] User profile NOT FOUND in DB for UID: ${req.user.uid}`);
        return res.status(404).json({ message: 'User profile not found in database after authentication.' });
    }
    console.log(`[UserRoutes:/profile] User profile found for UID: ${dbUser._id}. Token Balance: ${dbUser.tokenBalance}. Stripe Customer ID: ${dbUser.stripeCustomerId}`);

    res.status(200).json({
      uid: dbUser._id,
      email: dbUser.email,
      displayName: dbUser.displayName,
      photoURL: dbUser.photoURL,
      isAdmin: dbUser.isAdmin,
      tokenBalance: dbUser.tokenBalance,
      stripeCustomerId: dbUser.stripeCustomerId,
    });
  } catch (error) {
    console.error('[UserRoutes:/profile] Error fetching user profile:', error.message);
    res.status(500).json({ message: 'Failed to fetch user profile.' });
  }
});


/**
 * @route POST /api/user/update-fcm-token
 * @description Registers or updates a device's FCM token for push notifications.
 * This endpoint expects a POST request.
 * @access Private (requires Firebase auth token)
 */
router.post('/update-fcm-token', async (req, res) => {
  const { fcmToken } = req.body; // Expecting a single FCM token string
  const userId = req.user.uid;

  if (!fcmToken) {
    console.warn(`[UserRoutes:/update-fcm-token] Missing FCM token in request body for user ${userId}.`);
    return res.status(400).json({ message: 'FCM token is required.' });
  }
  console.log(`[UserRoutes:/update-fcm-token] Received request for user ${userId} with token: ${fcmToken.substring(0, 10)}...`);

  try { // <--- Added try-catch around the entire route handler
    const user = await User.findById(userId);

    if (!user) {
      console.error(`[UserRoutes:/update-fcm-token] User not found in DB for UID: ${userId}.`);
      return res.status(404).json({ message: 'User not found.' });
    }

    // Ensure fcmTokens is initialized as an array
    if (!Array.isArray(user.fcmTokens)) {
      user.fcmTokens = [];
      console.log(`[UserRoutes:/update-fcm-token] Initialized fcmTokens array for user ${userId}.`);
    }

    // Add token only if it's not already in the array
    if (!user.fcmTokens.includes(fcmToken)) {
      user.fcmTokens.push(fcmToken);
      await user.save();
      console.log(`[UserRoutes:/update-fcm-token] FCM token '${fcmToken.substring(0, 10)}...' ADDED for user '${userId}'. Total tokens: ${user.fcmTokens.length}`);
    } else {
      console.log(`[UserRoutes:/update-fcm-token] FCM token '${fcmToken.substring(0, 10)}...' already exists for user '${userId}'. No update needed.`);
    }

    res.status(200).json({ message: 'FCM token updated successfully.' });
  } catch (error) {
    console.error('[UserRoutes:/update-fcm-token] UNEXPECTED ERROR updating FCM token:', error.message, error.stack); // Log stack trace
    res.status(500).json({ message: 'Failed to update FCM token due to server error.' }); // Always send JSON
  }
});

/**
 * @route POST /api/user/sync (Note: The path is /api/user/sync due to server.js mounting)
 * @description Ensures a user document exists in MongoDB for the authenticated Firebase user.
 * @access Private (requires Firebase auth token)
 */
router.post('/sync', async (req, res) => {
  try {
    const uid = req.user.uid;
    const displayNameFromFirebase = req.user.name || 'Unnamed User';
    const emailFromFirebase = req.user.email;
    console.log(`[UserRoutes:/sync] Syncing user: ${uid}`);

    let user = await User.findById(uid);

    if (!user) {
      console.log(`[UserRoutes:/sync] User not found, creating new user for UID: ${uid}`);
      user = new User({
        _id: uid,
        displayName: displayNameFromFirebase,
        email: emailFromFirebase,
        fcmTokens: [], // Initialize as an empty array for new users
        tokenBalance: 0,
        isAdmin: false,
        stripeCustomerId: null, // Ensure this is initialized
      });
      await user.save();
      console.log(`[User Sync] Created user: ${displayNameFromFirebase} (${uid})`);
    } else if (!user.displayName && displayNameFromFirebase) {
      user.displayName = displayNameFromFirebase;
      await user.save();
      console.log(`[User Sync] Updated missing displayName for user: ${uid}`);
    }
    console.log(`[UserRoutes:/sync] User synced. Returning user data for UID: ${user._id}`);

    res.json({ success: true, user: {
        _id: user._id,
        displayName: user.displayName,
        email: user.email,
        tokenBalance: user.tokenBalance,
        isAdmin: user.isAdmin,
        stripeCustomerId: user.stripeCustomerId,
    }});
  } catch (error) {
    console.error('[User Sync] Error syncing user:', error.message);
    res.status(500).json({ message: 'Failed to sync user.' });
  }
});


/**
 * @route GET /api/user/balance (Note: The path is /api/user/balance due to server.js mounting)
 * @description Gets the current authenticated user's token balance.
 * @access Private (requires Firebase auth token)
 */
router.get('/balance', async (req, res) => {
  if (!req.user || !req.user.uid) {
    console.warn('[UserRoutes:/balance] req.user is null or missing UID.');
    return res.status(401).json({ message: 'User not authenticated or UID missing.' });
  }
  console.log(`[UserRoutes:/balance] Fetching balance for UID: ${req.user.uid}`);

  try {
    const user = await User.findById(req.user.uid).select('tokenBalance').lean();
    if (!user) {
        console.error(`[UserRoutes:/balance] User not found in DB for UID: ${req.user.uid}`);
        return res.status(404).json({ message: 'User not found.' });
    }
    res.json({ balance: user.tokenBalance });
  } catch (error) {
    console.error('Error fetching user balance:', error.message);
    res.status(500).json({ message: 'Failed to fetch user balance.' });
  }
});

module.exports = router;

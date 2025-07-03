// middleware/authMiddleware.js
const admin = require('firebase-admin');
const User = require('../models/User'); // Assuming User model is needed to check isAdmin etc.

const authMiddleware = async (req, res, next) => {
  const idToken = req.headers.authorization?.split('Bearer ')[1];

  if (!idToken) {
    console.warn('[AuthMiddleware] No ID token provided.');
    return res.status(401).json({ message: 'No authentication token provided.' });
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken; // Attach decoded Firebase user to request

    // Fetch user profile from MongoDB to get custom claims like isAdmin, tokenBalance
    const userProfile = await User.findById(decodedToken.uid);

    if (userProfile) {
      req.user.isAdmin = userProfile.isAdmin;
      req.user.tokenBalance = userProfile.tokenBalance;
      req.user.stripeCustomerId = userProfile.stripeCustomerId; // Attach Stripe Customer ID
      console.log(`[AuthMiddleware] User ${decodedToken.uid} authenticated. isAdmin: ${userProfile.isAdmin}, tokenBalance: ${userProfile.tokenBalance}`);
    } else {
      // If user doesn't exist in MongoDB but authenticated with Firebase,
      // create a basic profile for them. This handles new sign-ups.
      console.log(`[AuthMiddleware] User ${decodedToken.uid} not found in MongoDB. Creating new profile.`);
      const newUser = new User({
        _id: decodedToken.uid, // Use Firebase UID as MongoDB _id
        email: decodedToken.email,
        displayName: decodedToken.name || decodedToken.email,
        isAdmin: false, // Default to not admin
        tokenBalance: 0, // Default token balance
      });
      await newUser.save();
      req.user.isAdmin = newUser.isAdmin;
      req.user.tokenBalance = newUser.tokenBalance;
      req.user.stripeCustomerId = newUser.stripeCustomerId;
      console.log(`[AuthMiddleware] New user profile created for ${decodedToken.uid}.`);
    }

    next(); // Proceed to the next middleware/route handler
  } catch (error) {
    console.error('[AuthMiddleware Error] Token verification failed:', error.message);
    if (error.code === 'auth/id-token-expired') {
      return res.status(401).json({ message: 'Authentication token expired. Please re-authenticate.' });
    }
    return res.status(401).json({ message: 'Invalid authentication token.' });
  }
};

module.exports = authMiddleware; // Export the middleware function directly

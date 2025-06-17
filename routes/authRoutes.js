// routes/authRoutes.js
const express = require('express');
const router = express.Router();
const { admin } = require('../config/firebase'); // Firebase Admin SDK
const User = require('../models/User'); // User model

// Middleware to verify Firebase ID tokens
const verifyFirebaseToken = async (req, res, next) => {
  const idToken = req.headers.authorization?.split(' ')[1]; // Expected: "Bearer <token>"

  if (!idToken) {
    return res.status(401).send('Authorization token required.');
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken; // Attach decoded Firebase token to request

    // Find or create user in MongoDB based on Firebase UID
    let user = await User.findById(req.user.uid);
    if (!user) {
      user = new User({
        _id: req.user.uid, // Use Firebase UID as MongoDB _id
        displayName: req.user.name || req.user.email,
        email: req.user.email,
        tokenBalance: 0, // New users start with 0 tokens
        fcmTokens: [],
      });
      await user.save();
      console.log(`New user created in MongoDB: ${user.email} (UID: ${user._id}).`);
    }
    // Attach user's current token balance to request for convenience in route handlers
    req.user.tokenBalance = user.tokenBalance;
    next(); // Proceed to the next middleware/route handler
  } catch (error) {
    console.error('Firebase token verification failed:', error.message);
    return res.status(403).send('Invalid or expired authentication token.');
  }
};

// Export the middleware
module.exports = verifyFirebaseToken;

// middleware/authMiddleware.js
const admin = require('firebase-admin'); // Firebase Admin SDK is initialized via config/index.js
const User = require('../models/User'); // Ensure your User model is correctly imported

/**
 * Middleware to verify Firebase ID token and attach user data to req.
 * It also ensures a corresponding user document exists in MongoDB, creating one if necessary.
 */
const verifyFirebaseToken = async (req, res, next) => {
  let idToken;
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    idToken = req.headers.authorization.split(' ')[1];
  }

  if (!idToken) {
    console.warn('[AuthMiddleware] No ID token provided in Authorization header.');
    return res.status(401).json({ message: 'Unauthorized: No token provided.' });
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    console.log(`[AuthMiddleware] Firebase token verified for UID: ${decodedToken.uid}. Email: ${decodedToken.email}`);

    // Find or create user in MongoDB using _id as the Firebase UID
    let user = await User.findById(decodedToken.uid);
    console.log(`[AuthMiddleware] MongoDB user lookup for ${decodedToken.uid}: ${user ? 'Found' : 'Not Found'}`);

    if (!user) {
      console.log(`[AuthMiddleware] Creating new MongoDB user for Firebase UID ${decodedToken.uid}...`);
      user = new User({
        _id: decodedToken.uid, // Use Firebase UID as MongoDB _id
        email: decodedToken.email,
        displayName: decodedToken.name || decodedToken.email.split('@')[0],
        photoURL: decodedToken.picture || null,
        isAdmin: false,
        tokenBalance: 0,
        fcmTokens: [],
        stripeCustomerId: null, // Initialize as null
      });
      await user.save();
      console.log(`[AuthMiddleware] New MongoDB user created and saved for UID: ${decodedToken.uid}`);
    }

    // Attach the MongoDB user document's data to the request object
    req.user = {
      uid: user._id, // Firebase UID from MongoDB _id
      email: user.email,
      displayName: user.displayName,
      photoURL: user.photoURL,
      isAdmin: user.isAdmin,
      tokenBalance: user.tokenBalance,
      stripeCustomerId: user.stripeCustomerId,
      idToken: idToken, // Keep the ID token for potential re-use
    };
    console.log(`[AuthMiddleware] req.user populated for UID: ${req.user.uid}. Token Balance: ${req.user.tokenBalance}. Stripe Customer ID: ${req.user.stripeCustomerId}`);
    next();

  } catch (error) {
    console.error('[AuthMiddleware] CRITICAL ERROR: Failed to verify Firebase token or process user:', error.message);
    if (error.code === 'auth/id-token-expired') {
      return res.status(401).json({ message: 'Unauthorized: Token expired. Please re-authenticate.' });
    } else if (error.code === 'auth/argument-error' || error.code === 'auth/invalid-id-token') {
      return res.status(401).json({ message: 'Unauthorized: Invalid token provided.' });
    }
    return res.status(401).json({ message: 'Unauthorized: Invalid or expired token or user data issue.' });
  }
};

module.exports = { verifyFirebaseToken };

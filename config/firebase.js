// config/firebase.js
const admin = require('firebase-admin');

// Function to initialize Firebase Admin SDK
// It now returns the initialized admin instance
const initializeFirebaseAdmin = (serviceAccountKeyBase64, projectId) => {
  // Prevent re-initialization if already initialized
  if (admin.apps.length > 0) {
    console.log("Firebase Admin SDK already initialized. Returning existing instance.");
    return admin;
  }

  try {
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      // For Google Cloud environments (e.g., Heroku with GOOGLE_APPLICATION_CREDENTIALS set)
      admin.initializeApp({
        projectId: projectId // Project ID might still be useful for clarity or specific APIs
      });
      console.log("Firebase Admin SDK initialized using GOOGLE_APPLICATION_CREDENTIALS.");
    } else if (serviceAccountKeyBase64) {
      // If service account key is provided directly as a base64 encoded string
      const decodedServiceAccountJson = Buffer.from(serviceAccountKeyBase64, 'base64').toString('utf8');
      const serviceAccount = JSON.parse(decodedServiceAccountJson);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      console.log("Firebase Admin SDK initialized using base64 encoded service account key.");
    } else {
      // Default initialization (might work for Firebase Hosting or Cloud Functions where context provides credentials)
      admin.initializeApp();
      console.log("Firebase Admin SDK initialized with default credentials. Ensure project is configured.");
    }
    return admin; // Return the initialized admin instance
  } catch (error) {
    console.error("Firebase Admin SDK initialization failed:", error.message);
    process.exit(1); // Exit if initialization fails
  }
};

// Export the initialization function. The 'admin' object itself is global after init.
module.exports = {
  initializeFirebaseAdmin
};

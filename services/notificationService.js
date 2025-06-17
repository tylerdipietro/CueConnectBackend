// services/notificationService.js
const { admin } = require('../config/firebase'); // Firebase Admin SDK
const User = require('../models/User'); // User model

// Function to send a push notification to a specific user via FCM
async function sendPushNotification(userId, title, body, data = {}) {
  try {
    const user = await User.findById(userId);
    if (!user || user.fcmTokens.length === 0) {
      console.log(`No FCM tokens found for user ${userId}. Skipping push notification.`);
      return;
    }

    const message = {
      notification: {
        title: title,
        body: body,
      },
      data: data, // Custom data payload (must be strings)
      tokens: user.fcmTokens, // Array of FCM tokens for the user's devices
    };

    const response = await admin.messaging().sendMulticast(message);
    console.log(`Push notification sent to ${response.successCount} devices, ${response.failureCount} failed.`);
    
    // Optionally, handle failed tokens (e.g., remove invalid tokens from the user's profile)
    if (response.failureCount > 0) {
        response.responses.forEach((resp, idx) => {
            if (!resp.success) {
                console.error(`Failed to send message to token ${user.fcmTokens[idx]}: ${resp.error}`);
                // Example: if (resp.error.code === 'messaging/registration-token-not-registered') {
                //   // Logic to remove user.fcmTokens[idx] from user.fcmTokens array
                // }
            }
        });
    }
  } catch (error) {
    console.error('Error sending push notification:', error.message);
  }
}

module.exports = {
  sendPushNotification
};

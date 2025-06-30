// services/notificationService.js
const admin = require('firebase-admin'); // Firebase Admin SDK should already be initialized in config/index.js

/**
 * Sends a push notification to one or more device tokens.
 * @param {string|string[]} fcmTokens - A single FCM token string or an array of FCM token strings.
 * @param {string} title - The title of the notification.
 * @param {string} body - The body text of the notification.
 * @param {object} [data] - Optional: A data payload to send with the notification (key-value pairs).
 * This data is accessible in the app even when it's in the background/killed.
 */
const sendPushNotification = async (fcmTokens, title, body, data = {}) => {
  if (!fcmTokens || (Array.isArray(fcmTokens) && fcmTokens.length === 0)) {
    console.warn('[Notification Service] No FCM tokens provided. Skipping notification.');
    return;
  }

  // Ensure fcmTokens is always an array for sendEachForMulticast
  const tokensArray = Array.isArray(fcmTokens) ? fcmTokens : [fcmTokens];

  const message = {
    notification: {
      title: title,
      body: body,
    },
    data: data, // Custom data payload
    // APNs (iOS) specific configuration
    apns: {
      payload: {
        aps: {
          sound: 'default', // Play default notification sound
          // If you want to customize badge count, add 'badge': X here
        },
      },
    },
    // Android specific configuration (optional, but good practice for completeness)
    android: {
      priority: 'high',
      notification: {
        sound: 'default',
        channelId: 'default_notification_channel', // Ensure you create this channel in your Android app
      },
    },
    tokens: tokensArray, // Use 'tokens' for sendEachForMulticast
  };

  try {
    // Send a message to the devices corresponding to the provided registration tokens.
    const response = await admin.messaging().sendEachForMulticast(message);
    console.log('[Notification Service] Successfully sent message:', response);

    // You can iterate through response.responses to check individual success/failure
    response.responses.forEach((resp, idx) => {
      if (resp.success) {
        console.log(`[Notification Service] Message sent successfully to token ${tokensArray[idx]}.`);
      } else {
        console.error(`[Notification Service] Failed to send message to token ${tokensArray[idx]}:`, resp.error);
        // Handle specific errors, e.g., if token is invalid, remove it from your database
        if (resp.error.code === 'messaging/invalid-registration-token' || resp.error.code === 'messaging/registration-token-not-registered') {
          console.warn(`[Notification Service] Invalid or expired token: ${tokensArray[idx]}. Consider removing from database.`);
          // TODO: Implement logic to remove invalid tokens from your User model's fcmTokens array
        }
      }
    });

  } catch (error) {
    console.error('[Notification Service] Error sending push notification:', error);
  }
};

module.exports = {
  sendPushNotification,
};

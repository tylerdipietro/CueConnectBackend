// services/notificationService.js
const admin = require('firebase-admin');

const sendPushNotification = async (fcmTokens, title, body, data = {}) => {
  if (!fcmTokens || (Array.isArray(fcmTokens) && fcmTokens.length === 0)) {
    console.warn('[Notification Service] No FCM tokens provided. Skipping notification.');
    return;
  }

  const tokensArray = Array.isArray(fcmTokens) ? fcmTokens : [fcmTokens];

  const message = {
    tokens: tokensArray,
    notification: {
      title,
      body,
    },
    data: {
      ...data,
    },
    android: {
      priority: 'high',
      notification: {
        sound: 'default',
        channelId: 'default_notification_channel', // You must define this channel in your Android app
      },
    },
    apns: {
      payload: {
        aps: {
          sound: 'default',
        },
      },
    },
  };

  console.log('[Notification Service] Payload being sent:', JSON.stringify(message, null, 2));

  try {
    const response = await admin.messaging().sendEachForMulticast(message);
    console.log('[Notification Service] Successfully sent message:', response);

    response.responses.forEach((resp, idx) => {
      if (resp.success) {
        console.log(`[Notification Service] ✅ Sent to token ${tokensArray[idx]}`);
      } else {
        console.error(`[Notification Service] ❌ Failed for token ${tokensArray[idx]}:`, resp.error);
        if (
          resp.error.code === 'messaging/invalid-registration-token' ||
          resp.error.code === 'messaging/registration-token-not-registered'
        ) {
          console.warn(`[Notification Service] 🚫 Invalid or expired token: ${tokensArray[idx]}`);
          // TODO: Remove from DB
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

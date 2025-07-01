// services/notificationService.js
const admin = require('firebase-admin');
const sendPushNotification = async (fcmTokens, title, body, data = {}) => {
  if (!fcmTokens || (Array.isArray(fcmTokens) && fcmTokens.length === 0)) {
    console.warn('[Notification Service] No FCM tokens provided. Skipping notification.');
    return;
  }

  const tokensArray = Array.isArray(fcmTokens) ? fcmTokens : [fcmTokens];

  // ✅ Convert all data values to strings
  const stringifiedData = {};
  for (const key in data) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      stringifiedData[key] = String(data[key]);
    }
  }

  const message = {
    notification: {
      title: title,
      body: body,
    },
    data: stringifiedData, // 🔁 use stringified values only-
    apns: {
      payload: {
        aps: {
          sound: 'default',
        },
      },
    },
    android: {
      priority: 'high',
      notification: {
        sound: 'default',
        channelId: 'default_notification_channel',
      },
    },
    tokens: tokensArray,
  };

  try {
    const response = await admin.messaging().sendEachForMulticast(message);
    console.log('[Notification Service] Successfully sent message:', response);

    response.responses.forEach((resp, idx) => {
      if (resp.success) {
        console.log(`[Notification Service] ✅ Message sent to token ${tokensArray[idx]}`);
      } else {
        console.error(`[Notification Service] ❌ Failed for token ${tokensArray[idx]}:`, resp.error);
        if (
          resp.error.code === 'messaging/invalid-registration-token' ||
          resp.error.code === 'messaging/registration-token-not-registered'
        ) {
          console.warn(`[Notification Service] Invalid or expired token: ${tokensArray[idx]}.`);
        }
      }
    });
  } catch (error) {
    console.error('[Notification Service] 🔥 Error sending push notification:', error);
  }
};

module.exports = {
  sendPushNotification,
};

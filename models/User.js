// models/User.js
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  _id: {
    type: String, // Firebase UID
    required: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  displayName: {
    type: String,
    required: false,
    trim: true,
  },
  isAdmin: {
    type: Boolean,
    default: false,
  },
  tokenBalance: {
    type: Number,
    default: 0,
    min: 0,
  },
  stripeCustomerId: {
    type: String,
    required: false,
    unique: true,
    sparse: true,
  },
  // CRITICAL FIX: Changed from singular 'fcmToken' String to plural 'fcmTokens' Array of Strings
  fcmTokens: { // Firebase Cloud Messaging tokens for push notifications
    type: [String], // Define as an array of Strings
    default: [],    // Initialize as an empty array
  },
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

module.exports = User;

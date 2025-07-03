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
    required: false, // Display name might not always be present from Firebase
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
    sparse: true, // Allows null values but enforces uniqueness for non-null values
  },
  fcmToken: { // Firebase Cloud Messaging token for push notifications
    type: String,
    required: false,
    unique: true,
    sparse: true,
  },
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

module.exports = User;

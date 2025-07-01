// models/User.js
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  firebaseUid: {
    type: String,
    required: true,
    unique: true,
    index: true, // Index for faster lookups
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
    trim: true,
  },
  photoURL: {
    type: String,
  },
  isAdmin: {
    type: Boolean,
    default: false,
  },
  tokenBalance: {
    type: Number,
    default: 0,
    min: 0, // Tokens cannot be negative
  },
  fcmTokens: [
    {
      type: String,
      unique: true, // Each FCM token should be unique for a user
      sparse: true, // Allows multiple documents to have null/undefined values for this field
    },
  ],
  // NEW: Field to store Stripe Customer ID
  stripeCustomerId: {
    type: String,
    unique: true,
    sparse: true, // Allows null values, so not every user needs one immediately
    index: true,
  },
}, { timestamps: true });

// Optional: Add a pre-save hook or a method to ensure displayName is set if not provided
userSchema.pre('save', function(next) {
  if (!this.displayName && this.email) {
    this.displayName = this.email.split('@')[0]; // Use part of email as default display name
  }
  next();
});

const User = mongoose.model('User', userSchema);

module.exports = User;

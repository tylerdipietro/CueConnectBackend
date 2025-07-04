// models/User.js
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  _id: String, // Firebase UID will be used as primary key
  displayName: String,
  email: String,
  tokenBalance: { type: Number, default: 0 },
  fcmTokens: [String], // Array to store FCM device tokens for push notifications
  isAdmin: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  // NEW: Field to store Stripe Customer ID
  stripeCustomerId: {
    type: String,
    unique: true, // Ensures each Stripe Customer ID is unique in your database
    sparse: true, // Allows multiple documents to have a null/undefined value for this field
                 // This is important because not all users will have a Stripe Customer ID immediately
    index: true, // Adds an index for faster lookups if you query by stripeCustomerId
  },
});

// Pre-save hook to update the 'updatedAt' timestamp
userSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('User', userSchema);
// models/User.js
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  _id: String, // Firebase UID will be used as primary key
  displayName: String,
  email: String,
  tokenBalance: { type: Number, default: 0 },
  fcmTokens: [String], // Array to store FCM device tokens for push notifications
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});
userSchema.pre('save', function(next) { this.updatedAt = new Date(); next(); }); // Update timestamp on save

module.exports = mongoose.model('User', userSchema);

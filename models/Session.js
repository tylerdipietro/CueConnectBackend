// models/Session.js
const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema({
  tableId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Table',
    required: true,
  },
  venueId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Venue',
    required: true,
  },
  player1Id: {
    type: String, // Firebase UID
    ref: 'User',
    required: true,
  },
  player2Id: {
    type: String, // Firebase UID, optional
    ref: 'User',
  },
  startTime: {
    type: Date,
    default: Date.now,
  },
  endTime: {
    type: Date,
  },
  cost: {
    type: Number, // Cost in tokens for this game
    required: true,
  },
  status: {
    type: String,
    enum: ['active', 'completed', 'cancelled', 'awaiting_payment'], // Added awaiting_payment
    default: 'active',
  },
  type: {
    type: String, // e.g., 'per_game', 'time_based', 'drop_balls_now', 'queue_invite'
    required: true,
  },
  // Added for Stripe payments, if applicable.
  // CRITICAL FIX: Add unique: true and sparse: true to allow multiple null values.
  stripePaymentIntentId: {
    type: String,
    unique: true, // This ensures uniqueness for actual payment IDs
    sparse: true, // This allows multiple null values, fixing the E11000 error
  },
  stripePaymentStatus: {
    type: String,
    enum: ['pending', 'succeeded', 'failed'],
    required: function() { return this.stripePaymentIntentId != null; } // Required only if intent ID exists
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

sessionSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

// Ensure compound index for tableId and currentSessionId if you have one elsewhere
// For example, to find an active session on a table:
// sessionSchema.index({ tableId: 1, status: 1 });


module.exports = mongoose.model('Session', sessionSchema);
// models/Session.js
const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema({
  tableId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Table',
    required: function() { return this.type !== 'token_purchase'; }
  },
  venueId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Venue',
    required: function() { return this.type !== 'token_purchase'; }
  },
  player1Id: {
    type: String, // Firebase UID
    required: true,
  },
  player2Id: {
    type: String, // Firebase UID, optional for single-player activities or token purchases
    required: false,
  },
  startTime: {
    type: Date,
    default: Date.now,
    required: true,
  },
  endTime: {
    type: Date,
    required: false, // Can be null if game is ongoing or for token purchase
  },
  cost: {
    type: Number, // Cost in tokens or monetary value
    required: true,
    min: 0,
  },
  status: {
    type: String,
    enum: ['pending', 'active', 'completed', 'cancelled', 'disputed', 'token_purchase_pending', 'token_purchase_completed'],
    default: 'pending',
    required: true,
  },
  type: {
    type: String,
    // ADDED 'direct_join_fallback' to the enum
    enum: ['game', 'practice', 'token_purchase', 'direct_join', 'direct_join_fallback'],
    required: true,
  },
  // Specific fields for token purchases
  purchasedTokens: {
    type: Number,
    required: function() { return this.type === 'token_purchase'; },
    min: 0,
  },
  stripePaymentIntentId: {
    type: String,
    required: function() { return this.type === 'token_purchase'; },
    unique: true,
    sparse: true,
  },
  stripePaymentStatus: {
    type: String,
    enum: ['succeeded', 'pending', 'failed', 'canceled'],
    required: function() { return this.type === 'token_purchase'; },
    default: function() { return this.type === 'token_purchase' ? 'pending' : undefined; }
  },
  winnerId: {
    type: String,
    required: false,
  },
  location: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point',
    },
    coordinates: {
      type: [Number],
      required: false,
    },
  },
}, { timestamps: true });

sessionSchema.index({ stripePaymentIntentId: 1 }, { unique: true, sparse: true });

const Session = mongoose.model('Session', sessionSchema);

module.exports = Session;

// models/Session.js
const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema({
  tableId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Table',
    // Make optional, as token purchases won't have a tableId
    required: function() { return this.type !== 'token_purchase'; }
  },
  venueId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Venue',
    // Make optional, as token purchases won't have a venueId
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
    required: false, // Can be null if game is ongoing or for token purchases
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
    enum: ['game', 'practice', 'token_purchase'], // Differentiate between game sessions and token purchases
    required: true,
  },
  // Specific fields for token purchases
  purchasedTokens: {
    type: Number,
    required: function() { return this.type === 'token_purchase'; }, // Required only for token purchases
    min: 0,
  },
  stripePaymentIntentId: {
    type: String,
    required: function() { return this.type === 'token_purchase'; }, // Required only for token purchases
    unique: true, // Ensures idempotency: one payment intent leads to one session record
    sparse: true, // Allows null for non-token_purchase sessions
  },
  // NEW: stripePaymentStatus field
  stripePaymentStatus: {
    type: String,
    enum: ['succeeded', 'pending', 'failed', 'canceled'], // Status from Stripe
    required: function() { return this.type === 'token_purchase'; }, // Required only for token purchases
    default: function() { return this.type === 'token_purchase' ? 'pending' : undefined; } // Default to 'pending' for new token purchases
  },
  // Add other game-specific fields if needed, e.g., winnerId, score, etc.
  winnerId: {
    type: String, // Firebase UID of the winner
    required: false,
  },
  // For location-based services, if a session is tied to a specific table's location
  location: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point',
    },
    coordinates: {
      type: [Number], // [longitude, latitude]
      required: false, // Not required for token_purchase
    },
  },
}, { timestamps: true });

// Index for efficient querying by paymentIntentId
sessionSchema.index({ stripePaymentIntentId: 1 }, { unique: true, sparse: true });

const Session = mongoose.model('Session', sessionSchema);

module.exports = Session;

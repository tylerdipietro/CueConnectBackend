// models/Session.js
const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema({
  tableId: { type: mongoose.Schema.Types.ObjectId, ref: 'Table', required: true },
  venueId: { type: mongoose.Schema.Types.ObjectId, ref: 'Venue', required: true },
  player1Id: { type: String, ref: 'User', required: true }, // Player 1's Firebase UID
  player2Id: { type: String, ref: 'User', default: null }, // Player 2's Firebase UID (optional)
  startTime: { type: Date, default: Date.now },
  endTime: { type: Date },
  cost: { type: Number, required: true }, // Cost of the session/game in tokens
  status: {
    type: String,
    enum: ['pending', 'active', 'completed', 'failed', 'cancelled'],
    default: 'active' // 'active' for game in progress, 'pending' for payment awaiting
  },
  type: {
    type: String,
    enum: ['per_game', 'token_purchase', 'hourly', 'daily', 'drop_balls_now'], // Added 'drop_balls_now'
    required: true
  },
  // If payment is handled externally (e.g., Stripe Payment Intent ID)
  stripePaymentIntentId: { type: String, default: null },
  // For token purchase sessions
  purchasedTokens: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});
sessionSchema.pre('save', function(next) { this.updatedAt = new Date(); next(); });

module.exports = mongoose.model('Session', sessionSchema);
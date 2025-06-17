// models/Session.js
const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema({
  tableId: { type: mongoose.Schema.Types.ObjectId, ref: 'Table', default: null },
  venueId: { type: mongoose.Schema.Types.ObjectId, ref: 'Venue', default: null },
  player1Id: { type: String, ref: 'User' }, // Primary player (payer for drop_balls_now or winner)
  player2Id: { type: String, ref: 'User', default: null }, // Challenger
  startTime: { type: Date, default: Date.now },
  endTime: { type: Date, default: null },
  cost: Number,          // Cost in tokens for this session (relevant for 'per_game', 'drop_balls_now')
  status: { type: String, enum: ['pending', 'active', 'completed', 'cancelled'], default: 'pending' },
  type: { type: String, enum: ['per_game', 'drop_balls_now', 'token_purchase'] }, // Type of session
  // Fields specific to token purchases:
  purchasedTokens: { type: Number, default: 0 }, // Amount of tokens purchased
  stripePaymentIntentId: { type: String, unique: true, sparse: true, default: null }, // Link to Stripe PaymentIntent
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});
sessionSchema.pre('save', function(next) { this.updatedAt = new Date(); next(); });

module.exports = mongoose.model('Session', sessionSchema);

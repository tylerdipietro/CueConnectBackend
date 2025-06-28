// models/Table.js
const mongoose = require('mongoose');

const tableSchema = new mongoose.Schema({
  venueId: { type: mongoose.Schema.Types.ObjectId, ref: 'Venue', required: true },
  tableNumber: { type: mongoose.Schema.Types.Mixed, required: true }, // Can be number or string (e.g., "A1")
  esp32DeviceId: { type: String, unique: true, sparse: true }, // Unique, but allows nulls
  status: { // Updated: More granular status for game flow
    type: String,
    enum: ['available', 'occupied', 'queued', 'in_play', 'awaiting_confirmation', 'maintenance', 'out_of_order'],
    default: 'available'
  },
  currentPlayers: { // NEW: Tracks active players on the table
    player1Id: { type: String, ref: 'User', default: null },
    player2Id: { type: String, ref: 'User', default: null }
  },
  currentSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', default: null }, // Current active game session
  queue: [String], // Array of user UIDs (strings) in the queue
  lastGameEndedAt: { type: Date, default: null }, // Timestamp of when the last game on this table ended
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// IMPORTANT: Add a compound unique index to ensure tableNumber is unique PER VENUE
tableSchema.index({ venueId: 1, tableNumber: 1 }, { unique: true });

tableSchema.pre('save', function(next) { this.updatedAt = new Date(); next(); });

module.exports = mongoose.model('Table', tableSchema);
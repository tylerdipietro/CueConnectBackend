// models/Table.js
const mongoose = require('mongoose');

const tableSchema = new mongoose.Schema({
  venueId: { type: mongoose.Schema.Types.ObjectId, ref: 'Venue' },
  tableNumber: String,
  esp32DeviceId: String, // Unique ID for the ESP32 connected to this table
  status: { type: String, enum: ['available', 'in_play', 'in_queue', 'out_of_order'], default: 'available' },
  currentPlayers: {        // For the active game
    player1Id: { type: String, ref: 'User', default: null }, // Current player / winner (Firebase UID)
    player2Id: { type: String, ref: 'User', default: null }  // Challenger (Firebase UID)
  },
  currentSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', default: null }, // Reference to active session
  queue: [                 // Ordered list of users waiting for this table
    {
      userId: { type: String, ref: 'User' },
      joinedAt: { type: Date, default: Date.now },
      status: { type: String, enum: ['waiting', 'invited', 'playing', 'declined'], default: 'waiting' }
    }
  ],
  lastGameEndedAt: { type: Date, default: null }, // Timestamp of last game completion
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});
tableSchema.pre('save', function(next) { this.updatedAt = new Date(); next(); });

module.exports = mongoose.model('Table', tableSchema);

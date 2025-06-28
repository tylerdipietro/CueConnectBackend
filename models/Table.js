// models/Table.js
const mongoose = require('mongoose');

const tableSchema = new mongoose.Schema({
  venueId: { type: mongoose.Schema.Types.ObjectId, ref: 'Venue', required: true },
  tableNumber: { type: mongoose.Schema.Types.Mixed, required: true }, // Can be number or string (e.g., "A1")
  esp32DeviceId: { type: String, unique: true, sparse: true }, // Unique, but allows nulls
  status: { type: String, enum: ['available', 'occupied', 'queued', 'maintenance'], default: 'available' },
  currentSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Session' },
  queue: [String], // REVERTED: Array of user UIDs stored as plain strings
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// IMPORTANT: Add a compound unique index to ensure tableNumber is unique PER VENUE
tableSchema.index({ venueId: 1, tableNumber: 1 }, { unique: true });

tableSchema.pre('save', function(next) { this.updatedAt = new Date(); next(); });

module.exports = mongoose.model('Table', tableSchema);
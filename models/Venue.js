// models/Venue.js
const mongoose = require('mongoose');

const venueSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true }, // Added required, trim for better data quality
  address: { type: String, required: true, trim: true },
  ownerId: { type: String, ref: 'User' },
  location: {
    type: { type: String, default: 'Point', enum: ['Point'], required: true },
    coordinates: { type: [Number], required: true } // [longitude, latitude]
  },
  perGameCost: { type: Number, default: 10 }, // Default cost in tokens
  numberOfTables: { type: Number, default: 0 }, // Keeps a count of tables, can be managed by logic
  // ADDED: Array to store references to associated Table documents
  tableIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Table' }], // This will store IDs of tables
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

venueSchema.index({ location: '2dsphere' });
venueSchema.pre('save', function(next) { this.updatedAt = new Date(); next(); });

module.exports = mongoose.model('Venue', venueSchema);

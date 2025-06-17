// models/Venue.js
const mongoose = require('mongoose');

const venueSchema = new mongoose.Schema({
  name: String,
  address: String,
  ownerId: { type: String, ref: 'User' }, // Reference to User (optional)
  location: {          // GeoJSON Point for geospatial queries
    type: { type: String, default: 'Point' },
    coordinates: [Number] // [longitude, latitude] -> IMPORTANT: MongoDB stores as [longitude, latitude]
  },
  perGameCost: Number, // Cost in tokens for a single game at this venue
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});
venueSchema.index({ location: '2dsphere' }); // Create 2dsphere index for geospatial queries
venueSchema.pre('save', function(next) { this.updatedAt = new Date(); next(); });

module.exports = mongoose.model('Venue', venueSchema);

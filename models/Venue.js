// models/Venue.js
const mongoose = require('mongoose');

const venueSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  address: {
    type: String,
    required: true,
    trim: true,
  },
  location: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point',
      required: true,
    },
    coordinates: {
      type: [Number], // [longitude, latitude]
      required: true,
    },
  },
  ownerId: {
    type: String, // Firebase UID of the owner
    required: true,
  },
  numberOfTables: {
    type: Number,
    required: true,
    min: 0,
  },
  tableIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Table',
  }],
  // NEW FIELD: Cost per game in tokens
  perGameCost: {
    type: Number,
    required: true, // Make it required, set a default if needed in route
    default: 10, // Default cost of 10 tokens per game
    min: 0,
  },
}, { timestamps: true });

// Add a 2dsphere index for geospatial queries
venueSchema.index({ location: '2dsphere' });

const Venue = mongoose.model('Venue', venueSchema);

module.exports = Venue;

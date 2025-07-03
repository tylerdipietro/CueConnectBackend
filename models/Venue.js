// backend/models/Venue.js

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
      type: String, // Don't do `{ location: { type: String } }`
      enum: ['Point'], // 'location.type' must be 'Point'
      required: true,
      default: 'Point', // Set default to 'Point'
    },
    coordinates: {
      type: [Number], // Array of [longitude, latitude]
      required: true,
      index: '2dsphere', // Create a geospatial index
    },
  },
  numberOfTables: {
    type: Number,
    required: true,
    min: 0,
    default: 0,
  },
  perGameCost: { // NEW FIELD: Cost per game in tokens
    type: Number,
    required: true,
    min: 0,
    default: 10, // Default cost, can be changed by admin
  },
  // You might want to add fields like:
  // owner: {
  //   type: mongoose.Schema.Types.ObjectId,
  //   ref: 'User',
  // },
  // contactInfo: String,
  // operatingHours: String,
}, {
  timestamps: true, // Adds createdAt and updatedAt timestamps
});

const Venue = mongoose.model('Venue', venueSchema);

module.exports = Venue;

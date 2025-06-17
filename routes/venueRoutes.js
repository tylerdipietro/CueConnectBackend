// routes/venueRoutes.js
const express = require('express');
const router = express.Router();
const Venue = require('../models/Venue'); // Venue model
const Table = require('../models/Table'); // Table model (for /tables endpoint)

/**
 * @route GET /api/venues/nearby
 * @description Retrieves a list of nearby bars/venues based on provided coordinates.
 * @access Private (requires Firebase auth token)
 * @query lat (latitude), lng (longitude), radiusMiles (search radius in miles)
 */
router.get('/nearby', async (req, res) => {
  const { lat, lng, radiusMiles } = req.query;

  if (!lat || !lng || !radiusMiles) {
    return res.status(400).send('Latitude, longitude, and radius are required query parameters.');
  }

  const radiusKm = parseFloat(radiusMiles) * 1.60934; // Convert miles to kilometers
  const radiusMeters = radiusKm * 1000; // Convert kilometers to meters

  if (isNaN(radiusMeters) || radiusMeters <= 0) {
      return res.status(400).send('Invalid radius provided.');
  }

  try {
    // Use MongoDB's $geoNear aggregation to find venues within the specified radius, sorted by distance.
    const venues = await Venue.aggregate([
      {
        $geoNear: {
          near: { type: 'Point', coordinates: [parseFloat(lng), parseFloat(lat)] },
          distanceField: 'dist.calculated', // A new field that will contain the distance
          maxDistance: radiusMeters,
          spherical: true, // Use spherical geometry for Earth-like surfaces
        },
      },
      { $sort: { 'dist.calculated': 1 } }, // Sort by distance (nearest first)
    ]);

    res.json(venues);
  } catch (error) {
    console.error('Error fetching nearby venues:', error.message);
    res.status(500).send('Failed to fetch nearby venues. Please try again later.');
  }
});

/**
 * @route GET /api/venues/:venueId/tables
 * @description Retrieves all tables for a specific venue.
 * @access Private (requires Firebase auth token)
 */
router.get('/:venueId/tables', async (req, res) => {
  try {
    const tables = await Table.find({ venueId: req.params.venueId }).lean(); // .lean() to get plain JavaScript objects
    res.json(tables);
  } catch (error) {
    console.error('Error fetching tables for venue:', error.message);
    res.status(500).send('Failed to fetch tables for the venue.');
  }
});

module.exports = router;

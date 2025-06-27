// routes/venueRoutes.js
const express = require('express');
const router = express.Router();
const Venue = require('../models/Venue'); // Venue model
const Table = require('../models/Table'); // Table model

/**
 * @route GET /api/venues/nearby
 * @description Retrieves a list of nearby bars/venues based on provided coordinates.
 * @access Private (requires Firebase auth token & `verifyFirebaseToken` middleware)
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
    const venues = await Venue.aggregate([
      {
        $geoNear: {
          near: { type: 'Point', coordinates: [parseFloat(lng), parseFloat(lat)] },
          distanceField: 'dist.calculated',
          maxDistance: radiusMeters,
          spherical: true,
        },
      },
      { $sort: { 'dist.calculated': 1 } },
    ]);

    res.json(venues);
  } catch (error) {
    console.error('Error fetching nearby venues:', error.message);
    res.status(500).send('Failed to fetch nearby venues. Please try again later.');
  }
});

/**
 * @route POST /api/venues
 * @description Registers a new venue and creates associated tables.
 * @access Private (requires Firebase auth token and admin privileges)
 * @body name, address, latitude, longitude, numberOfTables
 */
router.post('/', async (req, res) => {
  // The `verifyFirebaseToken` middleware already attached to '/api/venues'
  // should have populated `req.user` with Firebase decoded token and `isAdmin` status from MongoDB.
  if (!req.user || req.user.isAdmin !== true) {
    return res.status(403).json({ message: 'Forbidden: Admin access required.' });
  }

  const { name, address, latitude, longitude, numberOfTables } = req.body;

  if (!name || !address || !latitude || !longitude || numberOfTables === undefined || isNaN(numberOfTables)) {
    return res.status(400).json({ message: 'All fields (name, address, latitude, longitude, numberOfTables) are required and valid.' });
  }

  try {
    // Create the new venue
    const newVenue = new Venue({
      name,
      address,
      ownerId: req.user.uid, // Optionally assign the admin user as the owner
      location: {
        type: 'Point',
        coordinates: [parseFloat(longitude), parseFloat(latitude)] // MongoDB expects [longitude, latitude]
      },
      numberOfTables: parseInt(numberOfTables, 10), // Store the number of tables
      // perGameCost could be set by admin later, or default
      perGameCost: 10 // Example default cost
    });
    const savedVenue = await newVenue.save();

    // Create individual Table documents for this venue
    const tablesToCreate = [];
    for (let i = 0; i < numberOfTables; i++) {
      tablesToCreate.push({
        venueId: savedVenue._id,
        tableNumber: i + 1, // Simple sequential numbering
        status: 'available', // Default status for new tables
        // other table properties like QR code, Bluetooth ID could be added here
      });
    }
    // Use insertMany for efficiency when adding multiple tables
    await Table.insertMany(tablesToCreate);

    res.status(201).json(savedVenue); // Respond with the newly created venue
  } catch (error) {
    console.error('Error registering venue:', error.message);
    // More specific error handling could be added, e.g., for duplicate venue names
    if (error.code === 11000) { // MongoDB duplicate key error
      res.status(409).json({ message: 'A venue with this name or location already exists.' });
    } else {
      res.status(500).json({ message: 'Failed to register venue. Please try again later.' });
    }
  }
});

/**
 * @route GET /api/venues/:venueId/tables
 * @description Retrieves all tables for a specific venue.
 * @access Private (requires Firebase auth token & `verifyFirebaseToken` middleware)
 */
router.get('/:venueId/tables', async (req, res) => {
  try {
    const tables = await Table.find({ venueId: req.params.venueId }).lean();
    res.json(tables);
  } catch (error) {
    console.error('Error fetching tables for venue:', error.message);
    res.status(500).send('Failed to fetch tables for the venue.');
  }
});

module.exports = router;
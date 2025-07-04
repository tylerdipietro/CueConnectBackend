// routes/venueRoutes.js
const express = require('express');
const router = express.Router();
const Venue = require('../models/Venue');
const Table = require('../models/Table'); // Import Table model
const authMiddleware = require('../middleware/authMiddleware');
const { getSocketIO } = require('../services/socketService');
// Import gameService functions for populating table details
const { populateTablePlayersDetails, populateQueueWithUserDetails } = require('../services/gameService');
const { getPopulatedTableWithPerGameCost } = require('../services/tableHelpers'); 


// Apply authMiddleware to all routes in this router
router.use(authMiddleware);

/**
 * @route POST /api/venues
 * @description Register a new venue and create its tables.
 * @access Private (Admin only)
 * @body {string} name
 * @body {string} address
 * @body {number} latitude
 * @body {number} longitude
 * @body {number} numberOfTables
 * @body {number} [perGameCost] - Optional: Cost per game in tokens. Defaults to 10.
 */
router.post('/', async (req, res) => {
  const { name, address, latitude, longitude, numberOfTables, perGameCost } = req.body;
  const ownerId = req.user.uid; // Firebase UID from authenticated user

  if (!req.user.isAdmin) {
    return res.status(403).json({ message: 'Access denied. Only administrators can register venues.' });
  }

  if (!name || !address || typeof latitude !== 'number' || typeof longitude !== 'number' || !numberOfTables || numberOfTables <= 0) {
    return res.status(400).json({ message: 'Missing required venue information (name, address, latitude, longitude, numberOfTables).' });
  }

  try {
    const newVenue = new Venue({
      name,
      address,
      location: {
        type: 'Point',
        coordinates: [longitude, latitude], // GeoJSON stores as [longitude, latitude]
      },
      ownerId,
      numberOfTables,
      perGameCost: perGameCost !== undefined ? perGameCost : 10, // Set default if not provided
    });

    const savedVenue = await newVenue.save();

    const createdTables = [];
    for (let i = 1; i <= numberOfTables; i++) {
      const newTable = new Table({
        venueId: savedVenue._id,
        tableNumber: i,
        status: 'available',
      });
      await newTable.save();
      createdTables.push(newTable._id);
    }

    savedVenue.tableIds = createdTables;
    await savedVenue.save();

    res.status(201).json(savedVenue);
  } catch (error) {
    console.error('Error registering venue:', error);
    res.status(500).json({ message: 'Server error during venue registration.', error: error.message });
  }
});

/**
 * @route GET /api/venues
 * @description Get all venues (Admin only).
 * @access Private (Admin only)
 */
router.get('/', async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ message: 'Access denied. Only administrators can view all venues.' });
  }
  try {
    const venues = await Venue.find({});
    res.json(venues);
  } catch (error) {
    console.error('Error fetching all venues:', error);
    res.status(500).json({ message: 'Server error fetching venues.' });
  }
});

/**
 * @route GET /api/venues/nearby
 * @description Get venues near a given latitude and longitude.
 * @access Private
 * @query {number} lat - Latitude
 * @query {number} lon - Longitude
 * @query {number} [radiusMiles=5] - Radius in miles
 */
router.get('/nearby', async (req, res) => {
  const { lat, lon, radiusMiles } = req.query;

  if (typeof lat === 'undefined' || typeof lon === 'undefined') {
    return res.status(400).json({ message: 'Latitude and longitude are required.' });
  }

  const latitude = parseFloat(lat);
  const longitude = parseFloat(lon);
  const radius = parseFloat(radiusMiles || '5') / 3963.2; // Convert miles to radians (Earth's radius in miles)

  if (isNaN(latitude) || isNaN(longitude) || isNaN(radius)) {
    return res.status(400).json({ message: 'Invalid latitude, longitude, or radius.' });
  }

  try {
    const venues = await Venue.find({
      location: {
        $geoWithin: {
          $centerSphere: [[longitude, latitude], radius]
        }
      }
    }).lean(); // Use .lean() for faster queries if you don't need Mongoose documents

    res.json(venues);
  } catch (error) {
    console.error('Error fetching nearby venues:', error);
    res.status(500).json({ message: 'Server error fetching nearby venues.' });
  }
});

/**
 * @route GET /api/venues/:venueId
 * @description Get a specific venue by ID.
 * @access Private
 */
router.get('/:venueId', async (req, res) => {
  try {
    const venue = await Venue.findById(req.params.venueId);
    if (!venue) {
      return res.status(404).json({ message: 'Venue not found.' });
    }
    res.json(venue);
  } catch (error) {
    console.error('Error fetching venue by ID:', error);
    res.status(500).json({ message: 'Server error fetching venue.' });
  }
});

/**
 * @route GET /api/venues/:venueId/tables-detailed
 * @description Get all tables for a specific venue, with populated player and queue details, and perGameCost from venue.
 * @access Private
 */
router.get('/:venueId/tables-detailed', async (req, res) => {
  const { venueId } = req.params;
  try {
    // First, find the venue to get its perGameCost (this part is still explicit for initial fetch)
    const venue = await Venue.findById(venueId).lean();
    if (!venue) {
      console.error(`[VENUE_ROUTES] Venue not found for ID: ${venueId}`);
      return res.status(404).json({ message: 'Venue not found.' });
    }
    const venuePerGameCost = typeof venue.perGameCost === 'number' ? venue.perGameCost : 10;
    console.log(`[VENUE_ROUTES] Fetched venue ${venue.name} (${venueId}), perGameCost: ${venuePerGameCost}`);

    // Then, fetch tables for that venue
    const tables = await Table.find({ venueId }).lean();
    console.log(`[VENUE_ROUTES] Found ${tables.length} tables for venue ${venueId}`);

    // Populate player and queue details for each table AND add perGameCost
    const populatedTables = await Promise.all(
      tables.map(async (table) => {
        // Use the helper function here too for consistency
        const fullyPopulatedTable = await getPopulatedTableWithPerGameCost(table._id);
        // Ensure perGameCost is correctly attached, even if helper returned null or missing cost
        return fullyPopulatedTable ? { ...fullyPopulatedTable, perGameCost: fullyPopulatedTable.perGameCost || venuePerGameCost } : null;
      })
    );

    // Filter out any nulls if a table couldn't be populated
    const validPopulatedTables = populatedTables.filter(t => t !== null);

    res.json(validPopulatedTables);
  } catch (error) {
    console.error('Error fetching detailed tables for venue:', error);
    res.status(500).json({ message: 'Server error fetching detailed tables.', error: error.message });
  }
});


/**
 * @route PUT /api/venues/:venueId
 * @description Update a venue's details.
 * @access Private (Admin only, or venue owner)
 * @body {string} [name]
 * @body {string} [address]
 * @body {number} [latitude]
 * @body {number} [longitude]
 * @body {number} [numberOfTables]
 * @body {number} [perGameCost]
 */
router.put('/:venueId', async (req, res) => {
  const { name, address, latitude, longitude, numberOfTables, perGameCost } = req.body;
  const { venueId } = req.params;
  const userId = req.user.uid;

  try {
    const venue = await Venue.findById(venueId);
    if (!venue) {
      return res.status(404).json({ message: 'Venue not found.' });
    }

    // Authorization: Only admin or venue owner can update
    if (!req.user.isAdmin && venue.ownerId !== userId) {
      return res.status(403).json({ message: 'Access denied. You are not authorized to update this venue.' });
    }

    if (name) venue.name = name;
    if (address) venue.address = address;
    if (typeof latitude === 'number' && typeof longitude === 'number') {
      venue.location = {
        type: 'Point',
        coordinates: [longitude, latitude],
      };
    }
    if (typeof numberOfTables === 'number' && numberOfTables >= 0) {
      // Handle changes in numberOfTables: add or remove tables
      const currentTablesCount = await Table.countDocuments({ venueId: venue._id });
      if (numberOfTables > currentTablesCount) {
        // Add new tables
        for (let i = currentTablesCount + 1; i <= numberOfTables; i++) {
          const newTable = new Table({
            venueId: venue._id,
            tableNumber: i,
            status: 'available',
          });
          await newTable.save();
          venue.tableIds.push(newTable._id);
        }
      } else if (numberOfTables < currentTablesCount) {
        // Remove tables (consider logic for active sessions before removal)
        // For simplicity, we'll just remove the last tables.
        // In a real app, you'd want to check if tables are in use.
        const tablesToRemove = await Table.find({ venueId: venue._id })
          .sort({ tableNumber: -1 })
          .limit(currentTablesCount - numberOfTables);

        for (const table of tablesToRemove) {
          await Table.findByIdAndDelete(table._id);
          venue.tableIds = venue.tableIds.filter(id => id.toString() !== table._id.toString());
        }
      }
      venue.numberOfTables = numberOfTables;
    }
    // NEW: Update perGameCost
    if (typeof perGameCost === 'number' && perGameCost >= 0) {
      venue.perGameCost = perGameCost;
    }

    const updatedVenue = await venue.save();
    res.json(updatedVenue);
  } catch (error) {
    console.error('Error updating venue:', error);
    res.status(500).json({ message: 'Server error updating venue.', error: error.message });
  }
});


/**
 * @route DELETE /api/venues/:venueId
 * @description Delete a venue and its associated tables.
 * @access Private (Admin only)
 */
router.delete('/:venueId', async (req, res) => {
  const { venueId } = req.params;

  if (!req.user.isAdmin) {
    return res.status(403).json({ message: 'Access denied. Only administrators can delete venues.' });
  }

  try {
    const venue = await Venue.findById(venueId);
    if (!venue) {
      return res.status(404).json({ message: 'Venue not found.' });
    }

    // Delete all tables associated with the venue
    await Table.deleteMany({ venueId: venue._id });
    console.log(`Deleted tables for venue ${venueId}`);

    // Delete the venue itself
    await Venue.findByIdAndDelete(venueId);
    console.log(`Deleted venue ${venueId}`);

    res.status(200).json({ message: 'Venue and associated tables deleted successfully.' });
  } catch (error) {
    console.error('Error deleting venue:', error);
    res.status(500).json({ message: 'Server error deleting venue.', error: error.message });
  }
});


module.exports = router;

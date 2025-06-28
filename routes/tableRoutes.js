// routes/tableRoutes.js
const express = require('express');
const router = express.Router();
const Table = require('../models/Table');
const Venue = require('../models/Venue');
const User = require('../models/User'); // NEW: Import User model
const { getSocketIO } = require('../services/socketService');

/**
 * Helper function to populate queue with user display names
 * @param {Array<string>} queueIds - Array of user UIDs (strings)
 * @returns {Promise<Array<{_id: string, displayName: string}>>}
 */
const populateQueueWithUserDetails = async (queueIds) => {
  if (queueIds.length === 0) {
    return [];
  }
  // FIX: Removed '-_id' from select. Mongoose includes _id by default,
  // ensuring 'user._id' is available for matching against 'uid'.
  const users = await User.find({ _id: { $in: queueIds } }).select('displayName').lean();
  // Map back to maintain order and include _id (Firebase UID)
  const populatedQueue = queueIds.map(uid => {
    const user = users.find(u => u._id === uid); // 'user._id' will now be correctly available
    return { _id: uid, displayName: user ? user.displayName : 'Unnamed User' };
  });
  return populatedQueue;
};

/**
 * @route POST /api/tables
 * @description Registers a new table for a specific venue.
 * @access Private (requires Firebase auth token and admin privileges)
 * @body venueId, tableNumber, esp32DeviceId (optional)
 */
router.post('/', async (req, res) => {
  if (!req.user || req.user.isAdmin !== true) {
    return res.status(403).json({ message: 'Forbidden: Admin access required.' });
  }

  const { venueId, tableNumber, esp32DeviceId } = req.body;

  if (!venueId || !tableNumber) {
    return res.status(400).json({ message: 'Venue ID and Table Number are required.' });
  }

  try {
    const venue = await Venue.findById(venueId);
    if (!venue) {
      return res.status(404).json({ message: 'Venue not found.' });
    }

    const newTable = new Table({
      venueId,
      tableNumber,
      esp32DeviceId,
      status: 'available',
    });

    const savedTable = await newTable.save();

    await Venue.findByIdAndUpdate(
      venueId,
      { $inc: { numberOfTables: 1 } },
      { new: true }
    );

    res.status(201).json(savedTable);
  } catch (error) {
    console.error('Error registering table:', error);

    if (error.code === 11000) {
      if (error.keyPattern && error.keyPattern.venueId && error.keyPattern.tableNumber) {
        return res.status(409).json({ message: `A table with number "${tableNumber}" already exists for this venue.` });
      } else if (error.keyPattern && error.keyPattern.esp32DeviceId) {
        return res.status(409).json({ message: `An ESP32 device with ID "${esp32DeviceId}" is already registered.` });
      }
    }
    res.status(500).json({ message: 'Failed to register table. Please try again later.' });
  }
});

/**
 * @route GET /api/venues/:venueId/tables
 * @description Retrieves all tables for a specific venue, manually populating queue user display names.
 * @access Private (requires Firebase auth token)
 */
router.get('/:venueId/tables', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Unauthorized: Authentication required to view tables.' });
  }

  try {
    const tables = await Table.find({ venueId: req.params.venueId }).lean();

    // Manually populate display names for each table's queue
    const tablesWithPopulatedQueue = await Promise.all(tables.map(async (table) => {
      const populatedQueue = await populateQueueWithUserDetails(table.queue);
      return { ...table, queue: populatedQueue };
    }));

    res.json(tablesWithPopulatedQueue);
  } catch (error) {
    console.error('Error fetching tables for venue:', error.message);
    res.status(500).send('Failed to fetch tables for the venue.');
  }
});

/**
 * @route PUT /api/tables/:tableId
 * @description Allows an admin to update an existing table's details.
 * @access Private (requires Firebase auth token and admin privileges)
 * @param tableId - ID of the table to update
 * @body tableNumber (optional), esp32DeviceId (optional)
 */
router.put('/:tableId', async (req, res) => {
  if (!req.user || req.user.isAdmin !== true) {
    return res.status(403).json({ message: 'Forbidden: Admin access required.' });
  }

  const { tableId } = req.params;
  const { tableNumber, esp32DeviceId } = req.body;

  if (tableNumber === undefined && esp32DeviceId === undefined) {
    return res.status(400).json({ message: 'At least one field (tableNumber or esp32DeviceId) must be provided for update.' });
  }

  try {
    const table = await Table.findById(tableId);

    if (!table) {
      return res.status(404).json({ message: 'Table not found.' });
    }

    const updateFields = {};
    let oldTableNumber = table.tableNumber;
    let oldEsp32DeviceId = table.esp32DeviceId;

    if (tableNumber !== undefined && String(tableNumber) !== String(table.tableNumber)) {
      updateFields.tableNumber = tableNumber;
    }
    if (esp32DeviceId !== undefined && esp32DeviceId !== table.esp32DeviceId) {
      updateFields.esp32DeviceId = esp32DeviceId;
    }

    if (Object.keys(updateFields).length === 0) {
      return res.status(200).json({ message: 'No changes detected for table.', table });
    }

    const updatedTable = await Table.findByIdAndUpdate(
      tableId,
      { $set: updateFields },
      { new: true, runValidators: true }
    );

    res.status(200).json(updatedTable);
  } catch (error) {
    console.error('Error updating table:', error);

    if (error.code === 11000) {
      if (error.keyPattern && error.keyPattern.venueId && error.keyPattern.tableNumber) {
        return res.status(409).json({ message: `A table with number "${tableNumber}" already exists in this venue.` });
      } else if (error.keyPattern && error.keyPattern.esp32DeviceId) {
        return res.status(409).json({ message: `An ESP32 device with ID "${esp32DeviceId}" is already registered to another table.` });
      }
    }
    res.status(500).json({ message: 'Failed to update table. Please try again later.' });
  }
});


/**
 * @route POST /api/tables/:tableId/join-queue
 * @description Allows a user to join the queue for a specific table.
 * @access Private (requires Firebase auth token)
 * @param tableId - ID of the table to join the queue for
 */
router.post('/:tableId/join-queue', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Unauthorized: Authentication required.' });
  }

  const { tableId } = req.params;
  const userId = req.user.uid;

  try {
    const table = await Table.findById(tableId);

    if (!table) {
      return res.status(404).json({ message: 'Table not found.' });
    }

    if (table.queue.includes(userId)) { // Check if string UID is already in the array
      return res.status(409).json({ message: 'You are already in this table\'s queue.' });
    }

    table.queue.push(userId);
    await table.save();

    // Manually populate for the response and socket update
    const populatedQueue = await populateQueueWithUserDetails(table.queue);

    const io = getSocketIO();
    io.to(table.venueId.toString()).emit('queueUpdate', {
      tableId: table._id,
      newQueue: populatedQueue, // Send the manually populated queue
      status: table.status
    });
    console.log(`User ${userId} joined queue for table ${tableId}. Current queue: ${populatedQueue.length}`);

    res.status(200).json({ message: 'Successfully joined queue.', queue: populatedQueue });
  } catch (error) {
    console.error('Error joining queue:', error.message);
    res.status(500).json({ message: 'Failed to join queue. Please try again later.' });
  }
});

/**
 * @route POST /api/tables/:tableId/leave-queue
 * @description Allows a user to leave the queue for a specific table.
 * @access Private (requires Firebase auth token)
 * @param tableId - ID of the table to leave the queue for
 */
router.post('/:tableId/leave-queue', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Unauthorized: Authentication required.' });
  }

  const { tableId } = req.params;
  const userId = req.user.uid;

  try {
    const table = await Table.findById(tableId);

    if (!table) {
      return res.status(404).json({ message: 'Table not found.' });
    }

    const initialQueueLength = table.queue.length;
    table.queue = table.queue.filter(id => id !== userId); // Filter by string UID

    if (table.queue.length === initialQueueLength) {
      return res.status(404).json({ message: 'You are not in this table\'s queue.' });
    }

    await table.save();

    // Manually populate for the response and socket update
    const populatedQueue = await populateQueueWithUserDetails(table.queue);

    const io = getSocketIO();
    io.to(table.venueId.toString()).emit('queueUpdate', {
      tableId: table._id,
      newQueue: populatedQueue, // Send the manually populated queue
      status: table.status
    });
    console.log(`User ${userId} left queue for table ${tableId}. Current queue: ${populatedQueue.length}`);


    res.status(200).json({ message: 'Successfully left queue.', queue: populatedQueue });
  } catch (error) {
    console.error('Error leaving queue:', error.message);
    res.status(500).json({ message: 'Failed to leave queue. Please try again later.' });
  }
});

/**
 * @route POST /api/tables/:tableId/clear-queue
 * @description Allows an admin to clear the queue for a specific table.
 * @access Private (requires Firebase auth token and admin privileges)
 * @param tableId - ID of the table to clear the queue for
 */
router.post('/:tableId/clear-queue', async (req, res) => {
  if (!req.user || req.user.isAdmin !== true) {
    return res.status(403).json({ message: 'Forbidden: Admin access required.' });
  }

  const { tableId } = req.params;

  try {
    const table = await Table.findById(tableId);

    if (!table) {
      return res.status(404).json({ message: 'Table not found.' });
    }

    if (table.queue.length === 0) {
      return res.status(200).json({ message: 'Queue is already empty.' });
    }

    table.queue = [];
    await table.save();

    // Queue is empty, so populatedQueue will be empty too
    const populatedQueue = []; // An empty array is the correct populated queue here

    const io = getSocketIO();
    io.to(table.venueId.toString()).emit('queueUpdate', {
      tableId: table._id,
      newQueue: populatedQueue, // Send the empty queue
      status: table.status
    });
    console.log(`Admin ${req.user.uid} cleared queue for table ${tableId}.`);

    res.status(200).json({ message: 'Queue cleared successfully.', queue: populatedQueue });
  } catch (error) {
    console.error('Error clearing queue:', error.message);
    res.status(500).json({ message: 'Failed to clear queue. Please try again later.' });
  }
});


module.exports = router;
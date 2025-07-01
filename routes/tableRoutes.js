// routes/tableRoutes.js
const express = require('express');
const router = express.Router();
const Table = require('../models/Table'); // Table model
const Venue = require('../models/Venue'); // Venue model (for perGameCost and updating tableIds)
const Session = require('../models/Session'); // Session model
const User = require('../models/User'); // Import User model for manual population
const { getSocketIO } = require('../services/socketService'); // Socket.IO instance
const { sendPushNotification } = require('../services/notificationService'); // Push notification service
const { inviteNextPlayer } = require('../services/gameService'); // Game logic service

/**
 * Helper function to populate queue with user display names
 * This function fetches User documents based on the UIDs in the queue
 * and returns an array of objects containing the user's _id (UID) and displayName.
 * @param {Array<string>} queueIds - Array of user UIDs (strings) stored in the queue.
 * @returns {Promise<Array<{_id: string, displayName: string}>>} - A promise that resolves to an array
 * of objects, each containing the user's _id and displayName. If a user is not found,
 * their displayName will be 'Unnamed User'.
 */
const populateQueueWithUserDetails = async (queueIds) => {
  if (queueIds.length === 0) {
    return [];
  }
  try {
    // Find users whose _id (Firebase UID) is in the queueIds array.
    // Select 'displayName'. Mongoose will include '_id' by default unless explicitly excluded.
    const users = await User.find({ _id: { $in: queueIds } }).select('displayName').lean();

    // Map the original queueIds array to maintain order and associate with fetched user details.
    const populatedQueue = queueIds.map(uid => {
      // Find the user object that matches the current UID
      const user = users.find(u => u._id === uid);
      // Return an object with _id and displayName, defaulting to 'Unnamed User' if not found
      return { _id: uid, displayName: user ? user.displayName : 'Unnamed User' };
    });
    return populatedQueue;
  } catch (error) {
    console.error('Error in populateQueueWithUserDetails:', error.message);
    // Return an empty array or re-throw, depending on desired error handling
    return queueIds.map(uid => ({ _id: uid, displayName: 'Error User' })); // Fallback to avoid breaking frontend
  }
};


/**
 * @route POST /api/tables
 * @description Registers a new individual table for a specific venue.
 * @access Private (requires Firebase auth token and admin privileges)
 * @body venueId, tableNumber, esp32DeviceId
 */
router.post('/', async (req, res) => {
  // Ensure the user is an admin
  // This check relies on `req.user.isAdmin` being set by the `verifyFirebaseToken` middleware in server.js
  if (!req.user || req.user.isAdmin !== true) {
    return res.status(403).json({ message: 'Forbidden: Admin access required to register tables.' });
  }

  const { venueId, tableNumber, esp32DeviceId } = req.body;

  if (!venueId || !tableNumber || !esp32DeviceId) {
    return res.status(400).json({ message: 'Venue ID, Table Number, and ESP32 Device ID are required.' });
  }

  try {
    // 1. Verify if the venueId actually exists
    const venue = await Venue.findById(venueId);
    if (!venue) {
      return res.status(404).json({ message: 'Venue not found.' });
    }

    // 2. Check for duplicate esp32DeviceId (assuming it's unique across all tables)
    const existingTableWithEsp32Id = await Table.findOne({ esp32DeviceId: esp32DeviceId });
    if (existingTableWithEsp32Id) {
        return res.status(409).json({ message: 'Another table with this ESP32 Device ID already exists.' });
    }

    // 3. Check for duplicate tableNumber within the same venue
    const existingTableInVenue = await Table.findOne({ venueId: venueId, tableNumber: tableNumber });
    if (existingTableInVenue) {
        return res.status(409).json({ message: `Table number "${tableNumber}" already exists in this venue.` });
    }

    // 4. Create the new Table document
    const newTable = new Table({
      venueId,
      tableNumber,
      esp32DeviceId,
      status: 'available', // Default status for a newly registered table
      currentPlayers: { player1Id: null, player2Id: null },
      currentSessionId: null,
      queue: [], // Initialize empty queue
      lastGameEndedAt: null,
    });
    const savedTable = await newTable.save();

    // 5. Update the associated Venue document to include the new table's ID
    // We use $push to add the new table's ID to the tableIds array
    // We also increment numberOfTables, ensuring this count reflects individually added tables
    await Venue.findByIdAndUpdate(
        venueId,
        { $push: { tableIds: savedTable._id }, $inc: { numberOfTables: 1 } },
        { new: true, useFindAndModify: false } // `new: true` returns the updated document
    );

    res.status(201).json(savedTable); // Respond with the newly created table
  } catch (error) {
    console.error('Error registering table:', error.message);
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

    // Crucial: Manually populate display names for each table's queue
    // Use Promise.all to await all population operations concurrently
    const tablesWithPopulatedQueue = await Promise.all(tables.map(async (table) => {
      const populatedQueue = await populateQueueWithUserDetails(table.queue);
      return { ...table, queue: populatedQueue }; // Replace the raw queue array with the populated one
    }));

    res.json(tablesWithPopulatedQueue); // Send the fully populated tables array
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
    // Note: oldTableNumber and oldEsp32DeviceId are not strictly needed for this update logic,
    // but useful for logging or more complex conditional updates.
    // let oldTableNumber = table.tableNumber;
    // let oldEsp32DeviceId = table.esp32DeviceId;

    if (tableNumber !== undefined && String(tableNumber) !== String(table.tableNumber)) {
      updateFields.tableNumber = tableNumber;
    }
    if (esp32DeviceId !== undefined && esp32DeviceId !== table.esp32DeviceId) {
      updateFields.esp32DeviceId = esp32DeviceId;
    }

    if (Object.keys(updateFields).length === 0) {
      // If no actual changes were requested, return the current table object
      return res.status(200).json({ message: 'No changes detected for table.', table });
    }

    const updatedTable = await Table.findByIdAndUpdate(
      tableId,
      { $set: updateFields },
      { new: true, runValidators: true } // `new: true` returns the updated doc, `runValidators` runs schema validators
    );

    res.status(200).json(updatedTable);
  } catch (error) {
    console.error('Error updating table:', error);

    // Handle duplicate key errors specifically for tableNumber (within venue) or esp32DeviceId
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
 * @description Allows a user to join the waitlist/queue for a specific table.
 * @access Private
 */
router.post('/:tableId/join-queue', async (req, res) => {
  const tableId = req.params.tableId;
  const userId = req.user.uid;
  const io = getSocketIO();

  try {
    const table = await Table.findById(tableId);
    if (!table) return res.status(404).send('Table not found.');

    // Check if user is already in the queue or is currently playing
    const alreadyInQueue = table.queue.includes(userId); // Since queue stores simple strings
    const isPlaying = table.currentPlayers.player1Id === userId || table.currentPlayers.player2Id === userId;

    if (alreadyInQueue || isPlaying) {
      return res.status(400).send('You are already in queue or playing at this table.');
    }

    table.queue.push(userId); // Add userId string to the queue array
    await table.save();

    // Manually populate the queue for the Socket.IO update and the response
    const populatedQueue = await populateQueueWithUserDetails(table.queue);

    // Emit real-time update to all clients in the venue's room
    io.to(table.venueId.toString()).emit('queueUpdate', {
      tableId: table._id,
      newQueue: populatedQueue, // Send the manually populated queue
      status: table.status // Send the table's current status
    });
    console.log(`User ${userId} joined queue for table ${tableId}. Current queue length: ${populatedQueue.length}`);

    // Also send a specific notification to the joining user
    io.to(userId).emit('queueJoined', { tableId: table._id, tableNumber: table.tableNumber });

    res.status(200).send('Joined queue successfully.');

    // If the table is available and no one is playing, invite the next player (could be the one who just joined)
    if (table.status === 'available' && !table.currentPlayers.player1Id && populatedQueue.length > 0) {
      inviteNextPlayer(tableId, io, sendPushNotification);
    }

  } catch (error) {
    console.error('Error joining queue:', error.message);
    res.status(500).send('Failed to join queue.');
  }
});

/**
 * @route POST /api/tables/:tableId/accept-invitation
 * @description Handles a player accepting an invitation to play (their turn in queue).
 * @access Private
 */
router.post('/:tableId/accept-invitation', async (req, res) => {
  const tableId = req.params.tableId;
  const userId = req.user.uid;
  const io = getSocketIO();

  try {
    const table = await Table.findById(tableId);
    if (!table) return res.status(404).send('Table not found.');

    // This block assumes `queue` stores objects with `userId` and `status` properties,
    // which contradicts `queue: [String]` in models/Table.js.
    // If your queue schema only stores UIDs, this logic needs to be re-evaluated.
    const queueEntry = table.queue.find(q => q.userId === userId && q.status === 'invited');
    if (!queueEntry) {
      return res.status(400).send('No active invitation for you at this table, or your invitation has expired.');
    }

    queueEntry.status = 'playing';

    const venue = await Venue.findById(table.venueId);
    if (!venue || typeof venue.perGameCost !== 'number' || venue.perGameCost <= 0) {
        return res.status(500).send('Game cost not configured for this venue, or is invalid.');
    }
    const gameCost = venue.perGameCost;

    const currentWinnerId = table.currentPlayers.player1Id;
    if (currentWinnerId && currentWinnerId !== userId) {
      table.currentPlayers.player2Id = userId;
    } else {
      table.currentPlayers.player1Id = userId;
    }

    table.status = 'in_play';

    // Remove users who are now playing from the queue
    table.queue = table.queue.filter(q =>
        (q.userId !== table.currentPlayers.player1Id && q.userId !== table.currentPlayers.player2Id) &&
        q.status !== 'invited' // Also remove invited entries as they're now playing or expired
    );

    const newSession = new Session({
      tableId: table._id,
      venueId: table.venueId,
      player1Id: table.currentPlayers.player1Id,
      player2Id: table.currentPlayers.player2Id,
      startTime: new Date(),
      cost: gameCost,
      status: 'pending', // Pending until payment is confirmed
      type: 'per_game',
    });
    await newSession.save();
    table.currentSessionId = newSession._id;
    await table.save();

    // Trigger payment flow on the client
    io.to(userId).emit('paymentRequired', {
      sessionId: newSession._id,
      amount: newSession.cost,
      tableNumber: table.tableNumber
    });

    // Manually populate queue for the table status update
    const populatedQueue = await populateQueueWithUserDetails(table.queue);
    io.to(table.venueId.toString()).emit('tableStatusUpdate', { ...table.toJSON(), queue: populatedQueue });
    res.status(200).send('Invitation accepted. Awaiting payment confirmation from client.');

  } catch (error) {
    console.error('Error accepting invitation:', error.message);
    res.status(500).send('Failed to accept invitation. An internal server error occurred.');
  }
});

/**
 * @route POST /api/tables/:tableId/decline-invitation
 * @description Handles a player declining an invitation to play.
 * @access Private
 */
router.post('/:tableId/decline-invitation', async (req, res) => {
  const tableId = req.params.tableId;
  const userId = req.user.uid;
  const io = getSocketIO();

  try {
    const table = await Table.findById(tableId);
    if (!table) return res.status(404).send('Table not found.');

    // This block assumes `queue` stores objects with `userId` and `status` properties,
    // which contradicts `queue: [String]` in models/Table.js.
    // If your queue schema only stores UIDs, this logic needs to be re-evaluated.
    const queueEntryIndex = table.queue.findIndex(q => q.userId === userId && q.status === 'invited');
    if (queueEntryIndex === -1) {
      return res.status(400).send('No active invitation found for you.');
    }

    // Set status to 'declined' for this entry
    table.queue[queueEntryIndex].status = 'declined';
    await table.save();

    // Manually populate queue for the table status update
    const populatedQueue = await populateQueueWithUserDetails(table.queue);
    io.to(table.venueId.toString()).emit('tableStatusUpdate', { ...table.toJSON(), queue: populatedQueue });
    res.status(200).send('Invitation declined.');

    // Invite the next player in queue if any
    inviteNextPlayer(tableId, io, sendPushNotification);

  } catch (error) {
    console.error('Error declining invitation:', error.message);
    res.status(500).send('Failed to decline invitation.');
  }
});

/**
 * @route POST /api/tables/:tableId/drop-balls-now
 * @description Allows a user to pay and immediately activate an available table.
 * @access Private
 */
router.post('/:tableId/drop-balls-now', async (req, res) => {
  const tableId = req.params.tableId;
  const userId = req.user.uid;
  const io = getSocketIO();

  try {
    const table = await Table.findById(tableId);
    if (!table) return res.status(404).send('Table not found.');
    if (table.status === 'in_play') return res.status(400).send('Table is currently in play. Cannot drop balls now.');
    if (table.status === 'out_of_order') return res.status(400).send('Table is out of order and cannot be used.');

    const venue = await Venue.findById(table.venueId);
    if (!venue || typeof venue.perGameCost !== 'number' || venue.perGameCost <= 0) {
      return res.status(500).send('Game cost not configured for this venue, or is invalid.');
    }
    const cost = venue.perGameCost;

    const user = await User.findById(userId);
    if (!user || user.tokenBalance < cost) {
      return res.status(400).send('Insufficient tokens to drop balls. Please purchase more tokens.');
    }

    user.tokenBalance -= cost;
    await user.save();

    // Clear the existing queue as a direct play takes precedence
    if (table.queue.length > 0) {
      table.queue.forEach(q => {
        // q here is a string (UID), so q.userId will be undefined.
        // It should be io.to(q).emit(...)
        io.to(q).emit('queueUpdate', { // FIX: Changed q.userId to q
          tableId: table._id,
          tableNumber: table.tableNumber,
          message: `Table ${table.tableNumber} is now occupied by a direct play. Your queue position has been removed.`,
          status: 'removed_by_direct_play',
          newQueue: [] // Send empty queue for this specific user
        });
        sendPushNotification(
          q, // FIX: Changed q.userId to q
          'Table Occupied!',
          `Table ${table.tableNumber} is now being used by a direct play. Your queue position has been removed.`
        );
      });
      table.queue = []; // Clear the queue
    }

    table.status = 'in_play';
    table.currentPlayers.player1Id = userId;
    table.currentPlayers.player2Id = null; // No second player for direct play initially

    const newSession = new Session({
      tableId: table._id,
      venueId: table.venueId,
      player1Id: userId,
      player2Id: null,
      startTime: new Date(),
      cost: cost,
      status: 'active', // Directly active since payment is confirmed
      type: 'drop_balls_now',
    });
    await newSession.save();
    table.currentSessionId = newSession._id;
    await table.save();

    // Confirm to the specific user that balls are dropped
    io.to(userId).emit('dropBallsNowConfirmed', {
      tableId: table._id,
      tableNumber: table.tableNumber,
      esp32DeviceId: table.esp32DeviceId
    });
    // Update user's token balance in real-time
    io.to(userId).emit('tokenBalanceUpdate', { newBalance: user.tokenBalance });
    sendPushNotification(userId, 'Game Started!', `Balls dropped on Table ${table.tableNumber}! Enjoy your game.`);

    // Manually populate queue (now empty) for the table status update to all clients
    const populatedQueue = await populateQueueWithUserDetails(table.queue); // Will be empty
    io.to(table.venueId.toString()).emit('tableStatusUpdate', { ...table.toJSON(), queue: populatedQueue });

    res.status(200).send('Balls dropped and game started successfully!');

  } catch (error) {
    console.error('Error dropping balls now:', error.message);
    res.status(500).send(error.message || 'Failed to drop balls due to an internal server error.');
  }
});

/**
 * @route POST /api/tables/:tableId/game-completed
 * @description Reports a game completion, updates table status, and handles winner-stays logic.
 * @access Private (can be called by ESP32 via a secure adapter, or authorized client)
 */
router.post('/:tableId/game-completed', async (req, res) => {
  const tableId = req.params.tableId;
  const { winnerId } = req.body; // winnerId is optional, used for winner-stays logic
  const io = getSocketIO();

  try {
    const table = await Table.findById(tableId);
    if (!table) return res.status(404).send('Table not found.');
    if (table.status !== 'in_play') return res.status(400).send('Table is not currently in play.');

    const session = await Session.findById(table.currentSessionId);
    if (session) {
      session.endTime = new Date();
      session.status = 'completed';
      await session.save();
    }

    table.lastGameEndedAt = new Date();
    table.currentSessionId = null;

    // Implement winner-stays logic
    if (session && session.type === 'per_game' && winnerId) {
        // If it was a 'per_game' session and a winner is provided, that player stays
        table.currentPlayers.player1Id = winnerId;
        table.currentPlayers.player2Id = null; // Clear second player slot
        io.to(winnerId).emit('gameEndedSuccess', { tableId: table._id, tableNumber: table.tableNumber, message: 'You won! Ready for next challenge.' });
    } else {
        // If not 'per_game' or no winner, clear both player slots
        table.currentPlayers.player1Id = null;
        table.currentPlayers.player2Id = null;
    }
    
    table.status = 'available'; // Set table status back to available

    await table.save();

    // Manually populate queue (now potentially empty or changed) for the table status update to all clients
    const populatedQueue = await populateQueueWithUserDetails(table.queue);
    io.to(table.venueId.toString()).emit('tableStatusUpdate', { ...table.toJSON(), queue: populatedQueue });

    res.status(200).send('Game completed and table status updated successfully.');

    // If it was a 'per_game' session, try inviting the next player from the queue
    if (session && session.type === 'per_game') {
        inviteNextPlayer(tableId, io, sendPushNotification);
    } else {
        console.log(`Direct play game on table ${table.tableNumber} ended. Table is now available, no queue invitation triggered.`);
    }

  } catch (error) {
    console.error('Error on game completion:', error.message);
    res.status(500).send('Failed to process game completion due to an internal server error.');
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

    table.queue = []; // Clear the queue by setting it to an empty array
    await table.save();

    // Manually populate the queue (which is now empty) for the Socket.IO update
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

/**
 * @route POST /api/tables/:tableId/confirm-win
 * @description Confirms a win for a specific session/table.
 * @access Private (requires Firebase auth token)
 * @body sessionId, winnerId (the user who claims to have won)
 */
router.post('/:tableId/confirm-win', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Unauthorized: Authentication required.' });
  }

  const { tableId } = req.params;
  const { sessionId, winnerId } = req.body;
  const currentUserId = req.user.uid;
  const io = getSocketIO();

  if (!sessionId || !winnerId) {
    return res.status(400).json({ message: 'Session ID and Winner ID are required.' });
  }

  try {
    const table = await Table.findById(tableId);
    if (!table) {
      return res.status(404).json({ message: 'Table not found.' });
    }

    const session = await Session.findById(sessionId);
    if (!session) {
      return res.status(404).json({ message: 'Session not found.' });
    }

    // Ensure the current user is one of the players in the session
    if (session.player1Id !== currentUserId && session.player2Id !== currentUserId) {
      return res.status(403).json({ message: 'Forbidden: You are not a participant in this game.' });
    }

    // Check if the session is already completed or disputed
    if (session.status === 'completed') {
      return res.status(400).json({ message: 'Game already confirmed.' });
    }
    if (session.status === 'disputed') {
      return res.status(400).json({ message: 'Game is currently under dispute.' });
    }

    // Logic for confirming the win
    session.status = 'completed';
    session.endTime = new Date();
    await session.save();

    // Award tokens to the winner (if applicable, e.g., if there's a prize pool or token gain)
    const winnerUser = await User.findById(winnerId);
    if (winnerUser) {
      // Example: Award 5 tokens for a win (adjust as per your game economy)
      const winTokens = 5; 
      winnerUser.tokenBalance += winTokens;
      await winnerUser.save();
      io.to(winnerId).emit('tokenBalanceUpdate', { newBalance: winnerUser.tokenBalance });
      console.log(`User ${winnerId} confirmed win and received ${winTokens} tokens.`);
    }

    // Notify both players that the win has been confirmed
    const player1 = await User.findById(session.player1Id);
    const player2 = await User.findById(session.player2Id);

    if (player1) {
      sendPushNotification(player1._id, 'Game Confirmed!', `The win on Table ${table.tableNumber} has been confirmed. ${winnerUser?.displayName || 'A player'} won!`);
    }
    if (player2) {
      sendPushNotification(player2._id, 'Game Confirmed!', `The win on Table ${table.tableNumber} has been confirmed. ${winnerUser?.displayName || 'A player'} won!`);
    }

    // Update table status and current players based on winner-stays logic
    table.status = 'available'; // Default to available after confirmation
    table.currentPlayers.player1Id = null;
    table.currentPlayers.player2Id = null;
    table.currentSessionId = null;
    table.lastGameEndedAt = new Date();
    await table.save();

    // Emit table status update to all clients in the venue
    const populatedQueue = await populateQueueWithUserDetails(table.queue);
    io.to(table.venueId.toString()).emit('tableStatusUpdate', { ...table.toJSON(), queue: populatedQueue });

    res.status(200).json({ message: 'Win confirmed successfully.' });

  } catch (error) {
    console.error('Error confirming win:', error);
    res.status(500).json({ message: 'Failed to confirm win due to an internal server error.' });
  }
});

/**
 * @route POST /api/tables/:tableId/dispute-win
 * @description Records a dispute for a game session.
 * @access Private (requires Firebase auth token)
 * @body sessionId, disputerId (the user who is disputing)
 */
router.post('/:tableId/dispute-win', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Unauthorized: Authentication required.' });
  }

  const { tableId } = req.params;
  const { sessionId, disputerId } = req.body; // disputerId should be req.user.uid
  const currentUserId = req.user.uid;
  const io = getSocketIO();

  if (!sessionId || !disputerId) {
    return res.status(400).json({ message: 'Session ID and Disputer ID are required.' });
  }

  try {
    const table = await Table.findById(tableId);
    if (!table) {
      return res.status(404).json({ message: 'Table not found.' });
    }

    const session = await Session.findById(sessionId);
    if (!session) {
      return res.status(404).json({ message: 'Session not found.' });
    }

    // Ensure the current user is the one disputing and is a participant
    if (disputerId !== currentUserId || (session.player1Id !== currentUserId && session.player2Id !== currentUserId)) {
      return res.status(403).json({ message: 'Forbidden: You can only dispute your own games.' });
    }

    // Check if the session is already completed or disputed
    if (session.status === 'completed') {
      return res.status(400).json({ message: 'Game already confirmed, cannot dispute.' });
    }
    if (session.status === 'disputed') {
      return res.status(400).json({ message: 'Game is already under dispute.' });
    }

    // Logic for disputing the win
    session.status = 'disputed';
    // You might want to add a `disputedBy` field to the session model
    // session.disputedBy = currentUserId;
    await session.save();

    // Notify admins or relevant parties about the dispute
    // You would typically have a mechanism to find admins (e.g., query users where isAdmin: true)
    const admins = await User.find({ isAdmin: true }).select('fcmTokens').lean();
    admins.forEach(adminUser => {
      if (adminUser.fcmTokens && adminUser.fcmTokens.length > 0) {
        sendPushNotification(adminUser._id, 'Game Dispute!', `A game on Table ${table.tableNumber} at ${session.venueId} has been disputed by ${req.user.displayName || req.user.email}. Session ID: ${sessionId}`);
      }
    });

    // Notify the other player about the dispute
    const otherPlayerId = session.player1Id === currentUserId ? session.player2Id : session.player1Id;
    if (otherPlayerId) {
        sendPushNotification(otherPlayerId, 'Game Disputed!', `The game on Table ${table.tableNumber} has been disputed by ${req.user.displayName || req.user.email}.`);
    }

    // Update table status to reflect dispute (e.g., 'awaiting_confirmation' or a new 'disputed' status)
    table.status = 'awaiting_confirmation'; // Or a new 'disputed' status if you define it
    await table.save();

    // Emit table status update to all clients in the venue
    const populatedQueue = await populateQueueWithUserDetails(table.queue);
    io.to(table.venueId.toString()).emit('tableStatusUpdate', { ...table.toJSON(), queue: populatedQueue });

    res.status(200).json({ message: 'Win dispute submitted successfully. An administrator will review.' });

  } catch (error) {
    console.error('Error disputing win:', error);
    res.status(500).json({ message: 'Failed to dispute win due to an internal server error.' });
  }
});


module.exports = router;

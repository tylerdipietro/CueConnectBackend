
// routes/tableRoutes.js
const express = require('express');
const router = express.Router();
const Table = require('../models/Table');
const Venue = require('../models/Venue');
const User = require('../models/User'); // Ensure User model is imported for checks
const Session = require('../models/Session'); // Ensure Session model is imported
const { getSocketIO } = require('../services/socketService');
const { sendPushNotification } = require('../services/notificationService'); // Assuming this exists
// Import new and updated helpers from gameService
const { inviteNextPlayer, populateQueueWithUserDetails, populateTablePlayersDetails } = require('../services/gameService'); 

/**
 * @route POST /api/tables
 * @description Registers a new individual table for a specific venue.
 * @access Private (requires Firebase auth token and admin privileges)
 * @body venueId, tableNumber, esp32DeviceId
 */
router.post('/', async (req, res) => {
  if (!req.user || req.user.isAdmin !== true) {
    return res.status(403).json({ message: 'Forbidden: Admin access required to register tables.' });
  }

  const { venueId, tableNumber, esp32DeviceId } = req.body;

  if (!venueId || !tableNumber || !esp32DeviceId) {
    return res.status(400).json({ message: 'Venue ID, Table Number, and ESP32 Device ID are required.' });
  }

  try {
    const venue = await Venue.findById(venueId);
    if (!venue) {
      return res.status(404).json({ message: 'Venue not found.' });
    }

    const existingTableWithEsp32Id = await Table.findOne({ esp32DeviceId: esp32DeviceId });
    if (existingTableWithEsp32Id) {
        return res.status(409).json({ message: 'Another table with this ESP32 Device ID already exists.' });
    }

    const existingTableInVenue = await Table.findOne({ venueId: venueId, tableNumber: tableNumber });
    if (existingTableInVenue) {
        return res.status(409).json({ message: `Table number "${tableNumber}" already exists in this venue.` });
    }

    const newTable = new Table({
      venueId,
      tableNumber,
      esp32DeviceId,
      status: 'available',
      currentPlayers: { player1Id: null, player2Id: null }, // Initialize with no players
      currentSessionId: null,
      queue: [],
      lastGameEndedAt: null,
    });
    const savedTable = await newTable.save();

    await Venue.findByIdAndUpdate(
        venueId,
        { $push: { tableIds: savedTable._id }, $inc: { numberOfTables: 1 } },
        { new: true, useFindAndModify: false }
    );

    res.status(201).json(savedTable);
  } catch (error) {
    console.error('Error registering table:', error.message);
    res.status(500).json({ message: 'Failed to register table. Please try again later.' });
  }
});

/**
 * @route GET /api/venues/:venueId/tables
 * @description Retrieves all tables for a specific venue, manually populating queue user display names AND current player display names.
 * @access Private (requires Firebase auth token)
 */
router.get('/:venueId/tables', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Unauthorized: Authentication required to view tables.' });
  }

  try {
    const tables = await Table.find({ venueId: req.params.venueId }).lean();

    const tablesWithAllPopulatedDetails = await Promise.all(tables.map(async (table) => {
      const populatedQueue = await populateQueueWithUserDetails(table.queue);
      const tableWithPopulatedPlayers = await populateTablePlayersDetails(table); // Populate current players
      return { ...tableWithPopulatedPlayers, queue: populatedQueue }; // Combine populated data
    }));

    res.json(tablesWithAllPopulatedDetails);
  }

  catch (error) {
    console.error('Error fetching tables for venue:', error.message);
    // Ensure this is always JSON, to avoid frontend JSON parse errors
    res.status(500).json({ message: 'Failed to fetch tables for the venue.' });
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
 * @route POST /api/tables/:tableId/join-table
 * @description Allows a user to directly join an available table (0 players).
 * @access Private
 * @body - None (user is identified by token)
 */
router.post('/:tableId/join-table', async (req, res) => {
  const tableId = req.params.tableId;
  const userId = req.user.uid;
  const io = getSocketIO();

  try {
    const table = await Table.findById(tableId);
    if (!table) return res.status(404).json({ message: 'Table not found.' }); // Changed to json

    // Check if table is available and has no players
    if (table.status !== 'available' || table.currentPlayers.player1Id || table.currentPlayers.player2Id) {
      return res.status(400).json({ message: 'Table is not available for direct joining. Try joining the queue.' }); // Changed to json
    }

    const user = await User.findById(userId); // Fetch user to check other tables/queues if needed
    if (!user) return res.status(404).json({ message: 'User not found.' }); // Changed to json

    if (table.queue.includes(userId)) {
      return res.status(400).json({ message: 'You are already in this table\'s queue.' }); // Changed to json
    }

    table.currentPlayers.player1Id = userId; // User becomes Player 1
    table.status = 'in_play'; // Table is now in play
    table.queue = table.queue.filter(uid => uid !== userId); // Ensure they are removed from queue if they were somehow in it

    await table.save();

    // Create a new session for the game
    const venue = await Venue.findById(table.venueId);
    if (!venue || typeof venue.perGameCost !== 'number' || venue.perGameCost <= 0) {
      console.error('Venue or perGameCost not configured for table:', tableId);
      return res.status(500).json({ message: 'Venue game cost is not configured correctly.' }); // Changed to json
    }

    const newSession = new Session({
      tableId: table._id,
      venueId: table.venueId,
      player1Id: userId,
      player2Id: null, // Initially only one player
      startTime: new Date(),
      cost: venue.perGameCost,
      status: 'active', // Directly active since they joined directly
      type: 'drop_balls_now', // Can be refined to 'direct_join'
      // stripePaymentIntentId: null, // Will be null by default, but sparse index allows this
    });
    await newSession.save();
    table.currentSessionId = newSession._id;
    await table.save();

    // Notify the user who just joined that they are now playing
    io.to(userId).emit('tableJoined', {
      tableId: table._id,
      tableNumber: table.tableNumber,
      message: `You are now playing on Table ${table.tableNumber}!`,
      playerSlot: 'player1'
    });

    // Manually populate queue (will be empty) for the general table status update
    const populatedQueue = await populateQueueWithUserDetails(table.queue);
    // Populate current players details for the table status update
    const finalTableState = await populateTablePlayersDetails({ ...table.toJSON(), queue: populatedQueue });
    io.to(table.venueId.toString()).emit('tableStatusUpdate', finalTableState);

    res.status(200).json({ message: 'Joined table successfully.' }); // Changed to json

  } catch (error) {
    console.error('Error joining table:', error.message);
    res.status(500).json({ message: 'Failed to join table.' }); // Changed to json
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
    if (!table) return res.status(404).json({ message: 'Table not found.' }); // Changed to json

    // Check if table is full (2 players) or if user is already playing/in queue
    const isPlaying = table.currentPlayers.player1Id === userId || table.currentPlayers.player2Id === userId;
    if (isPlaying) {
      return res.status(400).json({ message: 'You are already playing at this table.' }); // Changed to json
    }
    const alreadyInQueue = table.queue.includes(userId); // Since queue stores simple strings
    if (alreadyInQueue) {
      return res.status(400).json({ message: 'You are already in this table\'s queue.' }); // Changed to json
    }

    // Only allow joining queue if table is in_play or occupied, or has 1 player, or has a queue
    const numPlayers = (table.currentPlayers.player1Id ? 1 : 0) + (table.currentPlayers.player2Id ? 1 : 0);
    if (numPlayers < 2 && table.queue.length === 0 && table.status === 'available') {
      // If table is available and empty, they should use 'join-table' instead
      return res.status(400).json({ message: 'Table is available. Use "join-table" to play immediately.' }); // Changed to json
    }
    
    table.queue.push(userId); // Add userId string to the queue array
    await table.save();

    // Manually populate the queue for the Socket.IO update and the response
    const populatedQueue = await populateQueueWithUserDetails(table.queue);
    // Populate current players details for the table status update
    const finalTableState = await populateTablePlayersDetails({ ...table.toJSON(), queue: populatedQueue });

    // Emit real-time update to all clients in the venue's room
    io.to(table.venueId.toString()).emit('queueUpdate', {
      tableId: table._id,
      newQueue: finalTableState.queue, // Send the manually populated queue
      status: finalTableState.status,
      currentPlayers: finalTableState.currentPlayers // Include current players
    });
    console.log(`User ${userId} joined queue for table ${tableId}. Current queue length: ${finalTableState.queue.length}`);

    // Also send a specific notification to the joining user
    io.to(userId).emit('queueJoined', { tableId: table._id, tableNumber: table.tableNumber });

    res.status(200).json({ message: 'Joined queue successfully.' }); // Changed to json

  } catch (error) {
    console.error('Error joining queue:', error.message);
    res.status(500).json({ message: 'Failed to join queue.' }); // Changed to json
  }
});

/**
 * @route POST /api/tables/:tableId/leave-queue
 * @description Allows a user to leave the queue for a specific table.
 * @access Private
 */
router.post('/:tableId/leave-queue', async (req, res) => {
  const tableId = req.params.tableId;
  const userId = req.user.uid;
  const io = getSocketIO();

  try {
    const table = await Table.findById(tableId);
    if (!table) return res.status(404).json({ message: 'Table not found.' }); // Changed to json

    const initialQueueLength = table.queue.length;
    table.queue = table.queue.filter(id => id !== userId); // Filter by string UID

    if (table.queue.length === initialQueueLength) {
      return res.status(400).json({ message: 'You are not in this table\'s queue.' }); // Changed to json
    }

    await table.save();

    // Manually populate for the response and socket update
    const populatedQueue = await populateQueueWithUserDetails(table.queue);
    // Populate current players details for the table status update
    const finalTableState = await populateTablePlayersDetails({ ...table.toJSON(), queue: populatedQueue });

    io.to(table.venueId.toString()).emit('queueUpdate', {
      tableId: table._id,
      newQueue: finalTableState.queue, // Send the manually populated queue
      status: finalTableState.status,
      currentPlayers: finalTableState.currentPlayers // Include current players
    });
    console.log(`User ${userId} left queue for table ${tableId}. Current queue: ${finalTableState.queue.length}`);

    res.status(200).json({ message: 'Successfully left queue.' }); // Changed to json
  } catch (error) {
    console.error('Error leaving queue:', error.message);
    res.status(500).json({ message: 'Failed to leave queue.' }); // Changed to json
  }
});

/**
 * @route POST /api/tables/:tableId/claim-win
 * @description Allows an active player to claim a win against their opponent.
 * @access Private (only active players can call this)
 * @body winnerId, loserId (optional for more explicit claims)
 */
router.post('/:tableId/claim-win', async (req, res) => {
  const tableId = req.params.tableId;
  const winnerId = req.user.uid; // The user claiming the win
  const io = getSocketIO();

  try {
    const table = await Table.findById(tableId);
    if (!table) return res.status(404).json({ message: 'Table not found.' }); // Changed to json

    // Ensure the user claiming the win is an active player on this table
    const isPlayer1 = table.currentPlayers.player1Id === winnerId;
    const isPlayer2 = table.currentPlayers.player2Id === winnerId;

    if (!isPlayer1 && !isPlayer2) {
      return res.status(403).json({ message: 'You are not an active player on this table.' }); // Changed to json
    }
    if (!table.currentPlayers.player1Id || !table.currentPlayers.player2Id) {
      return res.status(400).json({ message: 'Cannot claim win: Table does not have two active players.' }); // Changed to json
    }

    const loserId = isPlayer1 ? table.currentPlayers.player2Id : table.currentPlayers.player1Id;
    const loser = await User.findById(loserId).select('fcmTokens displayName').lean();

    if (!loser) {
      console.warn(`Opponent ${loserId} not found for win claim on table ${table.tableNumber}. Proceeding without confirmation.`);
      return res.status(404).json({ message: 'Opponent not found.' }); // Changed to json
    }

    // Set table status to awaiting confirmation
    table.status = 'awaiting_confirmation';
    await table.save();

    // Send push notification to the loser to confirm/dispute
    if (loser.fcmTokens && loser.fcmTokens.length > 0) {
      await sendPushNotification(
        loser.fcmTokens,
        'Win Claimed!',
        `${req.user.displayName || req.user.email} claims victory on Table ${table.tableNumber}. Confirm or Dispute?`
      );
    }

    // Emit Socket.IO event to the loser
    io.to(loserId).emit('winClaimedNotification', {
      tableId: table._id,
      tableNumber: table.tableNumber,
      winnerId: winnerId,
      winnerDisplayName: req.user.displayName || req.user.email,
      message: `${req.user.displayName || req.user.email} claims victory. Confirm?`
    });

    // Also update the winner's UI to show "Awaiting Opponent Confirmation"
    io.to(winnerId).emit('winClaimSent', {
      tableId: table._id,
      tableNumber: table.tableNumber,
      message: `Waiting for ${loser.displayName || loserId} to confirm win.`
    });

    // Update table status for all viewers
    const populatedQueue = await populateQueueWithUserDetails(table.queue); // Queue remains unchanged, but status does
    const finalTableState = await populateTablePlayersDetails({ ...table.toJSON(), queue: populatedQueue }); // Populate players
    io.to(table.venueId.toString()).emit('tableStatusUpdate', finalTableState);

    res.status(200).json({ message: 'Win claim sent for confirmation.' }); // Changed to json

  } catch (error) {
    console.error('Error claiming win:', error.message);
    res.status(500).json({ message: 'Failed to claim win.' }); // Changed to json
  }
});

/**
 * @route POST /api/tables/:tableId/confirm-win
 * @description Allows the opponent to confirm a win.
 * @access Private (only the opponent can call this)
 * @body winnerId (the ID of the player who claimed the win)
 */
router.post('/:tableId/confirm-win', async (req, res) => {
  const tableId = req.params.tableId;
  const confirmerId = req.user.uid; // The user confirming the win (the loser)
  const { winnerId } = req.body; // The ID of the player who claimed the win
  const io = getSocketIO();

  try {
    const table = await Table.findById(tableId);
    if (!table) return res.status(404).json({ message: 'Table not found.' }); // Changed to json

    // Ensure the confirmer is an active player and is the *opponent* of the winner
    const isPlayer1 = table.currentPlayers.player1Id === winnerId && table.currentPlayers.player2Id === confirmerId;
    const isPlayer2 = table.currentPlayers.player2Id === winnerId && table.currentPlayers.player1Id === confirmerId;

    if (!isPlayer1 && !isPlayer2) {
      return res.status(403).json({ message: 'You are not the designated opponent for this win confirmation.' }); // Changed to json
    }
    if (table.status !== 'awaiting_confirmation') {
      return res.status(400).json({ message: 'Win confirmation is not currently pending for this table.' }); // Changed to json
    }

    const winner = await User.findById(winnerId); // Get winner's details for notification
    const confirmerUser = await User.findById(confirmerId); // Get confirmer's details

    // Process win:
    // 1. End current session (if any)
    if (table.currentSessionId) {
      const session = await Session.findById(table.currentSessionId);
      if (session) {
        session.endTime = new Date();
        session.status = 'completed';
        await session.save();
      }
    }

    // 2. Clear current players, potentially apply winner-stays logic
    table.lastGameEndedAt = new Date();
    table.currentSessionId = null;

    // Winner-stays logic: Winner becomes player1, other slot is null.
    table.currentPlayers.player1Id = winnerId;
    table.currentPlayers.player2Id = null;
    table.status = 'available'; // Table is now available for next opponent

    await table.save();

    // 3. Notify Winner
    if (winner && winner.fcmTokens && winner.fcmTokens.length > 0) {
      await sendPushNotification(
        winner.fcmTokens,
        'Win Confirmed!',
        `Your victory on Table ${table.tableNumber} was confirmed by ${confirmerUser.displayName || confirmerUser.email}.`
      );
    }
    io.to(winnerId).emit('winConfirmed', { tableId: table._id, tableNumber: table.tableNumber, message: 'Your win has been confirmed!' });

    // 4. Notify Confirmer (Loser)
    io.to(confirmerId).emit('gameEnded', { tableId: table._id, tableNumber: table.tableNumber, message: 'Game ended. Your opponent claimed victory.' });


    // 5. Invite the next player from the queue (if any, and a slot is now open)
    // This will handle sending notifications and updating table status for next player
    await inviteNextPlayer(tableId, io, sendPushNotification);


    // Fetch the updated table and populate queue for sending consistent state to all viewers
    const updatedTableAfterInvite = await Table.findById(tableId).lean();
    const populatedQueue = await populateQueueWithUserDetails(updatedTableAfterInvite.queue);
    // Populate current players details for the table status update
    const finalTableState = await populateTablePlayersDetails({ ...updatedTableAfterInvite, queue: populatedQueue });
    io.to(table.venueId.toString()).emit('tableStatusUpdate', finalTableState);

    res.status(200).json({ message: 'Win confirmed successfully.' }); // Changed to json

  } catch (error) {
    console.error('Error confirming win:', error.message);
    res.status(500).json({ message: 'Failed to confirm win.' }); // Changed to json
  }
});


/**
 * @route POST /api/tables/:tableId/drop-balls-now
 * @description This route allows a user to pay and immediately activate an available table.
 * It's distinct from joining the queue or accepting an invitation.
 * @access Private
 */
router.post('/:tableId/drop-balls-now', async (req, res) => {
  const tableId = req.params.tableId;
  const userId = req.user.uid; // User initiating drop balls
  const io = getSocketIO();

  try {
    const table = await Table.findById(tableId);
    if (!table) return res.status(404).json({ message: 'Table not found.' }); // Changed to json
    if (table.status === 'in_play') return res.status(400).json({ message: 'Table is currently in play. Cannot drop balls now.' }); // Changed to json
    if (table.status === 'out_of_order') return res.status(400).json({ message: 'Table is out of order and cannot be used.' }); // Changed to json

    // This endpoint now assumes the user is taking over an available table.
    // If the table is empty and user wants to play alone (or wait for 2nd player)
    if (!table.currentPlayers.player1Id && !table.currentPlayers.player2Id) {
      table.currentPlayers.player1Id = userId;
      table.status = 'in_play';
    } else if (table.currentPlayers.player1Id && !table.currentPlayers.player2Id && table.currentPlayers.player1Id !== userId) {
      // If P1 exists and this is a different user, they become P2
      table.currentPlayers.player2Id = userId;
      table.status = 'in_play';
    } else {
      return res.status(400).json({ message: 'Table is already occupied or you are already playing.' }); // Changed to json
    }

    const venue = await Venue.findById(table.venueId);
    if (!venue || typeof venue.perGameCost !== 'number' || venue.perGameCost <= 0) {
      console.error('Game cost not configured for this venue, or is invalid.');
      return res.status(500).json({ message: 'Game cost not configured for this venue, or is invalid.' }); // Changed to json
    }
    const cost = venue.perGameCost;

    const user = await User.findById(userId);
    if (!user || user.tokenBalance < cost) {
      return res.status(400).json({ message: 'Insufficient tokens to drop balls. Please purchase more tokens.' }); // Changed to json
    }

    user.tokenBalance -= cost;
    await user.save();

    // Clear the existing queue as a direct play takes precedence
    if (table.queue.length > 0) {
      table.queue.forEach(qId => { // qId is just the UID string here
        io.to(qId).emit('queueUpdate', {
          tableId: table._id,
          tableNumber: table.tableNumber,
          message: `Table ${table.tableNumber} is now occupied by a direct play. Your queue position has been removed.`,
          status: 'removed_by_direct_play',
          newQueue: []
        });
        sendPushNotification(
          qId,
          'Table Occupied!',
          `Table ${table.tableNumber} is now being used by a direct play. Your queue position has been removed.`
        );
      });
      table.queue = []; // Clear the queue
    }

    const newSession = new Session({
      tableId: table._id,
      venueId: table.venueId,
      player1Id: table.currentPlayers.player1Id, // Set to current players on table
      player2Id: table.currentPlayers.player2Id,
      startTime: new Date(),
      cost: cost,
      status: 'active',
      type: 'drop_balls_now',
      // stripePaymentIntentId: null, // Will be null by default, but sparse index allows this
    });
    await newSession.save();
    table.currentSessionId = newSession._id;
    await table.save();

    io.to(userId).emit('dropBallsNowConfirmed', {
      tableId: table._id,
      tableNumber: table.tableNumber,
      esp32DeviceId: table.esp32DeviceId,
      playerSlot: table.currentPlayers.player1Id === userId ? 'player1' : 'player2'
    });
    io.to(userId).emit('tokenBalanceUpdate', { newBalance: user.tokenBalance });
    sendPushNotification(userId, 'Game Started!', `Balls dropped on Table ${table.tableNumber}! Enjoy your game.`);

    const populatedQueue = await populateQueueWithUserDetails(table.queue);
    // Populate current players details for the table status update
    const finalTableState = await populateTablePlayersDetails({ ...table.toJSON(), queue: populatedQueue });
    io.to(table.venueId.toString()).emit('tableStatusUpdate', finalTableState);

    res.status(200).json({ message: 'Balls dropped and game started successfully!' }); // Changed to json

  } catch (error) {
    console.error('Error dropping balls now:', error.message);
    res.status(500).json({ message: error.message || 'Failed to drop balls due to an internal server error.' }); // Changed to json
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
    if (!table) return res.status(404).json({ message: 'Table not found.' }); // Changed to json
    if (table.status !== 'in_play') return res.status(400).json({ message: 'Table is not currently in play.' }); // Changed to json

    const session = await Session.findById(table.currentSessionId);
    if (session) {
      session.endTime = new Date();
      session.status = 'completed';
      await session.save();
    }

    table.lastGameEndedAt = new Date();
    table.currentSessionId = null;

    // Apply winner-stays logic if a winnerId is provided and valid
    if (winnerId && (table.currentPlayers.player1Id === winnerId || table.currentPlayers.player2Id === winnerId)) {
        table.currentPlayers.player1Id = winnerId; // Winner stays as Player 1
        table.currentPlayers.player2Id = null; // Clear second player slot
        io.to(winnerId).emit('gameEndedSuccess', { tableId: table._id, tableNumber: table.tableNumber, message: 'You won! Ready for next challenge.' });
    } else {
        // If not 'per_game' or no winner, clear both player slots
        table.currentPlayers.player1Id = null;
        table.currentPlayers.player2Id = null;
    }
    
    table.status = 'available'; // Set table status back to available (or queued if queue exists)

    await table.save();

    // After game completion, always try to invite the next player to fill any open slots
    await inviteNextPlayer(tableId, io, sendPushNotification);

    // Fetch the updated table and populate queue for sending consistent state to all viewers
    const updatedTableAfterInvite = await Table.findById(tableId).lean();
    const populatedQueue = await populateQueueWithUserDetails(updatedTableAfterInvite.queue);
    // Populate current players details for the table status update
    const finalTableState = await populateTablePlayersDetails({ ...updatedTableAfterInvite, queue: populatedQueue });
    io.to(table.venueId.toString()).emit('tableStatusUpdate', finalTableState);

    res.status(200).json({ message: 'Game completed and table status updated successfully.' }); // Changed to json

  } catch (error) {
    console.error('Error on game completion:', error.message);
    res.status(500).json({ message: 'Failed to process game completion due to an internal server error.' }); // Changed to json
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
    // Populate current players details for the table status update
    const finalTableState = await populateTablePlayersDetails({ ...table.toJSON(), queue: populatedQueue });
    io.to(table.venueId.toString()).emit('queueUpdate', {
      tableId: table._id,
      newQueue: finalTableState.queue, // Send the empty queue
      status: finalTableState.status,
      currentPlayers: finalTableState.currentPlayers // Include current players
    });
    console.log(`Admin ${req.user.uid} cleared queue for table ${tableId}.`);

    res.status(200).json({ message: 'Queue cleared successfully.', queue: populatedQueue });
  } catch (error) {
    console.error('Error clearing queue:', error.message);
    res.status(500).json({ message: 'Failed to clear queue. Please try again later.' });
  }
});

/**
 * @route POST /api/tables/:tableId/remove-player
 * @description Allows an admin to remove a specific player from a table.
 * @access Private (requires Firebase auth token and admin privileges)
 * @param tableId - ID of the table to update
 * @body playerIdToRemove - The UID of the player to remove (player1Id or player2Id)
 */
router.post('/:tableId/remove-player', async (req, res) => {
  // 1. Admin Authorization Check
  if (!req.user || req.user.isAdmin !== true) {
    return res.status(403).json({ message: 'Forbidden: Admin access required to remove players.' });
  }

  const { tableId } = req.params;
  const { playerIdToRemove } = req.body;
  const io = getSocketIO();

  if (!playerIdToRemove) {
    return res.status(400).json({ message: 'Player ID to remove is required.' });
  }

  try {
    let table = await Table.findById(tableId); // Use 'let' as we'll modify and save

    if (!table) {
      return res.status(404).json({ message: 'Table not found.' });
    }

    let playerRemoved = false;
    let removedPlayerDisplayName = 'a player';

    // Check if player1 is the one to remove
    if (table.currentPlayers.player1Id === playerIdToRemove) {
      const removedUser = await User.findById(playerIdToRemove).select('displayName').lean();
      removedPlayerDisplayName = removedUser ? removedUser.displayName : 'a player';
      table.currentPlayers.player1Id = null;
      playerRemoved = true;
    }
    // Check if player2 is the one to remove
    else if (table.currentPlayers.player2Id === playerIdToRemove) {
      const removedUser = await User.findById(playerIdToRemove).select('displayName').lean();
      removedPlayerDisplayName = removedUser ? removedUser.displayName : 'a player';
      table.currentPlayers.player2Id = null;
      playerRemoved = true;
    }

    if (!playerRemoved) {
      return res.status(400).json({ message: 'Player not found on this table or already removed.' });
    }

    // Update table status if slots become empty
    if (!table.currentPlayers.player1Id && !table.currentPlayers.player2Id) {
      table.status = 'available'; // Both slots are now empty
    } else if (table.currentPlayers.player1Id || table.currentPlayers.player2Id) {
      // If one player remains, status can remain 'in_play' or revert to 'occupied'
      // Based on current schema, 'in_play' implies at least one player.
      // If going from 2 players to 1, it's still 'in_play'. If from 1 to 0, then 'available'.
      // No change needed to status if one player remains and it was already 'in_play'
      if (table.status === 'awaiting_confirmation') {
          // If a player was removed while awaiting confirmation, revert to in_play or available
          table.status = (table.currentPlayers.player1Id || table.currentPlayers.player2Id) ? 'in_play' : 'available';
      }
    }


    // Also remove the player from the queue if they happen to be in it
    table.queue = table.queue.filter(uid => uid !== playerIdToRemove);

    await table.save(); // Save the updated table state

    // Re-fetch the table to ensure the freshest and populated data for Socket.IO emit
    const updatedTableDoc = await Table.findById(tableId).lean();
    const populatedQueue = await populateQueueWithUserDetails(updatedTableDoc.queue);
    const populatedTableWithPlayers = await populateTablePlayersDetails(updatedTableDoc);
    const finalTableState = { ...populatedTableWithPlayers, queue: populatedQueue };

    // Emit real-time update to all clients in the venue's room
    io.to(table.venueId.toString()).emit('tableStatusUpdate', finalTableState);
    console.log(`Admin ${req.user.uid} removed player ${playerIdToRemove} (${removedPlayerDisplayName}) from table ${table.tableNumber}.`);

    res.status(200).json({ message: `Player ${removedPlayerDisplayName} successfully removed from Table ${table.tableNumber}.` });

  } catch (error) {
    console.error('Error removing player from table:', error.message);
    res.status(500).json({ message: 'Failed to remove player from table. Please try again later.' });
  }
});


module.exports = router;

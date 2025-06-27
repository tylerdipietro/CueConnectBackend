// routes/tableRoutes.js
const express = require('express');
const router = express.Router();
const Table = require('../models/Table'); // Table model
const Venue = require('../models/Venue'); // Venue model (for perGameCost and updating tableIds)
const Session = require('../models/Session'); // Session model
const { getSocketIO } = require('../services/socketService'); // Socket.IO instance
const { sendPushNotification } = require('../services/notificationService'); // Push notification service
const { inviteNextPlayer } = require('../services/gameService'); // Game logic service

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
      queue: [],
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
 * @route POST /api/tables/:tableId/join-queue
 * @description Allows a user to join the waitlist/queue for a specific table.
 * @access Private
 */
router.post('/:tableId/join-queue', async (req, res) => {
  const tableId = req.params.tableId;
  const userId = req.user.uid;
  const io = getSocketIO(); // Get the Socket.IO instance

  try {
    const table = await Table.findById(tableId);
    if (!table) return res.status(404).send('Table not found.');

    const alreadyInQueue = table.queue.some(q => q.userId === userId && q.status !== 'declined');
    const isPlaying = table.currentPlayers.player1Id === userId || table.currentPlayers.player2Id === userId;

    if (alreadyInQueue || isPlaying) {
      return res.status(400).send('You are already in queue or playing at this table.');
    }

    table.queue.push({ userId, joinedAt: new Date(), status: 'waiting' });
    await table.save();

    io.to(table.venueId.toString()).emit('tableStatusUpdate', table.toJSON());
    io.to(userId).emit('queueJoined', { tableId: table._id, tableNumber: table.tableNumber });
    res.status(200).send('Joined queue successfully.');

    if (table.status === 'available' && !table.currentPlayers.player1Id && table.queue.length > 0) {
      inviteNextPlayer(tableId, io, sendPushNotification); // Pass io and sendPushNotification
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

    table.queue = table.queue.filter(q =>
        (q.userId !== table.currentPlayers.player1Id && q.userId !== table.currentPlayers.player2Id) &&
        q.status !== 'invited'
    );

    const newSession = new Session({
      tableId: table._id,
      venueId: table.venueId,
      player1Id: table.currentPlayers.player1Id,
      player2Id: table.currentPlayers.player2Id,
      startTime: new Date(),
      cost: gameCost,
      status: 'pending',
      type: 'per_game',
    });
    await newSession.save();
    table.currentSessionId = newSession._id;
    await table.save();

    io.to(userId).emit('paymentRequired', {
      sessionId: newSession._id,
      amount: newSession.cost,
      tableNumber: table.tableNumber
    });

    io.to(table.venueId.toString()).emit('tableStatusUpdate', table.toJSON());
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

    const queueEntry = table.queue.find(q => q.userId === userId && q.status === 'invited');
    if (!queueEntry) {
      return res.status(400).send('No active invitation found for you.');
    }

    queueEntry.status = 'declined';
    await table.save();

    io.to(table.venueId.toString()).emit('tableStatusUpdate', table.toJSON());
    res.status(200).send('Invitation declined.');

    inviteNextPlayer(tableId, io, sendPushNotification); // Pass io and sendPushNotification

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

    if (table.queue.length > 0) {
      table.queue.forEach(q => {
        if (q.userId !== userId && (q.status === 'waiting' || q.status === 'invited')) {
          io.to(q.userId).emit('queueUpdate', {
            tableId: table._id,
            tableNumber: table.tableNumber,
            message: `Table ${table.tableNumber} is now occupied by a direct play. Your queue position has been removed.`,
            status: 'removed_by_direct_play'
          });
          sendPushNotification(
            q.userId,
            'Table Occupied!',
            `Table ${table.tableNumber} is now being used by a direct play. Your queue position has been removed.`
          );
        }
      });
      table.queue = [];
    }

    table.status = 'in_play';
    table.currentPlayers.player1Id = userId;
    table.currentPlayers.player2Id = null;

    const newSession = new Session({
      tableId: table._id,
      venueId: table.venueId,
      player1Id: userId,
      player2Id: null,
      startTime: new Date(),
      cost: cost,
      status: 'active',
      type: 'drop_balls_now',
    });
    await newSession.save();
    table.currentSessionId = newSession._id;
    await table.save();

    io.to(userId).emit('dropBallsNowConfirmed', {
      tableId: table._id,
      tableNumber: table.tableNumber,
      esp32DeviceId: table.esp32DeviceId
    });
    io.to(userId).emit('tokenBalanceUpdate', { newBalance: user.tokenBalance });
    sendPushNotification(userId, 'Game Started!', `Balls dropped on Table ${table.tableNumber}! Enjoy your game.`);

    io.to(table.venueId.toString()).emit('tableStatusUpdate', table.toJSON());

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
  const { winnerId } = req.body;
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

    if (session && session.type === 'per_game' && winnerId) {
        table.currentPlayers.player1Id = winnerId;
        table.currentPlayers.player2Id = null;
        io.to(winnerId).emit('gameEndedSuccess', { tableId: table._id, tableNumber: table.tableNumber, message: 'You won! Ready for next challenge.' });
    } else {
        table.currentPlayers.player1Id = null;
        table.currentPlayers.player2Id = null;
    }
    
    table.status = 'available';

    await table.save();

    io.to(table.venueId.toString()).emit('tableStatusUpdate', table.toJSON());

    res.status(200).send('Game completed and table status updated successfully.');

    if (session && session.type === 'per_game') {
        inviteNextPlayer(tableId, io, sendPushNotification); // Pass io and sendPushNotification
    } else {
        console.log(`Direct play game on table ${table.tableNumber} ended. Table is now available, no queue invitation triggered.`);
    }

  } catch (error) {
    console.error('Error on game completion:', error.message);
    res.status(500).send('Failed to process game completion due to an internal server error.');
  }
});

module.exports = router;

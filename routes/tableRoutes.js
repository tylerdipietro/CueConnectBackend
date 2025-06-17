// routes/tableRoutes.js
const express = require('express');
const router = express.Router();
const Table = require('../models/Table'); // Table model
const Venue = require('../models/Venue'); // Venue model (for perGameCost)
const Session = require('../models/Session'); // Session model
const { getSocketIO } = require('../services/socketService'); // Socket.IO instance
const { sendPushNotification } = require('../services/notificationService'); // Push notification service
const { inviteNextPlayer } = require('../services/gameService'); // Game logic service

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

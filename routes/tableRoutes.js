// routes/tableRoutes.js

const express = require('express');
const router = express.Router();
const Table = require('../models/Table'); // Assuming you have a Table model
const User = require('../models/User'); // Assuming you have a User model
const Venue = require('../models/Venue'); // Assuming you have a Venue model
const authMiddleware = require('../middleware/authMiddleware');
const { getSocketIO } = require('../services/socketService');
const { populateTablePlayersDetails, populateQueueWithUserDetails } = require('../services/gameService');


// Apply authMiddleware to all routes in this router
router.use(authMiddleware);

// Helper function to get a fully populated table object with perGameCost
// This avoids duplicating the logic in every route handler
async function getPopulatedTableWithPerGameCost(tableId) {
  const table = await Table.findById(tableId).populate('venueId');
  if (!table) {
    return null;
  }
  const populatedQueue = await populateQueueWithUserDetails(table.queue);
  const tableWithQueue = { ...table.toObject(), queue: populatedQueue }; // Convert to plain object
  const fullyPopulatedTable = await populateTablePlayersDetails(tableWithQueue);

  // Add perGameCost from the populated venue
  const venuePerGameCost = table.venueId ? (typeof table.venueId.perGameCost === 'number' ? table.venueId.perGameCost : 10) : 10;
  return { ...fullyPopulatedTable, perGameCost: venuePerGameCost };
}


/**
 * @route GET /api/tables/:tableId
 * @description Get a specific table by ID.
 * @access Private
 */
router.get('/:tableId', async (req, res) => {
  try {
    const table = await getPopulatedTableWithPerGameCost(req.params.tableId); // Use helper
    if (!table) {
      return res.status(404).json({ message: 'Table not found.' });
    }
    res.json(table);
  } catch (error) {
    console.error('Error fetching table by ID:', error);
    res.status(500).json({ message: 'Server error fetching table.' });
  }
});

/**
 * @route PUT /api/tables/:id
 * @description Update a table by ID (Admin only)
 * @access Admin
 */
router.put('/:id', async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ message: 'Access denied. Only administrators can update tables.' });
  }

  const { id } = req.params;
  const { tableNumber, esp32DeviceId } = req.body;
  const io = getSocketIO(); // Get io instance for emitting

  try {
    const updateFields = {};
    if (tableNumber !== undefined) updateFields.tableNumber = tableNumber;
    if (esp32DeviceId !== undefined) updateFields.esp32DeviceId = esp32DeviceId;

    const updatedTableDoc = await Table.findByIdAndUpdate(id, updateFields, { new: true, runValidators: true });

    if (!updatedTableDoc) {
      return res.status(404).json({ message: 'Table not found.' });
    }

    // Emit update after modifying the table
    const updatedTableForSocket = await getPopulatedTableWithPerGameCost(updatedTableDoc._id); // Use helper
    if (updatedTableForSocket) {
      io.to(updatedTableForSocket.venueId.toString()).emit('tableStatusUpdate', updatedTableForSocket);
    }

    res.status(200).json(updatedTableDoc); // Return the raw updated document to the caller
  } catch (error) {
    console.error('Error updating table:', error);
    res.status(500).json({ message: 'Server error updating table.', error: error.message });
  }
});

/**
 * @route POST /api/tables/:tableId/join-table
 * @description User joins an available table.
 * @access Private
 */
router.post('/:tableId/join-table', async (req, res) => {
  const { tableId } = req.params;
  const userId = req.user.uid;
  const userDisplayName = req.user.displayName || req.user.email;
  const io = getSocketIO();

  try {
    const table = await Table.findById(tableId);
    if (!table) {
      return res.status(404).json({ message: 'Table not found.' });
    }

    if (table.currentPlayers.player1Id === userId || table.currentPlayers.player2Id === userId || table.queue.includes(userId)) {
      return res.status(400).json({ message: 'You are already involved with this table.' });
    }

    let message = '';
    let playerSlot = '';

    if (table.status === 'available') {
      if (!table.currentPlayers.player1Id) {
        table.currentPlayers.player1Id = userId;
        message = `You have joined Table ${table.tableNumber} as Player 1.`;
        playerSlot = 'player1';
      } else if (!table.currentPlayers.player2Id) {
        table.currentPlayers.player2Id = userId;
        table.status = 'in_play';
        message = `You have joined Table ${table.tableNumber} as Player 2. Game started!`;
        playerSlot = 'player2';
      } else {
        return res.status(400).json({ message: 'Table is currently occupied by two players. Please join the queue.' });
      }
    } else if (table.status === 'in_play' && !table.currentPlayers.player2Id) {
      table.currentPlayers.player2Id = userId;
      message = `You have joined Table ${table.tableNumber} as Player 2. Game started!`;
      playerSlot = 'player2';
    } else {
      return res.status(400).json({ message: 'Table is not available for direct joining. Please join the queue.' });
    }

    await table.save();

    // CRITICAL: Use helper to get populated table with perGameCost for socket emission
    const updatedTableForSocket = await getPopulatedTableWithPerGameCost(table._id);
    if (updatedTableForSocket) {
      io.to(updatedTableForSocket.venueId.toString()).emit('tableStatusUpdate', updatedTableForSocket);
    }
    io.to(userId).emit('tableJoined', { tableId: table._id, tableNumber: table.tableNumber, message, playerSlot });

    res.status(200).json({ message, table: updatedTableForSocket, playerSlot });
  } catch (error) {
    console.error('Error joining table:', error);
    res.status(500).json({ message: 'Server error joining table.', error: error.message });
  }
});

/**
 * @route POST /api/tables/:tableId/join-queue
 * @description User joins the queue for a table.
 * @access Private
 */
router.post('/:tableId/join-queue', async (req, res) => {
  const { tableId } = req.params;
  const userId = req.user.uid;
  const io = getSocketIO();

  try {
    const table = await Table.findById(tableId);
    if (!table) {
      return res.status(404).json({ message: 'Table not found.' });
    }

    if (table.queue.includes(userId) || table.currentPlayers.player1Id === userId || table.currentPlayers.player2Id === userId) {
      return res.status(400).json({ message: 'You are already in the queue or playing at this table.' });
    }

    table.queue.push(userId);
    table.status = 'queued'; // Table status might change to queued if it wasn't already
    await table.save();

    // CRITICAL: Use helper to get populated table with perGameCost for socket emission
    const updatedTableForSocket = await getPopulatedTableWithPerGameCost(table._id);
    if (updatedTableForSocket) {
      io.to(updatedTableForSocket.venueId.toString()).emit('queueUpdate', updatedTableForSocket);
    }

    res.status(200).json({ message: 'Successfully joined the queue.', table: updatedTableForSocket });
  } catch (error) {
    console.error('Error joining queue:', error);
    res.status(500).json({ message: 'Server error joining queue.', error: error.message });
  }
});

/**
 * @route POST /api/tables/:tableId/leave-queue
 * @description User leaves the queue for a table.
 * @access Private
 */
router.post('/:tableId/leave-queue', async (req, res) => {
  const { tableId } = req.params;
  const userId = req.user.uid;
  const io = getSocketIO();

  try {
    const table = await Table.findById(tableId);
    if (!table) {
      return res.status(404).json({ message: 'Table not found.' });
    }

    const initialQueueLength = table.queue.length;
    table.queue = table.queue.filter(id => id.toString() !== userId.toString());

    if (table.queue.length === initialQueueLength) {
      return res.status(400).json({ message: 'You are not in the queue for this table.' });
    }

    if (table.queue.length === 0 && !table.currentPlayers.player1Id && !table.currentPlayers.player2Id) {
      table.status = 'available';
    }
    await table.save();

    // CRITICAL: Use helper to get populated table with perGameCost for socket emission
    const updatedTableForSocket = await getPopulatedTableWithPerGameCost(table._id);
    if (updatedTableForSocket) {
      io.to(updatedTableForSocket.venueId.toString()).emit('queueUpdate', updatedTableForSocket);
    }

    res.status(200).json({ message: 'Successfully left the queue.', table: updatedTableForSocket });
  } catch (error) {
    console.error('Error leaving queue:', error);
    res.status(500).json({ message: 'Server error leaving queue.', error: error.message });
  }
});

/**
 * @route POST /api/tables/:tableId/clear-queue
 * @description Admin clears the queue for a table.
 * @access Admin
 */
router.post('/:tableId/clear-queue', async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ message: 'Access denied. Only administrators can clear queues.' });
  }

  const { tableId } = req.params;
  const io = getSocketIO();

  try {
    const table = await Table.findById(tableId);
    if (!table) {
      return res.status(404).json({ message: 'Table not found.' });
    }

    table.queue = [];
    if (!table.currentPlayers.player1Id && !table.currentPlayers.player2Id) {
      table.status = 'available';
    }
    await table.save();

    // CRITICAL: Use helper to get populated table with perGameCost for socket emission
    const updatedTableForSocket = await getPopulatedTableWithPerGameCost(table._id);
    if (updatedTableForSocket) {
      io.to(updatedTableForSocket.venueId.toString()).emit('queueUpdate', updatedTableForSocket);
    }

    res.status(200).json({ message: 'Queue cleared successfully.', table: updatedTableForSocket });
  } catch (error) {
    console.error('Error clearing queue:', error);
    res.status(500).json({ message: 'Server error clearing queue.', error: error.message });
  }
});

/**
 * @route POST /api/tables/:tableId/claim-win
 * @description Player claims a win, notifies opponent.
 * @access Private
 */
router.post('/:tableId/claim-win', async (req, res) => {
  const { tableId } = req.params;
  const winnerId = req.user.uid;
  const winnerDisplayName = req.user.displayName || req.user.email;
  const io = getSocketIO();

  try {
    const table = await Table.findById(tableId);
    if (!table) {
      return res.status(404).json({ message: 'Table not found.' });
    }

    if (table.status !== 'in_play' && table.status !== 'awaiting_confirmation') {
      return res.status(400).json({ message: 'Game is not in play or awaiting confirmation.' });
    }

    const opponentId = (table.currentPlayers.player1Id?.toString() === winnerId.toString())
      ? table.currentPlayers.player2Id
      : table.currentPlayers.player1Id;

    if (!opponentId) {
      return res.status(400).json({ message: 'No opponent found to confirm the win.' });
    }

    table.status = 'awaiting_confirmation';
    await table.save();

    // Notify the opponent via FCM (if they have a token)
    const opponentUser = await User.findOne({ firebaseUid: opponentId });
    if (opponentUser && opponentUser.fcmToken) {
      const message = {
        notification: {
          title: 'Win Claimed!',
          body: `${winnerDisplayName} claims victory on Table ${table.tableNumber} at ${table.venueName}. Confirm or dispute?`,
        },
        data: {
          type: 'win_confirmation',
          tableId: tableId.toString(),
          tableNumber: table.tableNumber.toString(),
          winnerId: winnerId.toString(),
          winnerDisplayName: winnerDisplayName,
          sessionId: table.currentSessionId ? table.currentSessionId.toString() : '',
        },
        token: opponentUser.fcmToken,
      };
      // Assuming you have an admin.messaging() instance available via req.app.get('admin')
      req.app.get('admin').messaging().send(message)
        .then(() => console.log(`FCM: Win claim notification sent to ${opponentUser.email}`))
        .catch(error => console.error(`FCM: Error sending win claim notification to ${opponentUser.email}:`, error));
    } else {
      console.log(`FCM: Opponent ${opponentId} has no FCM token or user not found.`);
    }

    // CRITICAL: Use helper to get populated table with perGameCost for socket emission
    const updatedTableForSocket = await getPopulatedTableWithPerGameCost(table._id);
    if (updatedTableForSocket) {
      io.to(updatedTableForSocket.venueId.toString()).emit('tableStatusUpdate', updatedTableForSocket);
    }

    res.status(200).json({ message: 'Win claim sent for confirmation.' });
  } catch (error) {
    console.error('Error claiming win:', error);
    res.status(500).json({ message: 'Server error claiming win.', error: error.message });
  }
});

/**
 * @route POST /api/tables/:tableId/confirm-win
 * @description Opponent confirms a win, ends game, awards tokens, invites next player.
 * @access Private
 */
router.post('/:tableId/confirm-win', async (req, res) => {
  const { tableId } = req.params;
  const { winnerId, sessionId } = req.body;
  const confirmerId = req.user.uid;
  const io = getSocketIO();

  try {
    const table = await Table.findById(tableId).populate('venueId'); // Keep populate here for perGameCost for token award
    if (!table) {
      return res.status(404).json({ message: 'Table not found.' });
    }

    if (table.status !== 'awaiting_confirmation') {
      return res.status(400).json({ message: 'Table is not awaiting win confirmation.' });
    }

    const isConfirmerOpponent = (table.currentPlayers.player1Id?.toString() === confirmerId.toString() && table.currentPlayers.player2Id?.toString() === winnerId.toString()) ||
                                (table.currentPlayers.player2Id?.toString() === confirmerId.toString() && table.currentPlayers.player1Id?.toString() === winnerId.toString());

    if (!isConfirmerOpponent) {
      return res.status(403).json({ message: 'Access denied. Only the opponent can confirm the win.' });
    }

    const winnerUser = await User.findById(winnerId); // Use findById
    const venuePerGameCost = table.venueId ? (typeof table.venueId.perGameCost === 'number' ? table.venueId.perGameCost : 10) : 10;
    if (winnerUser) {
      await User.updateOne(
        { _id: winnerId }, // Use _id for update query
        { $inc: { tokenBalance: venuePerGameCost } }
      );
      console.log(`Tokens awarded: ${venuePerGameCost} to ${winnerUser.email}`);
      io.to(winnerId).emit('tokenBalanceUpdate', { newBalance: winnerUser.tokenBalance + venuePerGameCost });
    }

    table.currentPlayers = { player1Id: null, player2Id: null };
    table.currentSessionId = undefined;

    if (table.queue.length > 0) {
      const nextPlayerId = table.queue.shift();
      table.currentPlayers.player1Id = nextPlayerId;
      table.status = 'available';

      const nextPlayerUser = await User.findById(nextPlayerId); // Use findById
      if (nextPlayerUser && nextPlayerUser.fcmToken) {
        const message = {
          notification: {
            title: 'Your Turn!',
            body: `It's your turn on Table ${table.tableNumber} at ${table.venueId.name}.`,
          },
          data: {
            type: 'your_turn',
            tableId: tableId.toString(),
            tableNumber: table.tableNumber.toString(),
          },
          token: nextPlayerUser.fcmToken,
        };
        req.app.get('admin').messaging().send(message)
          .then(() => console.log(`FCM: Next player notification sent to ${nextPlayerUser.email}`))
          .catch(error => console.error(`FCM: Error sending next player notification to ${nextPlayerUser.email}:`, error));
      }
    } else {
      table.status = 'available';
    }

    await table.save();

    // CRITICAL: Use helper to get populated table with perGameCost for socket emission
    const updatedTableForSocket = await getPopulatedTableWithPerGameCost(table._id);
    if (updatedTableForSocket) {
      io.to(updatedTableForSocket.venueId.toString()).emit('tableStatusUpdate', updatedTableForSocket);
    }

    res.status(200).json({ message: 'Win confirmed and game ended.' });
  } catch (error) {
    console.error('Error confirming win:', error);
    res.status(500).json({ message: 'Server error confirming win.', error: error.message });
  }
});

/**
 * @route POST /api/tables/:tableId/dispute-win
 * @description Player disputes a win.
 * @access Private
 */
router.post('/:tableId/dispute-win', async (req, res) => {
  const { tableId } = req.params;
  const { sessionId, disputerId } = req.body;
  const userId = req.user.uid;
  const io = getSocketIO();

  if (disputerId !== userId) {
    return res.status(403).json({ message: 'Access denied. You can only dispute your own games.' });
  }

  try {
    const table = await Table.findById(tableId);
    if (!table) {
      return res.status(404).json({ message: 'Table not found.' });
    }

    if (table.status !== 'awaiting_confirmation') {
      return res.status(400).json({ message: 'Table is not awaiting win confirmation.' });
    }

    table.status = 'in_play';
    await table.save();

    const player1 = await User.findById(table.currentPlayers.player1Id); // Use findById
    const player2 = await User.findById(table.currentPlayers.player2Id); // Use findById

    const notificationTitle = 'Win Disputed!';
    const notificationBody = `${req.user.displayName || req.user.email} has disputed the win claim on Table ${table.tableNumber}. The game state has been reverted.`;

    if (player1 && player1.fcmToken) {
      req.app.get('admin').messaging().send({
        notification: { title: notificationTitle, body: notificationBody },
        data: { type: 'win_disputed', tableId: tableId.toString(), tableNumber: table.tableNumber.toString() },
        token: player1.fcmToken,
      }).catch(error => console.error(`FCM: Error sending dispute notification to player1:`, error));
    }
    if (player2 && player2.fcmToken) {
      req.app.get('admin').messaging().send({
        notification: { title: notificationTitle, body: notificationBody },
        data: { type: 'win_disputed', tableId: tableId.toString(), tableNumber: table.tableNumber.toString() },
        token: player2.fcmToken,
      }).catch(error => console.error(`FCM: Error sending dispute notification to player2:`, error));
    }

    // CRITICAL: Use helper to get populated table with perGameCost for socket emission
    const updatedTableForSocket = await getPopulatedTableWithPerGameCost(table._id);
    if (updatedTableForSocket) {
      io.to(updatedTableForSocket.venueId.toString()).emit('tableStatusUpdate', updatedTableForSocket);
    }

    res.status(200).json({ message: 'Win dispute recorded. Game state reverted.' });
  } catch (error) {
    console.error('Error disputing win:', error);
    res.status(500).json({ message: 'Server error disputing win.', error: error.message });
  }
});

/**
 * @route POST /api/tables/:tableId/remove-player
 * @description Admin removes a player from a table.
 * @access Admin
 */
router.post('/:tableId/remove-player', async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ message: 'Access denied. Only administrators can remove players.' });
  }

  const { tableId } = req.params;
  const { playerIdToRemove } = req.body;
  const io = getSocketIO();

  try {
    const table = await Table.findById(tableId);
    if (!table) {
      return res.status(404).json({ message: 'Table not found.' });
    }

    let playerRemoved = false;
    if (table.currentPlayers.player1Id?.toString() === playerIdToRemove.toString()) {
      table.currentPlayers.player1Id = null;
      playerRemoved = true;
    } else if (table.currentPlayers.player2Id?.toString() === playerIdToRemove.toString()) {
      table.currentPlayers.player2Id = null;
      playerRemoved = true;
    } else {
      const initialQueueLength = table.queue.length;
      table.queue = table.queue.filter(id => id.toString() !== playerIdToRemove.toString());
      if (table.queue.length < initialQueueLength) {
        playerRemoved = true;
      }
    }

    if (!playerRemoved) {
      return res.status(400).json({ message: 'Player not found at this table or in its queue.' });
    }

    if (!table.currentPlayers.player1Id && !table.currentPlayers.player2Id && table.queue.length === 0) {
      table.status = 'available';
    } else if (!table.currentPlayers.player1Id || !table.currentPlayers.player2Id) {
        if (table.queue.length > 0 && !table.currentPlayers.player1Id) {
            table.currentPlayers.player1Id = table.queue.shift();
            table.status = 'available';
        } else if (table.queue.length > 0 && !table.currentPlayers.player2Id) {
            table.currentPlayers.player2Id = table.queue.shift();
            table.status = 'in_play';
        } else if (table.currentPlayers.player1Id && !table.currentPlayers.player2Id) {
            table.status = 'available';
        } else if (!table.currentPlayers.player1Id && table.currentPlayers.player2Id) {
            table.currentPlayers.player1Id = table.currentPlayers.player2Id;
            table.currentPlayers.player2Id = null;
            table.status = 'available';
        }
    }

    await table.save();

    // CRITICAL: Use helper to get populated table with perGameCost for socket emission
    const updatedTableForSocket = await getPopulatedTableWithPerGameCost(table._id);
    if (updatedTableForSocket) {
      io.to(updatedTableForSocket.venueId.toString()).emit('tableStatusUpdate', updatedTableForSocket);
    }

    res.status(200).json({ message: 'Player removed successfully.' });
  } catch (error) {
    console.error('Error removing player:', error);
    res.status(500).json({ message: 'Server error removing player.', error: error.message });
  }
});

// NEW ROUTE: Pay for table with tokens (MODIFIED TO ONLY DEDUCT TOKENS)
/**
 * @route POST /api/tables/:tableId/pay-with-tokens
 * @description Deduct tokens from user's balance for a table. Does NOT affect table status or player assignment.
 * @access Private
 * @body {number} cost - The number of tokens to deduct (should match venue's perGameCost).
 */
router.post('/:tableId/pay-with-tokens', async (req, res) => {
  const { tableId } = req.params;
  const { cost } = req.body;
  const userId = req.user.uid; // User ID from auth token
  const io = getSocketIO();

  console.log(`[PAY_DEBUG] Attempting to process payment for userId: ${userId} on tableId: ${tableId}`);
  console.log(`[PAY_DEBUG] Cost received from frontend: ${cost}`);

  try {
    // 1. Find the user
    console.log(`[PAY_DEBUG] Querying User collection for _id (Firebase UID): ${userId}`);
    const user = await User.findById(userId); // CORRECTED: Query by _id

    if (!user) {
      console.error(`[PAY_ERROR] User not found in DB for _id (Firebase UID): ${userId}`);
      return res.status(404).json({ message: 'User not found.' });
    }
    console.log(`[PAY_DEBUG] User found: ${user.email}, current balance: ${user.tokenBalance}`);

    // 2. Find the table and populate venue to get perGameCost
    const table = await Table.findById(tableId).populate('venueId');

    if (!table) {
      console.error(`[PAY_ERROR] Table not found for tableId: ${tableId}`);
      return res.status(404).json({ message: 'Table not found.' });
    }
    if (!table.venueId) {
      console.error(`[PAY_ERROR] Venue not populated for tableId: ${tableId}. Check Table model populate path.`);
      return res.status(500).json({ message: 'Table\'s venue information is missing.' });
    }

    // 3. Verify cost matches venue's perGameCost
    const expectedCost = table.venueId.perGameCost;
    console.log(`[PAY_DEBUG] Venue perGameCost: ${expectedCost}`);
    // Also add a check for `cost` being a number, as it could be undefined if frontend didn't send it
    if (typeof cost !== 'number' || isNaN(cost) || cost !== expectedCost) {
      console.warn(`[PAY_WARN] Mismatch or invalid cost. Expected ${expectedCost}, received ${cost}.`);
      return res.status(400).json({ message: `Invalid or mismatching table cost. Expected ${expectedCost}.` });
    }

    // 4. Check token balance
    if (user.tokenBalance < cost) {
      console.warn(`[PAY_WARN] Insufficient token balance for user ${userId}. Balance: ${user.tokenBalance}, Cost: ${cost}`);
      return res.status(400).json({ message: 'Insufficient token balance.' });
    }

    // 5. Deduct tokens
    user.tokenBalance -= cost;
    await user.save();
    console.log(`[PAY_DEBUG] Tokens deducted. New balance for ${userId}: ${user.tokenBalance}`);

    // 6. Emit token balance update to user (ONLY this update)
    io.to(userId).emit('tokenBalanceUpdate', { newBalance: user.tokenBalance });
    console.log(`[PAY_DEBUG] Emitted tokenBalanceUpdate to user ${userId}`);

    // IMPORTANT: No changes to table status or currentPlayers here.
    // No tableStatusUpdate emitted for the venue room from this specific route.

    res.status(200).json({ message: `Successfully paid ${cost} tokens for Table ${table.tableNumber}. Your new balance is ${user.tokenBalance} tokens.`, newBalance: user.tokenBalance });

  } catch (error) {
    console.error(`[PAY_ERROR] Server error processing token payment for userId ${userId}:`, error);
    res.status(500).json({ message: 'Server error processing token payment.', error: error.message });
  }
});

module.exports = router;

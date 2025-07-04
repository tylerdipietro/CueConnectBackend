// routes/tableRoutes.js

const express = require('express');
const router = express.Router();
const Table = require('../models/Table');
const User = require('../models/User');
const Venue = require('../models/Venue');
const authMiddleware = require('../middleware/authMiddleware');
const { getSocketIO } = require('../services/socketService');
const { getPopulatedTableWithPerGameCost } = require('../services/tableHelpers');
const { populateTablePlayersDetails, populateQueueWithUserDetails } = require('../services/gameService');


// Apply authMiddleware to all routes in this router
router.use(authMiddleware);


/**
 * @route GET /api/tables/:tableId
 * @description Get a specific table by ID.
 * @access Private
 */
router.get('/:tableId', async (req, res) => {
  try {
    const table = await getPopulatedTableWithPerGameCost(req.params.tableId);
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
  const io = getSocketIO();

  try {
    const updateFields = {};
    if (tableNumber !== undefined) updateFields.tableNumber = tableNumber;
    if (esp32DeviceId !== undefined) updateFields.esp32DeviceId = esp32DeviceId;

    const updatedTableDoc = await Table.findByIdAndUpdate(id, updateFields, { new: true, runValidators: true });

    if (!updatedTableDoc) {
      return res.status(404).json({ message: 'Table not found.' });
    }

    const updatedTableForSocket = await getPopulatedTableWithPerGameCost(updatedTableDoc._id);
    if (updatedTableForSocket && updatedTableForSocket.venueId && updatedTableForSocket.venueId._id) {
      const venueRoomId = updatedTableForSocket.venueId._id.toString();
      console.log(`[TABLE_ROUTE_PUT] Attempting to emit tableStatusUpdate for table ${id} to room: ${venueRoomId}. perGameCost: ${updatedTableForSocket.perGameCost}`);
      io.to(venueRoomId).emit('tableStatusUpdate', updatedTableForSocket);
      console.log(`[TABLE_ROUTE_PUT] Emitted tableStatusUpdate for table ${id} to room: ${venueRoomId}.`);
    } else {
      console.warn(`[TABLE_ROUTE_PUT] Not emitting tableStatusUpdate for ${id} because updatedTableForSocket or its venueId/_id is null/undefined.`);
    }

    res.status(200).json(updatedTableDoc);
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

    const updatedTableForSocket = await getPopulatedTableWithPerGameCost(table._id);
    if (updatedTableForSocket && updatedTableForSocket.venueId && updatedTableForSocket.venueId._id) {
      const venueRoomId = updatedTableForSocket.venueId._id.toString();
      console.log(`[TABLE_ROUTE_JOIN] Attempting to emit tableStatusUpdate for table ${tableId} to room: ${venueRoomId}. perGameCost: ${updatedTableForSocket.perGameCost}`);
      io.to(venueRoomId).emit('tableStatusUpdate', updatedTableForSocket);
      console.log(`[TABLE_ROUTE_JOIN] Emitted tableStatusUpdate for table ${tableId} to room: ${venueRoomId}.`);
    } else {
      console.warn(`[TABLE_ROUTE_JOIN] Not emitting tableStatusUpdate for ${tableId} because updatedTableForSocket or its venueId/_id is null/undefined.`);
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
    table.status = 'queued';
    await table.save();

    const updatedTableForSocket = await getPopulatedTableWithPerGameCost(table._id);
    if (updatedTableForSocket && updatedTableForSocket.venueId && updatedTableForSocket.venueId._id) {
      const venueRoomId = updatedTableForSocket.venueId._id.toString();
      console.log(`[TABLE_ROUTE_JOIN_QUEUE] Attempting to emit queueUpdate for table ${tableId} to room: ${venueRoomId}. perGameCost: ${updatedTableForSocket.perGameCost}`);
      io.to(venueRoomId).emit('queueUpdate', updatedTableForSocket);
      console.log(`[TABLE_ROUTE_JOIN_QUEUE] Emitted queueUpdate for table ${tableId} to room: ${venueRoomId}.`);
    } else {
      console.warn(`[TABLE_ROUTE_JOIN_QUEUE] Not emitting queueUpdate for ${tableId} because updatedTableForSocket or its venueId/_id is null/undefined.`);
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

    const updatedTableForSocket = await getPopulatedTableWithPerGameCost(table._id);
    if (updatedTableForSocket && updatedTableForSocket.venueId && updatedTableForSocket.venueId._id) {
      const venueRoomId = updatedTableForSocket.venueId._id.toString();
      console.log(`[TABLE_ROUTE_LEAVE_QUEUE] Attempting to emit queueUpdate for table ${tableId} to room: ${venueRoomId}. perGameCost: ${updatedTableForSocket.perGameCost}`);
      io.to(venueRoomId).emit('queueUpdate', updatedTableForSocket);
      console.log(`[TABLE_ROUTE_LEAVE_QUEUE] Emitted queueUpdate for table ${tableId} to room: ${venueRoomId}.`);
    } else {
      console.warn(`[TABLE_ROUTE_LEAVE_QUEUE] Not emitting queueUpdate for ${tableId} because updatedTableForSocket or its venueId/_id is null/undefined.`);
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

    const updatedTableForSocket = await getPopulatedTableWithPerGameCost(table._id);
    if (updatedTableForSocket && updatedTableForSocket.venueId && updatedTableForSocket.venueId._id) {
      const venueRoomId = updatedTableForSocket.venueId._id.toString();
      console.log(`[TABLE_ROUTE_CLEAR_QUEUE] Attempting to emit queueUpdate for table ${tableId} to room: ${venueRoomId}. perGameCost: ${updatedTableForSocket.perGameCost}`);
      io.to(venueRoomId).emit('queueUpdate', updatedTableForSocket);
      console.log(`[TABLE_ROUTE_CLEAR_QUEUE] Emitted queueUpdate for table ${tableId} to room: ${venueRoomId}.`);
    } else {
      console.warn(`[TABLE_ROUTE_CLEAR_QUEUE] Not emitting queueUpdate for ${tableId} because updatedTableForSocket or its venueId/_id is null/undefined.`);
    }

    res.status(200).json({ message: 'Queue cleared successfully.', table: updatedTableForSocket });
  }
  catch (error) {
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
    const table = await Table.findById(tableId).populate('venueId'); // Ensure venueId is populated for FCM
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

    // FCM Notification to Opponent
    const opponentUser = await User.findById(opponentId);
    // Defensive check for admin instance
    const admin = req.app.get('admin'); // Get the admin instance
    if (opponentUser && opponentUser.fcmTokens && opponentUser.fcmTokens.length > 0) {
      if (admin) { // Check if admin instance is available
        const venueNameForNotification = table.venueId ? table.venueId.name : 'Unknown Venue';
        const message = {
          notification: {
            title: 'Win Claimed!',
            body: `${winnerDisplayName} claims victory on Table ${table.tableNumber} at ${venueNameForNotification}. Confirm or dispute?`,
          },
          data: {
            type: 'win_confirmation',
            tableId: tableId.toString(),
            tableNumber: table.tableNumber.toString(),
            winnerId: winnerId.toString(),
            winnerDisplayName: winnerDisplayName,
            sessionId: table.currentSessionId ? table.currentSessionId.toString() : '',
          },
          tokens: opponentUser.fcmTokens,
        };
        admin.messaging().sendEachForMulticast(message)
          .then((response) => {
            console.log(`FCM: Win claim notification sent to opponent ${opponentUser.email}. Success: ${response.successCount}, Failure: ${response.failureCount}`);
            if (response.failureCount > 0) {
              response.responses.forEach((resp, idx) => {
                if (!resp.success) {
                  console.error(`FCM: Failed to send to token ${opponentUser.fcmTokens[idx]}: ${resp.error}`);
                }
              });
            }
          })
          .catch(error => console.error(`FCM: Error sending win claim notification to ${opponentUser.email}:`, error));
      } else {
        console.error('[TABLE_ROUTE_CLAIM_WIN] Firebase Admin SDK instance not found on app object. Cannot send FCM notification.');
      }
    } else {
      console.log(`FCM: Opponent ${opponentId} has no FCM tokens registered or user not found. OpponentUser exists: ${!!opponentUser}, FCM Tokens exist and are array: ${Array.isArray(opponentUser?.fcmTokens) && opponentUser.fcmTokens.length > 0}`);
    }

    // Socket.IO event to the OPPONENT (player who needs to confirm)
    io.to(opponentId).emit('winClaimedNotification', {
        tableId: table._id.toString(),
        tableNumber: table.tableNumber,
        winnerId: winnerId,
        winnerDisplayName: winnerDisplayName,
        message: `${winnerDisplayName} claims victory on Table ${table.tableNumber}. Do you confirm this win?`
    });
    console.log(`[TABLE_ROUTE_CLAIM_WIN] Emitted winClaimedNotification to opponent ${opponentId}.`);


    const updatedTableForSocket = await getPopulatedTableWithPerGameCost(table._id);
    if (updatedTableForSocket && updatedTableForSocket.venueId && updatedTableForSocket.venueId._id) {
      const venueRoomId = updatedTableForSocket.venueId._id.toString();
      console.log(`[TABLE_ROUTE_CLAIM_WIN] Attempting to emit tableStatusUpdate for table ${tableId} to room: ${venueRoomId}. perGameCost: ${updatedTableForSocket.perGameCost}`);
      io.to(venueRoomId).emit('tableStatusUpdate', updatedTableForSocket);
      console.log(`[TABLE_ROUTE_CLAIM_WIN] Emitted tableStatusUpdate for table ${tableId} to room: ${venueRoomId}.`);
    } else {
      console.warn(`[TABLE_ROUTE_CLAIM_WIN] Not emitting tableStatusUpdate for ${tableId} because updatedTableForSocket or its venueId/_id is null/undefined.`);
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
    const table = await Table.findById(tableId).populate('venueId');
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

    const winnerUser = await User.findById(winnerId);
    const venuePerGameCost = table.venueId ? (typeof table.venueId.perGameCost === 'number' ? table.venueId.perGameCost : 10) : 10;
    if (winnerUser) {
      await User.updateOne(
        { _id: winnerId },
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

      const nextPlayerUser = await User.findById(nextPlayerId);
      // Defensive check for admin instance
      const admin = req.app.get('admin'); // Get the admin instance
      if (nextPlayerUser && nextPlayerUser.fcmTokens && nextPlayerUser.fcmTokens.length > 0) {
        if (admin) { // Check if admin instance is available
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
            tokens: nextPlayerUser.fcmTokens,
          };
          admin.messaging().sendEachForMulticast(message)
            .then((response) => {
              console.log(`FCM: Next player notification sent to ${nextPlayerUser.email}. Success: ${response.successCount}, Failure: ${response.failureCount}`);
              if (response.failureCount > 0) {
                response.responses.forEach((resp, idx) => {
                  if (!resp.success) {
                    console.error(`FCM: Failed to send to token ${nextPlayerUser.fcmTokens[idx]}: ${resp.error}`);
                  }
                });
              }
            })
            .catch(error => console.error(`FCM: Error sending next player notification to ${nextPlayerUser.email}:`, error));
        } else {
          console.error('[TABLE_ROUTE_CONFIRM_WIN] Firebase Admin SDK instance not found on app object. Cannot send FCM notification.');
        }
      }
    } else {
      table.status = 'available';
    }

    await table.save();

    const updatedTableForSocket = await getPopulatedTableWithPerGameCost(table._id);
    if (updatedTableForSocket && updatedTableForSocket.venueId && updatedTableForSocket.venueId._id) {
      const venueRoomId = updatedTableForSocket.venueId._id.toString();
      console.log(`[TABLE_ROUTE_CONFIRM_WIN] Attempting to emit tableStatusUpdate for table ${tableId} to room: ${venueRoomId}. perGameCost: ${updatedTableForSocket.perGameCost}`);
      io.to(venueRoomId).emit('tableStatusUpdate', updatedTableForSocket);
      console.log(`[TABLE_ROUTE_CONFIRM_WIN] Emitted tableStatusUpdate for table ${tableId} to room: ${venueRoomId}.`);
    } else {
      console.warn(`[TABLE_ROUTE_CONFIRM_WIN] Not emitting tableStatusUpdate for ${tableId} because updatedTableForSocket or its venueId/_id is null/undefined.`);
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

    const player1 = await User.findById(table.currentPlayers.player1Id);
    const player2 = await User.findById(table.currentPlayers.player2Id);

    const notificationTitle = 'Win Disputed!';
    const notificationBody = `${req.user.displayName || req.user.email} has disputed the win claim on Table ${table.tableNumber}. The game state has been reverted.`;

    // Defensive check for admin instance
    const admin = req.app.get('admin'); // Get the admin instance
    if (player1 && player1.fcmTokens && player1.fcmTokens.length > 0) {
      if (admin) { // Check if admin instance is available
        req.app.get('admin').messaging().sendEachForMulticast({
          notification: { title: notificationTitle, body: notificationBody },
          data: { type: 'win_disputed', tableId: tableId.toString(), tableNumber: table.tableNumber.toString() },
          tokens: player1.fcmTokens,
        }).catch(error => console.error(`FCM: Error sending dispute notification to player1:`, error));
      } else {
        console.error('[TABLE_ROUTE_DISPUTE_WIN] Firebase Admin SDK instance not found on app object. Cannot send FCM notification to player1.');
      }
    }
    if (player2 && player2.fcmTokens && player2.fcmTokens.length > 0) {
      if (admin) { // Check if admin instance is available
        req.app.get('admin').messaging().sendEachForMulticast({
          notification: { title: notificationTitle, body: notificationBody },
          data: { type: 'win_disputed', tableId: tableId.toString(), tableNumber: table.tableNumber.toString() },
          tokens: player2.fcmTokens,
        }).catch(error => console.error(`FCM: Error sending dispute notification to player2:`, error));
      } else {
        console.error('[TABLE_ROUTE_DISPUTE_WIN] Firebase Admin SDK instance not found on app object. Cannot send FCM notification to player2.');
      }
    }

    const updatedTableForSocket = await getPopulatedTableWithPerGameCost(table._id);
    if (updatedTableForSocket && updatedTableForSocket.venueId && updatedTableForSocket.venueId._id) {
      const venueRoomId = updatedTableForSocket.venueId._id._id.toString();
      console.log(`[TABLE_ROUTE_DISPUTE_WIN] Attempting to emit tableStatusUpdate for table ${tableId} to room: ${venueRoomId}. perGameCost: ${updatedTableForSocket.perGameCost}`);
      io.to(venueRoomId).emit('tableStatusUpdate', updatedTableForSocket);
      console.log(`[TABLE_ROUTE_DISPUTE_WIN] Emitted tableStatusUpdate for table ${tableId} to room: ${venueRoomId}.`);
    } else {
      console.warn(`[TABLE_ROUTE_DISPUTE_WIN] Not emitting tableStatusUpdate for ${tableId} because updatedTableForSocket or its venueId/_id is null/undefined.`);
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

    const updatedTableForSocket = await getPopulatedTableWithPerGameCost(table._id);
    if (updatedTableForSocket && updatedTableForSocket.venueId && updatedTableForSocket.venueId._id) {
      const venueRoomId = updatedTableForSocket.venueId._id.toString();
      console.log(`[TABLE_ROUTE_REMOVE_PLAYER] Attempting to emit tableStatusUpdate for table ${tableId} to room: ${venueRoomId}. perGameCost: ${updatedTableForSocket.perGameCost}`);
      io.to(venueRoomId).emit('tableStatusUpdate', updatedTableForSocket);
      console.log(`[TABLE_ROUTE_REMOVE_PLAYER] Emitted tableStatusUpdate for table ${tableId} to room: ${venueRoomId}.`);
    } else {
      console.warn(`[TABLE_ROUTE_REMOVE_PLAYER] Not emitting tableStatusUpdate for ${tableId} because updatedTableForSocket or its venueId/_id is null/undefined.`);
    }

    res.status(200).json({ message: 'Player removed successfully.' });
  } catch (error) {
    console.error('Error removing player:', error);
    res.status(500).json({ message: 'Server error removing player.', error: error.message });
  }
});

/**
 * @route POST /api/tables/:tableId/pay-with-tokens
 * @description Deduct tokens from user's balance for a table. Does NOT affect table status or player assignment.
 * @access Private
 * @body {number} cost - The number of tokens to deduct (should match venue's perGameCost).
 */
router.post('/:tableId/pay-with-tokens', async (req, res) => {
  const { tableId } = req.params;
  const { cost } = req.body;
  const userId = req.user.uid;
  const io = getSocketIO();

  console.log(`[PAY_DEBUG] Attempting to process payment for userId: ${userId} on tableId: ${tableId}`);
  console.log(`[PAY_DEBUG] Cost received from frontend: ${cost}`);

  try {
    const user = await User.findById(userId);

    if (!user) {
      console.error(`[PAY_ERROR] User not found in DB for _id (Firebase UID): ${userId}`);
      return res.status(404).json({ message: 'User not found.' });
    }
    console.log(`[PAY_DEBUG] User found: ${user.email}, current balance: ${user.tokenBalance}`);

    const table = await Table.findById(tableId).populate('venueId');

    if (!table) {
      console.error(`[PAY_ERROR] Table not found for tableId: ${tableId}`);
      return res.status(404).json({ message: 'Table not found.' });
    }
    if (!table.venueId) {
      console.error(`[PAY_ERROR] Venue not populated for tableId: ${tableId}. Check Table model populate path.`);
      return res.status(500).json({ message: 'Table\'s venue information is missing.' });
    }

    const expectedCost = table.venueId.perGameCost;
    console.log(`[PAY_DEBUG] Venue perGameCost: ${expectedCost}`);
    if (typeof cost !== 'number' || isNaN(cost) || cost !== expectedCost) {
      console.warn(`[PAY_WARN] Mismatch or invalid cost. Expected ${expectedCost}, received ${cost}.`);
      return res.status(400).json({ message: `Invalid or mismatching table cost. Expected ${expectedCost}.` });
    }

    if (user.tokenBalance < cost) {
      console.warn(`[PAY_WARN] Insufficient token balance for user ${userId}. Balance: ${user.tokenBalance}, Cost: ${cost}`);
      return res.status(400).json({ message: 'Insufficient token balance.' });
    }

    user.tokenBalance -= cost;
    await user.save();
    console.log(`[PAY_DEBUG] Tokens deducted. New balance for ${userId}: ${user.tokenBalance}`);

    io.to(userId).emit('tokenBalanceUpdate', { newBalance: user.tokenBalance });
    console.log(`[PAY_DEBUG] Emitted tokenBalanceUpdate to user ${userId}`);

    res.status(200).json({ message: `Successfully paid ${cost} tokens for Table ${table.tableNumber}. Your new balance is ${user.tokenBalance} tokens.`, newBalance: user.tokenBalance });

  } catch (error) {
    console.error(`[PAY_ERROR] Server error processing token payment for userId ${userId}:`, error);
    res.status(500).json({ message: 'Server error processing token payment.', error: error.message });
  }
});

module.exports = router;

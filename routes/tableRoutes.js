// routes/tableRoutes.js
const express = require('express');
const router = express.Router();
const Table = require('../models/Table');
const User = require('../models/User');
const Session = require('../models/Session');
const Venue = require('../models/Venue'); // Make sure Venue is imported if needed for notifications
const authMiddleware = require('../middleware/authMiddleware');
const { getSocketIO } = require('../services/socketService');
const { sendPushNotification } = require('../services/notificationService');
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
    const table = await Table.findById(req.params.tableId);
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
 * @route GET /api/tables/:tableId/status
 * @description Get the current status of a specific table.
 * @access Private
 */
router.get('/:tableId/status', async (req, res) => {
  try {
    const table = await Table.findById(req.params.tableId);
    if (!table) {
      return res.status(404).json({ message: 'Table not found.' });
    }
    res.json({ status: table.status, currentSessionId: table.currentSessionId });
  } catch (error) {
    console.error('Error fetching table status:', error);
    res.status(500).json({ message: 'Server error fetching table status.' });
  }
});

/**
 * @route POST /api/tables/:tableId/join-queue
 * @description Add user to a table's queue.
 * @access Private
 * @body {string} userId
 */
router.post('/:tableId/join-queue', async (req, res) => {
  const { tableId } = req.params;
  const { userId } = req.body; // User ID from request body

  if (req.user.uid !== userId) {
    return res.status(403).json({ message: 'Unauthorized: You can only join the queue for yourself.' });
  }

  try {
    const table = await Table.findById(tableId);
    if (!table) {
      return res.status(404).json({ message: 'Table not found.' });
    }

    // Check if user is already in queue or playing
    if (table.queue.includes(userId) || table.currentPlayers.player1Id === userId || table.currentPlayers.player2Id === userId) {
      return res.status(400).json({ message: 'You are already in the queue or playing on this table.' });
    }

    table.queue.push(userId);
    table.status = 'queued'; // Update status if not already
    await table.save();

    const io = getSocketIO();
    const populatedTable = await populateTablePlayersDetails(await populateQueueWithUserDetails(table.toObject()));
    io.to(table.venueId.toString()).emit('tableUpdate', populatedTable); // Emit update to venue room

    res.status(200).json({ message: 'Successfully joined queue.' });
  } catch (error) {
    console.error('Error joining queue:', error);
    res.status(500).json({ message: 'Server error joining queue.', error: error.message });
  }
});

/**
 * @route POST /api/tables/:tableId/leave-queue
 * @description Remove user from a table's queue.
 * @access Private
 * @body {string} userId
 */
router.post('/:tableId/leave-queue', async (req, res) => {
  const { tableId } = req.params;
  const { userId } = req.body;

  if (req.user.uid !== userId) {
    return res.status(403).json({ message: 'Unauthorized: You can only leave the queue for yourself.' });
  }

  try {
    const table = await Table.findById(tableId);
    if (!table) {
      return res.status(404).json({ message: 'Table not found.' });
    }

    const initialQueueLength = table.queue.length;
    table.queue = table.queue.filter(id => id !== userId);

    if (table.queue.length === initialQueueLength) {
      return res.status(400).json({ message: 'You are not in the queue for this table.' });
    }

    if (table.queue.length === 0 && table.status === 'queued') {
      table.status = 'available'; // Revert to available if queue is empty
    }
    await table.save();

    const io = getSocketIO();
    const populatedTable = await populateTablePlayersDetails(await populateQueueWithUserDetails(table.toObject()));
    io.to(table.venueId.toString()).emit('tableUpdate', populatedTable); // Emit update to venue room

    res.status(200).json({ message: 'Successfully left queue.' });
  } catch (error) {
    console.error('Error leaving queue:', error);
    res.status(500).json({ message: 'Server error leaving queue.', error: error.message });
  }
});

/**
 * @route POST /api/tables/:tableId/direct-join
 * @description Allow a user to directly join a table. If a second player is present, starts a game.
 * @access Private
 * @body {string} userId
 */
router.post('/:tableId/direct-join', async (req, res) => {
  const { tableId } = req.params;
  const { userId } = req.body;

  if (req.user.uid !== userId) {
    return res.status(403).json({ message: 'Unauthorized: You can only join a table for yourself.' });
  }

  try {
    const table = await Table.findById(tableId);
    if (!table) {
      return res.status(404).json({ message: 'Table not found.' });
    }

    // Check if table is available or if user is already playing
    if (table.status === 'maintenance') {
      return res.status(400).json({ message: 'Table is under maintenance and cannot be joined.' });
    }
    if (table.currentPlayers.player1Id === userId || table.currentPlayers.player2Id === userId) {
      return res.status(400).json({ message: 'You are already playing on this table.' });
    }
    if (table.queue.includes(userId)) {
      return res.status(400).json({ message: 'You are already in the queue for this table. Please leave the queue first if you wish to direct join.' });
    }

    const io = getSocketIO();

    let message = 'Waiting for a second player to join directly.';
    let sessionId = null;

    if (!table.currentPlayers.player1Id) {
      // If player1 slot is empty, current user becomes player1
      table.currentPlayers.player1Id = userId;
      table.status = 'occupied'; // Mark as occupied
      console.log(`[DirectJoin] Table ${table.tableNumber}: Player 1 set to ${userId}.`);
    } else if (!table.currentPlayers.player2Id) {
      // If player2 slot is empty, current user becomes player2
      table.currentPlayers.player2Id = userId;
      table.status = 'in_play'; // Game starts
      console.log(`[DirectJoin] Table ${table.tableNumber}: Player 2 set to ${userId}. Game starting.`);

      // Create a new session for the game
      const newSession = new Session({
        tableId: table._id,
        venueId: table.venueId,
        player1Id: table.currentPlayers.player1Id,
        player2Id: userId,
        startTime: new Date(),
        cost: 0, // Cost will be handled by the 'pay-for-table' endpoint
        status: 'active',
        type: 'direct_join', // Use 'direct_join' type
      });
      await newSession.save();
      table.currentSessionId = newSession._id;
      sessionId = newSession._id;
      message = 'Game started! You have successfully joined the game directly.';

      // Notify both players that game has started
      const p1 = await User.findById(table.currentPlayers.player1Id);
      const p2 = await User.findById(userId);
      const venue = await Venue.findById(table.venueId); // Fetch venue for name

      if (p1 && p1.fcmToken) {
        sendPushNotification(p1.fcmToken, 'Game Started!', `Your game on Table ${table.tableNumber} at ${venue?.name || 'a venue'} has started!`);
      }
      if (p2 && p2.fcmToken) {
        sendPushNotification(p2.fcmToken, 'Game Started!', `Your game on Table ${table.tableNumber} at ${venue?.name || 'a venue'} has started!`);
      }
    } else {
      // Both slots are occupied
      return res.status(400).json({ message: 'Table is already occupied by two players.' });
    }

    await table.save();

    const populatedTable = await populateTablePlayersDetails(await populateQueueWithUserDetails(table.toObject()));
    io.to(table.venueId.toString()).emit('tableUpdate', populatedTable); // Emit update to venue room

    res.status(200).json({ message, sessionId });
  } catch (error) {
    console.error('Error direct joining table:', error);
    res.status(500).json({ message: 'Server error direct joining table.', error: error.message });
  }
});

/**
 * @route POST /api/tables/:tableId/pay-for-table
 * @description Deducts tokens from user, creates a session, and updates table status.
 * @access Private
 * @body {string} userId - The Firebase UID of the user paying.
 * @body {number} cost - The token cost for the game.
 * @body {string} venueId - The ID of the venue.
 */
router.post('/:tableId/pay-for-table', async (req, res) => {
  const { tableId } = req.params;
  const { userId, cost, venueId } = req.body;
  const io = getSocketIO();

  if (req.user.uid !== userId) {
    return res.status(403).json({ message: 'Unauthorized: You can only pay for yourself.' });
  }

  if (typeof cost !== 'number' || cost <= 0) {
    return res.status(400).json({ message: 'Invalid game cost provided.' });
  }

  try {
    const user = await User.findById(userId);
    if (!user) {
      console.error(`[PayForTable] User not found for UID: ${userId}`);
      return res.status(404).json({ message: 'User not found.' });
    }

    if (user.tokenBalance < cost) {
      console.warn(`[PayForTable] Insufficient tokens for user ${userId}. Balance: ${user.tokenBalance}, Cost: ${cost}`);
      return res.status(400).json({ message: `Insufficient tokens. You need ${cost} tokens.` });
    }

    const table = await Table.findById(tableId);
    if (!table) {
      console.error(`[PayForTable] Table not found for ID: ${tableId}`);
      return res.status(404).json({ message: 'Table not found.' });
    }

    if (table.status !== 'available' && table.status !== 'occupied') {
        console.warn(`[PayForTable] Table ${tableId} is not available or occupied, current status: ${table.status}`);
        return res.status(400).json({ message: `Table is not available for a new game (current status: ${table.status}).` });
    }

    // Deduct tokens
    user.tokenBalance -= cost;
    await user.save();
    console.log(`[PayForTable] User ${userId} token balance updated. New balance: ${user.tokenBalance}`);

    // Create a new session for this game payment
    const newSession = new Session({
      tableId: table._id,
      venueId: venueId,
      player1Id: userId, // The user paying is player1 for this session
      player2Id: null, // Initially null, can be updated later if another player joins
      startTime: new Date(),
      cost: cost,
      status: 'active', // Mark session as active upon payment
      type: 'game', // Type 'game' for paid games
    });
    await newSession.save();
    console.log(`[PayForTable] New session created: ${newSession._id}`);

    // Update table status and current session
    table.status = 'in_play'; // Table is now in play
    table.currentPlayers.player1Id = userId; // Set the paying user as player 1
    table.currentSessionId = newSession._id;
    await table.save();
    console.log(`[PayForTable] Table ${tableId} status updated to 'in_play'.`);


    // Emit tokenBalanceUpdate to the paying user
    io.to(userId).emit('tokenBalanceUpdate', { newBalance: user.tokenBalance });
    console.log(`[Socket.IO] Emitted tokenBalanceUpdate to user ${userId} with new balance: ${user.tokenBalance}`);

    // Emit tableUpdate to the venue room
    const populatedTable = await populateTablePlayersDetails(await populateQueueWithUserDetails(table.toObject()));
    io.to(table.venueId.toString()).emit('tableUpdate', populatedTable);
    console.log(`[Socket.IO] Emitted tableUpdate for table ${tableId} to venue room ${table.venueId}`);

    res.status(200).json({
      message: 'Tokens deducted and game session started!',
      newBalance: user.tokenBalance,
      sessionId: newSession._id,
      tableStatus: table.status,
    });

  } catch (error) {
    console.error('[PayForTable Error]', error);
    res.status(500).json({ message: 'Server error processing payment for table.', error: error.message });
  }
});


/**
 * @route POST /api/tables/:tableId/claim-win
 * @description Allows a player to claim a win for an active session.
 * @access Private
 * @body {string} sessionId
 * @body {string} winnerId - The Firebase UID of the player claiming the win.
 */
router.post('/:tableId/claim-win', async (req, res) => {
  const { tableId } = req.params;
  const { sessionId, winnerId } = req.body;
  const io = getSocketIO();

  if (req.user.uid !== winnerId) {
    return res.status(403).json({ message: 'Unauthorized: You can only claim a win for yourself.' });
  }

  try {
    const session = await Session.findById(sessionId);
    const table = await Table.findById(tableId);
    const venue = await Venue.findById(table.venueId); // Fetch venue for notification

    if (!session || !table) {
      return res.status(404).json({ message: 'Session or Table not found.' });
    }

    if (session.status !== 'active') {
      return res.status(400).json({ message: 'Session is not active or already ended.' });
    }

    if (table.currentSessionId.toString() !== sessionId) {
      return res.status(400).json({ message: 'Provided session is not the current active session for this table.' });
    }

    // Ensure the winner is one of the players in the session
    if (session.player1Id !== winnerId && session.player2Id !== winnerId) {
      return res.status(403).json({ message: 'You are not a player in this session.' });
    }

    // Set session status to pending_confirmation
    session.status = 'pending_confirmation';
    session.winnerId = winnerId; // Store the claimed winner
    session.endTime = new Date(); // Mark end time when win is claimed
    await session.save();

    console.log(`[ClaimWin] Session ${sessionId} status set to pending_confirmation by ${winnerId}.`);

    // Notify the other player (if exists) for confirmation
    let opponentId = null;
    if (session.player1Id === winnerId && session.player2Id) {
      opponentId = session.player2Id;
    } else if (session.player2Id === winnerId && session.player1Id) {
      opponentId = session.player1Id;
    }

    if (opponentId) {
      const opponent = await User.findById(opponentId);
      const winnerUser = await User.findById(winnerId);
      if (opponent && opponent.fcmToken && winnerUser) {
        console.log(`[ClaimWin] Sending push notification to opponent ${opponentId} for win confirmation.`);
        sendPushNotification(
          opponent.fcmToken,
          'Game Result Confirmation',
          `${winnerUser.displayName || winnerUser.email} claims victory on Table ${table.tableNumber} at ${venue?.name || 'a venue'}. Confirm or Dispute?`,
          {
            type: 'win_confirmation',
            sessionId: sessionId,
            tableId: tableId,
            winnerId: winnerId,
            winnerName: winnerUser.displayName || winnerUser.email,
            venueName: venue?.name || 'Unknown Venue', // Pass venue name
            tableNumber: table.tableNumber,
          }
        );
      }
    } else {
      // Single player game or no opponent
      // Immediately finalize the session for single player games
      session.status = 'completed';
      await session.save();
      table.status = 'available';
      table.currentPlayers = { player1Id: null, player2Id: null };
      table.currentSessionId = null;
      await table.save();
      console.log(`[ClaimWin] Single-player game on table ${tableId} completed immediately.`);
    }

    const populatedTable = await populateTablePlayersDetails(await populateQueueWithUserDetails(table.toObject()));
    io.to(table.venueId.toString()).emit('tableUpdate', populatedTable); // Emit update to venue room

    res.status(200).json({ message: 'Win claimed. Waiting for opponent confirmation.' });

  } catch (error) {
    console.error('Error claiming win:', error);
    res.status(500).json({ message: 'Server error claiming win.', error: error.message });
  }
});

/**
 * @route POST /api/tables/:tableId/confirm-win
 * @description Confirms a claimed win.
 * @access Private
 * @body {string} sessionId
 * @body {string} winnerId - The Firebase UID of the player who claimed the win (to verify).
 */
router.post('/:tableId/confirm-win', async (req, res) => {
  const { tableId } = req.params;
  const { sessionId, winnerId } = req.body; // winnerId is the player who claimed the win
  const confirmerId = req.user.uid; // confirmerId is the current authenticated user
  const io = getSocketIO();

  try {
    const session = await Session.findById(sessionId);
    const table = await Table.findById(tableId);

    if (!session || !table) {
      return res.status(404).json({ message: 'Session or Table not found.' });
    }

    if (session.status !== 'pending_confirmation' || session.winnerId !== winnerId) {
      return res.status(400).json({ message: 'Session is not pending confirmation for this winner.' });
    }

    // Ensure the confirmer is the other player in the session
    const isConfirmerPlayer1 = session.player1Id === confirmerId;
    const isConfirmerPlayer2 = session.player2Id === confirmerId;

    if (!isConfirmerPlayer1 && !isConfirmerPlayer2) {
      return res.status(403).json({ message: 'You are not a player in this session.' });
    }
    if (confirmerId === winnerId) {
      return res.status(400).json({ message: 'You cannot confirm your own win.' });
    }

    // Finalize the session
    session.status = 'completed';
    await session.save();
    console.log(`[ConfirmWin] Session ${sessionId} confirmed. Winner: ${winnerId}`);

    // Reset table status
    table.status = 'available';
    table.currentPlayers = { player1Id: null, player2Id: null };
    table.currentSessionId = null;
    await table.save();
    console.log(`[ConfirmWin] Table ${tableId} reset to available.`);

    const populatedTable = await populateTablePlayersDetails(await populateQueueWithUserDetails(table.toObject()));
    io.to(table.venueId.toString()).emit('tableUpdate', populatedTable); // Emit update to venue room

    res.status(200).json({ message: 'Win confirmed successfully. Table is now available.' });

  } catch (error) {
    console.error('Error confirming win:', error);
    res.status(500).json({ message: 'Server error confirming win.', error: error.message });
  }
});

/**
 * @route POST /api/tables/:tableId/dispute-win
 * @description Allows a player to dispute a claimed win.
 * @access Private
 * @body {string} sessionId
 * @body {string} disputerId - The Firebase UID of the player disputing the win.
 */
router.post('/:tableId/dispute-win', async (req, res) => {
  const { tableId } = req.params;
  const { sessionId, disputerId } = req.body;
  const io = getSocketIO();

  if (req.user.uid !== disputerId) {
    return res.status(403).json({ message: 'Unauthorized: You can only dispute a win for yourself.' });
  }

  try {
    const session = await Session.findById(sessionId);
    const table = await Table.findById(tableId);

    if (!session || !table) {
      return res.status(404).json({ message: 'Session or Table not found.' });
    }

    if (session.status !== 'pending_confirmation' || session.winnerId === disputerId) {
      return res.status(400).json({ message: 'Session is not pending confirmation or you cannot dispute your own win.' });
    }

    // Ensure the disputer is one of the players in the session
    const isDisputerPlayer1 = session.player1Id === disputerId;
    const isDisputerPlayer2 = session.player2Id === disputerId;

    if (!isDisputerPlayer1 && !isDisputerPlayer2) {
      return res.status(403).json({ message: 'You are not a player in this session.' });
    }

    // Set session status to disputed
    session.status = 'disputed';
    await session.save();
    console.log(`[DisputeWin] Session ${sessionId} status set to disputed by ${disputerId}.`);

    // Reset table status (or set to maintenance for admin review)
    table.status = 'maintenance'; // Admin needs to review disputed games
    table.currentPlayers = { player1Id: null, player2Id: null };
    table.currentSessionId = null;
    await table.save();
    console.log(`[DisputeWin] Table ${tableId} set to maintenance due to dispute.`);

    const populatedTable = await populateTablePlayersDetails(await populateQueueWithUserDetails(table.toObject()));
    io.to(table.venueId.toString()).emit('tableUpdate', populatedTable); // Emit update to venue room

    // Notify admin or relevant parties about the dispute
    // (Implementation for admin notification would go here)

    res.status(200).json({ message: 'Win disputed. Table is now under review.' });

  } catch (error) {
    console.error('Error disputing win:', error);
    res.status(500).json({ message: 'Server error disputing win.', error: error.message });
  }
});

/**
 * @route POST /api/tables/:tableId/remove-player
 * @description Admin action to remove a specific player from an active table.
 * @access Private (Admin only)
 * @body {string} playerIdToRemove - The Firebase UID of the player to remove.
 */
router.post('/:tableId/remove-player', async (req, res) => {
  const { tableId } = req.params;
  const { playerIdToRemove } = req.body;
  const io = getSocketIO();

  if (!req.user.isAdmin) {
    return res.status(403).json({ message: 'Access denied. Only administrators can remove players.' });
  }
  if (!playerIdToRemove) {
    return res.status(400).json({ message: 'Player ID to remove is required.' });
  }

  try {
    const table = await Table.findById(tableId);
    if (!table) {
      return res.status(404).json({ message: 'Table not found.' });
    }

    let playerRemoved = false;
    if (table.currentPlayers.player1Id === playerIdToRemove) {
      table.currentPlayers.player1Id = null;
      playerRemoved = true;
      console.log(`[Admin] Player1 (${playerIdToRemove}) removed from table ${tableId}.`);
    } else if (table.currentPlayers.player2Id === playerIdToRemove) {
      table.currentPlayers.player2Id = null;
      playerRemoved = true;
      console.log(`[Admin] Player2 (${playerIdToRemove}) removed from table ${tableId}.`);
    } else {
      return res.status(400).json({ message: 'Player not found on this table.' });
    }

    // If both players are removed, reset table status
    if (!table.currentPlayers.player1Id && !table.currentPlayers.player2Id) {
      table.status = 'available';
      table.currentSessionId = null; // Clear session if no players
      console.log(`[Admin] Table ${tableId} is now available.`);
    } else if (table.currentPlayers.player1Id && !table.currentPlayers.player2Id) {
      // If only player 2 was removed and player 1 remains, table is still occupied
      table.status = 'occupied';
      console.log(`[Admin] Table ${tableId} is now occupied by one player.`);
    }

    await table.save();

    const populatedTable = await populateTablePlayersDetails(await populateQueueWithUserDetails(table.toObject()));
    io.to(table.venueId.toString()).emit('tableUpdate', populatedTable); // Emit update to venue room

    res.status(200).json({ message: 'Player removed successfully.', table: populatedTable });
  } catch (error) {
    console.error('Error removing player from table:', error);
    res.status(500).json({ message: 'Server error removing player.', error: error.message });
  }
});

/**
 * @route POST /api/tables/:tableId/clear-queue
 * @description Admin action to clear the queue for a specific table.
 * @access Private (Admin only)
 */
router.post('/:tableId/clear-queue', async (req, res) => {
  const { tableId } = req.params;
  const io = getSocketIO();

  if (!req.user.isAdmin) {
    return res.status(403).json({ message: 'Access denied. Only administrators can clear queues.' });
  }

  try {
    const table = await Table.findById(tableId);
    if (!table) {
      return res.status(404).json({ message: 'Table not found.' });
    }

    if (table.queue.length === 0) {
      return res.status(200).json({ message: 'Queue is already empty.', table: table });
    }

    table.queue = []; // Clear the queue
    if (table.status === 'queued') {
      table.status = 'available'; // If only queueing, revert to available
    }
    await table.save();
    console.log(`[Admin] Queue for table ${tableId} cleared.`);

    const populatedTable = await populateTablePlayersDetails(await populateQueueWithUserDetails(table.toObject()));
    io.to(table.venueId.toString()).emit('tableUpdate', populatedTable); // Emit update to venue room

    res.status(200).json({ message: 'Queue cleared successfully.', table: populatedTable });
  } catch (error) {
    console.error('Error clearing queue:', error);
    res.status(500).json({ message: 'Server error clearing queue.', error: error.message });
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
  const userId = req.user.uid;
  const io = getSocketIO();

  try {
    // 1. Find the user and table
    const user = await User.findOne({ firebaseUid: userId });
    const table = await Table.findById(tableId).populate('venueId'); // Populate venue to get perGameCost

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }
    if (!table) {
      return res.status(404).json({ message: 'Table not found.' });
    }

    // 2. Verify cost matches venue's perGameCost
    const expectedCost = table.venueId.perGameCost;
    if (cost !== expectedCost) {
      return res.status(400).json({ message: `Mismatch in table cost. Expected ${expectedCost}, received ${cost}.` });
    }

    // 3. Check token balance
    if (user.tokenBalance < cost) {
      return res.status(400).json({ message: 'Insufficient token balance.' });
    }

    // 4. Deduct tokens
    user.tokenBalance -= cost;
    await user.save();

    // 5. Emit token balance update to user (ONLY this update)
    io.to(userId).emit('tokenBalanceUpdate', { newBalance: user.tokenBalance });

    // IMPORTANT: No changes to table status or currentPlayers here.
    // No tableStatusUpdate emitted for the venue room.

    res.status(200).json({ message: `Successfully paid ${cost} tokens for Table ${table.tableNumber}. Your new balance is ${user.tokenBalance} tokens.`, newBalance: user.tokenBalance });

  } catch (error) {
    console.error('Error paying with tokens:', error);
    res.status(500).json({ message: 'Server error processing token payment.', error: error.message });
  }
});


module.exports = router;

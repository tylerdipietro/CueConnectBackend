// services/gameService.js
// This file centralizes game-related logic for better organization and reusability.

const Table = require('../models/Table');
const User = require('../models/User'); // Assuming User model is available for displayName
const Session = require('../models/Session');
const { getSocketIO } = require('./socketService'); // To get the Socket.IO instance

/**
 * Helper function to populate queue with user display names
 * This function fetches User documents based on the UIDs in the queue
 * and returns an array of objects containing the user's _id (UID) and displayName.
 * @param {Array<string>} queueIds - Array of user UIDs (strings) stored in the queue.
 * @returns {Promise<Array<{_id: string, displayName: string}>>} - A promise that resolves to an array
 * of objects, each containing the user's _id and displayName. If a user is not found,
 * their displayName will be 'Unnamed User'.
 */
const populateQueueWithUserDetails = async (queue) => {
  if (!queue || queue.length === 0) return [];

  const users = await User.find({ _id: { $in: queue } }).select('_id displayName').lean();

  // Preserve original queue order
  const userMap = new Map(users.map(u => [u._id.toString(), u]));

  return queue.map(userId => userMap.get(userId.toString()) || { _id: userId, displayName: 'Unknown User' });
};

/**
 * Helper function to populate display names for players currently on a table.
 * This function fetches User documents for player1Id and player2Id and adds their display names
 * to the table object's currentPlayers field.
 *
 * @param {Object} table - The table object (Mongoose document or lean object).
 * @returns {Promise<Object>} - The table object with currentPlayers.player1DisplayName and player2DisplayName added.
 */
const populateTablePlayersDetails = async (table) => {
  const updatedTable = { ...table };

  const playerIds = [table.currentPlayers?.player1Id, table.currentPlayers?.player2Id].filter(Boolean);

  if (playerIds.length === 0) return updatedTable;

  const users = await User.find({ _id: { $in: playerIds } }).select('_id displayName').lean();

  const userMap = new Map(users.map(u => [u._id.toString(), u.displayName]));

  updatedTable.currentPlayers = {
    player1Id: table.currentPlayers?.player1Id || null,
    player2Id: table.currentPlayers?.player2Id || null,
    player1DisplayName: table.currentPlayers?.player1Id ? userMap.get(table.currentPlayers.player1Id.toString()) || 'Unknown Player' : 'Empty',
    player2DisplayName: table.currentPlayers?.player2Id ? userMap.get(table.currentPlayers.player2Id.toString()) || 'Unknown Player' : 'Empty',
  };

  return updatedTable;
};




/**
 * Invites the next player from a table's queue to play.
 * This function handles clearing current players (if applicable), updating table status,
 * and sending push notifications and socket updates.
 *
 * @param {string} tableId - The ID of the table.
 * @param {object} io - The Socket.IO instance.
 * @param {function} sendPushNotification - Function to send push notifications.
 * @returns {Promise<void>}
 */
const inviteNextPlayer = async (tableId, io, sendPushNotification) => {
  try {
    const table = await Table.findById(tableId);
    if (!table) {
      console.warn(`[GameService] Table ${tableId} not found for inviting next player.`);
      return;
    }

    // If the table is already occupied by two players, or not 'available'/'queued'
    // This function primarily handles inviting from queue when a spot opens up.
    if (table.currentPlayers.player1Id && table.currentPlayers.player2Id && table.status === 'in_play') {
      console.log(`[GameService] Table ${table.tableNumber} is full (${table.currentPlayers.player1Id}, ${table.currentPlayers.player2Id}). No immediate invitation.`);
      return;
    }

    // Filter out users who are still in the queue but might have declined previous invitations
    // or who are already playing (shouldn't happen here, but good safeguard).
    const activeQueue = table.queue.filter(userIdInQueue =>
      userIdInQueue !== table.currentPlayers.player1Id &&
      userIdInQueue !== table.currentPlayers.player2Id
    );

    if (activeQueue.length === 0) {
      console.log(`[GameService] Table ${table.tableNumber} queue is empty. No one to invite.`);
      // If queue is empty, set status to available if no players are active
      if (!table.currentPlayers.player1Id && !table.currentPlayers.player2Id) {
        table.status = 'available';
        await table.save();
        // Emit general table status update
        const populatedQueue = await populateQueueWithUserDetails(table.queue); // Queue is empty, but consistent structure
        const finalTableState = await populateTablePlayersDetails({ ...table.toJSON(), queue: populatedQueue });
        io.to(table.venueId.toString()).emit('tableStatusUpdate', finalTableState);
      }
      return;
    }

    const nextPlayerId = activeQueue[0];
    const nextPlayer = await User.findById(nextPlayerId).select('fcmTokens displayName').lean();

    if (!nextPlayer) {
      console.warn(`[GameService] Next player ${nextPlayerId} not found in DB. Removing from queue.`);
      table.queue = table.queue.filter(uid => uid !== nextPlayerId);
      await table.save();
      // Recurse to try the next person if this one was invalid
      return inviteNextPlayer(tableId, io, sendPushNotification);
    }

    // Assign player to the next available slot
    if (!table.currentPlayers.player1Id) {
      table.currentPlayers.player1Id = nextPlayerId;
    } else if (!table.currentPlayers.player2Id) {
      table.currentPlayers.player2Id = nextPlayerId;
    } else {
      console.warn(`[GameService] Unexpected: Table ${table.tableNumber} slots already full, but inviteNextPlayer was called. No invitation sent.`);
      return; // Should not happen if logic is correct
    }

    // Update table status to 'in_play' or 'occupied' if at least one player is active
    if (table.currentPlayers.player1Id || table.currentPlayers.player2Id) {
        table.status = 'in_play'; // Change to in_play once a player is assigned.
    }
    
    // Remove the invited player from the queue
    table.queue = table.queue.filter(uid => uid !== nextPlayerId);
    await table.save();

    console.log(`[GameService] Inviting ${nextPlayer.displayName || nextPlayerId} to table ${table.tableNumber}.`);

    // Send push notification
    if (nextPlayer.fcmTokens && nextPlayer.fcmTokens.length > 0) {
      await sendPushNotification(
        nextPlayer.fcmTokens,
        'Your Turn to Play!',
        `It's your turn to play on Table ${table.tableNumber}! Head over now.`
      );
    }

    // Emit Socket.IO event to the invited user
    io.to(nextPlayerId).emit('tableInvitation', {
      tableId: table._id,
      tableNumber: table.tableNumber,
      message: `It's your turn to play on Table ${table.tableNumber}!`,
      esp32DeviceId: table.esp32DeviceId, // Include ESP32 ID for frontend activation
    });

    // Populate queue for the general table status update
    const populatedQueue = await populateQueueWithUserDetails(table.queue);
    // Populate current players details for the table status update
    const finalTableState = await populateTablePlayersDetails({ ...table.toJSON(), queue: populatedQueue });
    io.to(table.venueId.toString()).emit('tableStatusUpdate', finalTableState);

  } catch (error) {
    console.error('Error in inviteNextPlayer:', error.message);
  }
};


module.exports = {
  inviteNextPlayer,
  populateQueueWithUserDetails,
  populateTablePlayersDetails // Export the new helper
};
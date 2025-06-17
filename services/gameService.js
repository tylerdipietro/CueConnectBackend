// services/gameService.js
const Table = require('../models/Table'); // Table model
// Note: io and sendPushNotification are passed as arguments to avoid circular dependencies
// or excessive global access, promoting better modularity.

// Helper function to invite the next player in the queue for a given table.
async function inviteNextPlayer(tableId, io, sendPushNotification) {
  try {
    const table = await Table.findById(tableId);
    if (!table) {
        console.warn(`Attempted to invite next player but table ${tableId} not found.`);
        return;
    }

    // Filter for users who are actively waiting in the queue
    const waitingQueue = table.queue.filter(q => q.status === 'waiting');

    // Determine if the table is truly available for a new game to be started via queue
    const isTableAvailableForNewGame = table.status === 'available' && !table.currentSessionId;
    const hasNoCurrentPlayers = !table.currentPlayers.player1Id && !table.currentPlayers.player2Id; // Ensure no one is currently designated as playing

    if (waitingQueue.length > 0 && isTableAvailableForNewGame && hasNoCurrentPlayers) {
      const nextPlayerEntry = waitingQueue[0]; // Get the first user in the waiting queue
      const nextPlayerId = nextPlayerEntry.userId;

      nextPlayerEntry.status = 'invited'; // Change their status to 'invited'
      await table.save(); // Save table to reflect the queue status change

      // Emit a 'playInvitation' event to the invited client via Socket.IO
      io.to(nextPlayerId).emit('playInvitation', {
        tableId: table._id,
        tableNumber: table.tableNumber,
        challengerId: nextPlayerId, // The user being invited
        currentWinnerId: table.currentPlayers.player1Id, // If a winner was staying before this new invitation
        message: `It's your turn to play on Table ${table.tableNumber}!`,
      });
      // Send a push notification to ensure the user is alerted even if app is in background
      sendPushNotification(
        nextPlayerId,
        'Your Turn to Play!',
        `It's your turn to play on Table ${table.tableNumber}!`
      );

      // Emit table status update to all clients in the venue to reflect the queue change
      io.to(table.venueId.toString()).emit('tableStatusUpdate', table.toJSON());

    } else {
      console.log(`No players to invite or table ${table.tableNumber} is not yet ready for a new queue-based game.`);
      // If queue is empty and table is not 'in_play', ensure its status is 'available'
      if (table.status !== 'available' && !table.currentPlayers.player1Id && !table.currentSessionId) {
          table.status = 'available';
          await table.save();
          io.to(table.venueId.toString()).emit('tableStatusUpdate', table.toJSON());
      }
    }
  } catch (error) {
    console.error('Error inviting next player:', error.message);
  }
}

module.exports = {
  inviteNextPlayer
};

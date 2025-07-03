// services/gameService.js
const User = require('../models/User'); // Import the User model

/**
 * Populates player details (displayName) for player1Id and player2Id on a table object.
 * @param {Object} table - The table object (can be a Mongoose document or a plain object).
 * @returns {Promise<Object>} The table object with player1Details and player2Details populated.
 */
const populateTablePlayersDetails = async (table) => {
  const populatedTable = { ...table }; // Create a copy to avoid modifying original Mongoose doc directly

  if (populatedTable.currentPlayers && populatedTable.currentPlayers.player1Id) {
    try {
      const player1 = await User.findById(populatedTable.currentPlayers.player1Id);
      if (player1) {
        populatedTable.player1Details = {
          _id: player1._id,
          displayName: player1.displayName || player1.email, // Use displayName or fallback to email
        };
      } else {
        // Handle case where player1Id exists but user not found (e.g., deleted user)
        populatedTable.player1Details = {
          _id: populatedTable.currentPlayers.player1Id,
          displayName: 'Unknown Player',
        };
      }
    } catch (error) {
      console.error(`Error populating player1Details for ${populatedTable.currentPlayers.player1Id}:`, error);
      populatedTable.player1Details = {
        _id: populatedTable.currentPlayers.player1Id,
        displayName: 'Error Fetching Player',
      };
    }
  }

  if (populatedTable.currentPlayers && populatedTable.currentPlayers.player2Id) {
    try {
      const player2 = await User.findById(populatedTable.currentPlayers.player2Id);
      if (player2) {
        populatedTable.player2Details = {
          _id: player2._id,
          displayName: player2.displayName || player2.email, // Use displayName or fallback to email
        };
      } else {
        // Handle case where player2Id exists but user not found
        populatedTable.player2Details = {
          _id: populatedTable.currentPlayers.player2Id,
          displayName: 'Unknown Player',
        };
      }
    } catch (error) {
      console.error(`Error populating player2Details for ${populatedTable.currentPlayers.player2Id}:`, error);
      populatedTable.player2Details = {
        _id: populatedTable.currentPlayers.player2Id,
        displayName: 'Error Fetching Player',
      };
    }
  }

  return populatedTable;
};

/**
 * Populates user details (displayName) for each userId in the queue array.
 * @param {Array<string>} queue - An array of user IDs (Firebase UIDs).
 * @returns {Promise<Array<Object>>} An array of objects, each with _id and displayName.
 */
const populateQueueWithUserDetails = async (queue) => {
  if (!queue || !Array.isArray(queue) || queue.length === 0) {
    return [];
  }

  const populatedQueue = await Promise.all(
    queue.map(async (userId) => {
      try {
        const user = await User.findById(userId);
        if (user) {
          return {
            _id: user._id,
            displayName: user.displayName || user.email, // Use displayName or fallback to email
          };
        } else {
          // Handle case where userId exists in queue but user not found
          return {
            _id: userId,
            displayName: 'Unknown User',
          };
        }
      } catch (error) {
        console.error(`Error populating queue user details for ${userId}:`, error);
        return {
          _id: userId,
          displayName: 'Error Fetching User',
        };
      }
    })
  );
  return populatedQueue;
};

module.exports = {
  populateTablePlayersDetails,
  populateQueueWithUserDetails,
};

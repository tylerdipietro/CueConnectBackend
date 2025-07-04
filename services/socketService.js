// services/socketService.js

const socketIo = require('socket.io');
const Table = require('../models/Table'); // Import Table model
const { getPopulatedTableWithPerGameCost } = require('./tableHelpers');
const { populateTablePlayersDetails, populateQueueWithUserDetails } = require('./gameService');

let ioInstance;

function initializeSocketIO(server) {
  if (ioInstance) {
    console.warn('Socket.IO already initialized.');
    return ioInstance;
  }
  ioInstance = socketIo(server, {
    cors: {
      origin: "*", // Allow all origins for development. Restrict in production.
      methods: ["GET", "POST"]
    }
  });

  ioInstance.on('connection', (socket) => {
    console.log(`[SOCKET_SERVICE] Socket connected: ${socket.id}`);

    socket.on('registerForUpdates', (userId) => {
      console.log(`[SOCKET_SERVICE] User ${userId} registered socket ${socket.id} for real-time updates.`);
      socket.join(userId); // Join a room specific to the user's ID
    });

    socket.on('joinVenueRoom', async (venueId) => {
      console.log(`[SOCKET_SERVICE] Socket ${socket.id} RECEIVED joinVenueRoom for venue: ${venueId}.`); // NEW LOG
      socket.join(venueId);

      try {
        const tablesInVenue = await Table.find({ venueId });
        const populatedTables = await Promise.all(
          tablesInVenue.map(async (table) => {
            const populatedTable = await getPopulatedTableWithPerGameCost(table._id);
            return populatedTable;
          })
        );
        const validPopulatedTables = populatedTables.filter(t => t !== null);
        
        console.log(`[SOCKET_SERVICE] Sent initialVenueState to socket ${socket.id} for venue ${venueId}. Tables count: ${validPopulatedTables.length}`);
        if (validPopulatedTables.length > 0) {
          console.log(`[SOCKET_SERVICE] First table in initialVenueState (perGameCost): ${validPopulatedTables[0].perGameCost}`);
        }
        socket.emit('initialVenueState', validPopulatedTables);
      } catch (error) {
        console.error(`[SOCKET_SERVICE] Error sending initial venue state for venue ${venueId}:`, error);
      }
    });

    socket.on('leaveVenueRoom', (venueId) => {
      console.log(`[SOCKET_SERVICE] Socket ${socket.id} left venue room: ${venueId}.`);
      socket.leave(venueId);
    });

    socket.on('disconnect', (reason) => {
      console.log(`[SOCKET_SERVICE] Socket disconnected: ${socket.id}, Reason: ${reason}`);
    });
  });

  return ioInstance;
}

function getSocketIO() {
  if (!ioInstance) {
    console.error('CRITICAL ERROR: Socket.IO instance not initialized when getSocketIO was called.');
    throw new Error('Socket.IO not initialized. Call initializeSocketIO first in your main server file.');
  }
  return ioInstance;
}

module.exports = {
  initializeSocketIO,
  getSocketIO
};

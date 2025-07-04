// services/socketService.js

const socketIo = require('socket.io');
const Table = require('../models/Table'); // Import Table model
const { getPopulatedTableWithPerGameCost } = require('../routes/tableRoutes'); // Import the helper
const { populateTablePlayersDetails, populateQueueWithUserDetails } = require('./gameService'); // Assuming this path is correct

let io;

function initializeSocketIO(server) {
  io = socketIo(server, {
    cors: {
      origin: "*", // Allow all origins for development. Restrict in production.
      methods: ["GET", "POST"]
    }
  });

  io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    // Handle user registration for updates (e.g., token balance)
    socket.on('registerForUpdates', (userId) => {
      console.log(`User ${userId} registered socket ${socket.id} for real-time updates.`);
      socket.join(userId); // Join a room specific to the user's ID
    });

    // Handle joining a venue-specific room
    socket.on('joinVenueRoom', async (venueId) => {
      console.log(`Socket ${socket.id} joined venue room: ${venueId}`);
      socket.join(venueId);

      // CRITICAL: Send initial state of tables in this venue to the newly joined socket
      try {
        const tablesInVenue = await Table.find({ venueId });
        const populatedTables = await Promise.all(
          tablesInVenue.map(async (table) => {
            // Use the shared helper function to get fully populated table data with perGameCost
            const populatedTable = await getPopulatedTableWithPerGameCost(table._id);
            return populatedTable;
          })
        );
        // Filter out any nulls if a table couldn't be populated (e.g., venue missing)
        const validPopulatedTables = populatedTables.filter(t => t !== null);
        
        console.log(`[Socket.IO] Sent initialVenueState to socket ${socket.id} for venue ${venueId}. Tables count: ${validPopulatedTables.length}`);
        if (validPopulatedTables.length > 0) {
          console.log(`[Socket.IO] First table in initialVenueState (perGameCost): ${validPopulatedTables[0].perGameCost}`);
        }
        socket.emit('initialVenueState', validPopulatedTables);
      } catch (error) {
        console.error(`Error sending initial venue state for venue ${venueId}:`, error);
      }
    });

    // Handle leaving a venue-specific room
    socket.on('leaveVenueRoom', (venueId) => {
      console.log(`Socket ${socket.id} left venue room: ${venueId}`);
      socket.leave(venueId);
    });

    socket.on('disconnect', (reason) => {
      console.log(`Socket disconnected: ${socket.id}, Reason: ${reason}`);
    });
  });
}

function getSocketIO() {
  if (!io) {
    throw new Error('Socket.IO not initialized. Call initializeSocketIO first.');
  }
  return io;
}

module.exports = {
  initializeSocketIO,
  getSocketIO
};

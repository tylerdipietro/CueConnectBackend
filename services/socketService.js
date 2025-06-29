const Table = require('../models/Table');
const User = require('../models/User'); // or wherever you store user display names
const {
  populateTablePlayersDetails,
  populateQueueWithUserDetails
} = require('../services/gameService');



let ioInstance;



const initializeSocketIO = (httpServer, corsOptions) => {
  ioInstance = require('socket.io')(httpServer, { cors: corsOptions });

  ioInstance.on('connection', (socket) => {
    console.log('A user connected via WebSocket:', socket.id);

    socket.on('registerForUpdates', (userId) => {
      socket.join(userId);
      console.log(`User ${userId} registered socket ${socket.id} for real-time updates.`);
    });

    socket.on('joinVenueRoom', async (venueId) => {
  socket.join(venueId);
  console.log(`Socket ${socket.id} joined venue room: ${venueId}`);

  try {
    // ✅ Fetch the tables from the database first
    const tables = await Table.find({ venueId }).lean();

    const populatedTables = await Promise.all(
      tables.map(async (table) => {
        const populatedQueue = await populateQueueWithUserDetails(table.queue);
        const tableWithQueue = { ...table, queue: populatedQueue };
        const fullyPopulatedTable = await populateTablePlayersDetails(tableWithQueue);
        return fullyPopulatedTable;
      })
    );

    // Emit the full current state only to this socket (not the whole room)
    socket.emit('initialVenueState', populatedTables);
    console.log(`[Socket.IO] Sent initialVenueState to socket ${socket.id}`);
  } catch (error) {
    console.error('Error fetching tables for initialVenueState:', error);
  }
});


    socket.on('leaveVenueRoom', (venueId) => {
      socket.leave(venueId);
      console.log(`Socket ${socket.id} left venue room: ${venueId}`);
    });

    socket.on('disconnect', () => {
      console.log('User disconnected via WebSocket:', socket.id);
    });
  });

  return ioInstance;
};

const getSocketIO = () => {
  if (!ioInstance) {
    throw new Error('Socket.IO not initialized. Call initializeSocketIO first.');
  }
  return ioInstance;
};

module.exports = {
  initializeSocketIO,
  getSocketIO,
};

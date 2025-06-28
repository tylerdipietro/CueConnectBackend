const Table = require('../models/Table');
const User = require('../models/User'); // or wherever you store user display names

let ioInstance;

// Helper: populate queue user details for display
const populateQueueWithUserDetails = async (queueIds) => {
  if (!queueIds || queueIds.length === 0) return [];
  const users = await User.find({ _id: { $in: queueIds } }).select('displayName').lean();
  return queueIds.map(uid => {
    const matchedUser = users.find(u => u._id.toString() === uid.toString());
    return {
      _id: uid,
      displayName: matchedUser?.displayName || 'Unnamed User',
    };
  });
};

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
        const tables = await Table.find({ venueId }).lean();

        // For each table, populate the queue user details
        const populatedTables = await Promise.all(
          tables.map(async (table) => {
            const populatedQueue = await populateQueueWithUserDetails(table.queue);
            return {
              ...table,
              queue: populatedQueue,
            };
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

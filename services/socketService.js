// services/socketService.js
let ioInstance;

// Function to initialize Socket.IO and store its instance
const initializeSocketIO = (httpServer, corsOptions) => {
  ioInstance = require('socket.io')(httpServer, { cors: corsOptions });

  ioInstance.on('connection', (socket) => {
    console.log('A user connected via WebSocket:', socket.id);

    // When a client registers for updates, join them to a private room using their user ID
    socket.on('registerForUpdates', (userId) => {
      socket.join(userId); // Join a room for individual user notifications (e.g., token balance)
      console.log(`User ${userId} registered socket ${socket.id} for real-time updates.`);
    });

    // NEW: Join a room specific to a venue ID
    socket.on('joinVenueRoom', (venueId) => {
      socket.join(venueId);
      console.log(`Socket ${socket.id} joined venue room: ${venueId}`);
    });

    // NEW: Leave a room specific to a venue ID
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

// Function to get the Socket.IO instance
const getSocketIO = () => {
  if (!ioInstance) {
    throw new Error('Socket.IO not initialized. Call initializeSocketIO first.');
  }
  return ioInstance;
};

module.exports = {
  initializeSocketIO,
  getSocketIO
};
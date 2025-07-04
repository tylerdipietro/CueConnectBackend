// server.js
require('dotenv').config(); // Load environment variables from .env file
const express = require('express');
const cors = require('cors');
const http = require('http'); // Import http module

// Import your centralized configuration and service initializer
const { initializeServices } = require('./config');

// Import the Socket.IO initializer and getter
const { initializeSocketIO, getSocketIO } = require('./services/socketService'); // Ensure both are imported

const app = express(); // <--- Express app instance
const server = http.createServer(app); // Create HTTP server for Socket.IO

// IMPORTANT: Initialize Socket.IO with the server instance RIGHT AFTER creating the server.
// If you need CORS options for Socket.IO, pass them here.
initializeSocketIO(server, {
  cors: {
    origin: "*", // Allow all origins for development, restrict in production
    methods: ["GET", "POST"]
  }
});

// Now initialize other services (MongoDB, Firebase Admin, Stripe)
// Pass the 'app' instance here so Firebase Admin can be attached to it.
initializeServices(app); // <--- MODIFIED: Pass 'app' instance


// Middleware
app.use(cors()); // Enable CORS for all routes
app.use(express.json()); // Body parser for JSON requests

// Import the authentication middleware
const authMiddleware = require('./middleware/authMiddleware');

// Apply Firebase authentication middleware to all routes under '/api'
// This middleware will verify the token and populate req.user
// This MUST be placed BEFORE your routes that need authentication.
app.use('/api', authMiddleware);

// Basic route for testing (does not require auth)
app.get('/', (req, res) => {
  res.send('Billiards Hub Backend is running!');
});

// Import routes
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const venueRoutes = require('./routes/venueRoutes');
const tableRoutes = require('./routes/tableRoutes');
const paymentRoutes = require('./routes/paymentRoutes');

// Use routes
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/venues', venueRoutes);
app.use('/api/tables', tableRoutes);
app.use('/api/payments', paymentRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

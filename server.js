// server.js
require('dotenv').config(); // Load environment variables from .env file
const express = require('express');
const cors = require('cors');
const http = require('http'); // Import http module

// Import your centralized configuration and service initializer
const { initializeServices } = require('./config');

// Import the Socket.IO initializer and getter
const { initializeSocketIO, getSocketIO } = require('./services/socketService'); // Ensure both are imported

const app = express();
const server = http.createServer(app); // Create HTTP server for Socket.IO

// IMPORTANT: Initialize Socket.IO with the server instance RIGHT AFTER creating the server.
initializeSocketIO(server);

// Now initialize other services (MongoDB, Firebase Admin, Stripe)
// These don't depend on the 'server' object directly for their setup,
// but they might use the initialized Firebase Admin or Stripe instances.
initializeServices();


// Middleware
app.use(cors()); // Enable CORS for all routes
app.use(express.json()); // Body parser for JSON requests

// Import the authentication middleware
const { verifyFirebaseToken } = require('./middleware/authMiddleware');

// Apply Firebase authentication middleware to all routes under '/api'
// This middleware will verify the token and populate req.user
// This MUST be placed BEFORE your routes that need authentication.
app.use('/api', verifyFirebaseToken);

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

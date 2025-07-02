// server.js
require('dotenv').config(); // Load environment variables from .env file
const express = require('express');
const mongoose = require('mongoose'); // Already imported by config/db.js, but often useful here
const cors = require('cors');
const http = require('http'); // Import http module

// Import your centralized configuration and service initializer
const { initializeServices } = require('./config');
const { getSocketIO } = require('./services/socketService'); // Import socket.io initializer
const { verifyFirebaseToken } = require('./middleware/authMiddleware'); // Import the middleware

// Initialize all services (MongoDB, Firebase Admin, Stripe)
initializeServices();

const app = express();
const server = http.createServer(app); // Create HTTP server for Socket.IO

// Initialize Socket.IO (after HTTP server is created)
getSocketIO(); // This will get the already initialized instance from socketService.js

// Middleware
app.use(cors()); // Enable CORS for all routes
app.use(express.json()); // Body parser for JSON requests

// Apply Firebase authentication middleware to all routes under '/api'
// This middleware will verify the token and populate req.user (Firebase UID, email, isAdmin, tokenBalance, stripeCustomerId)
// This MUST be placed BEFORE your routes that need authentication.
app.use('/api', verifyFirebaseToken);

// Basic route for testing (does not require auth)
app.get('/', (req, res) => {
  res.send('Billiards Hub Backend is running!');
});

// Import routes
const authRoutes = require('./routes/authRoutes'); // Assuming this handles login/signup and token generation
const userRoutes = require('./routes/userRoutes');
const venueRoutes = require('./routes/venueRoutes');
const tableRoutes = require('./routes/tableRoutes');
const paymentRoutes = require('./routes/paymentRoutes');

// Use routes
// Routes mounted under /api will now have req.user populated by verifyFirebaseToken
app.use('/api/auth', authRoutes); // Auth routes might handle their own token verification or be public
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

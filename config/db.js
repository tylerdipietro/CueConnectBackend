// config/db.js
const mongoose = require('mongoose');
const Venue = require('../models/Venue'); // Import the Venue model

const connectDB = async (mongoURI) => {
  try {
    await mongoose.connect(mongoURI, {
      // It's often good practice to include some options for newer Mongoose versions,
      // though they might be default in recent versions.
      // useNewUrlParser: true, // Deprecated in Mongoose 6+
      // useUnifiedTopology: true, // Deprecated in Mongoose 6+
    });
    console.log('MongoDB Connected...');

    // After successful MongoDB connection, ensure the 2dsphere index is created on the Venue collection
    await Venue.collection.createIndex({ location: '2dsphere' });
    console.log('2dsphere index on Venue collection ensured.');

  } catch (err) {
    console.error('MongoDB connection error:', err.message);
    // In a production app, you might want to exit the process or handle this gracefully
    process.exit(1); // Exit process with failure
  }
};

module.exports = connectDB;

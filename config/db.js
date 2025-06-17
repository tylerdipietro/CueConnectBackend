// config/db.js
const mongoose = require('mongoose');

// Function to connect to MongoDB
const connectDB = async (mongoUri) => {
  if (!mongoUri) {
    console.error("MongoDB URI is not provided. Please set MONGODB_URI in your .env file.");
    process.exit(1); // Exit if MongoDB URI is missing
  }

  try {
    await mongoose.connect(mongoUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      // useCreateIndex: true, // Deprecated in recent Mongoose versions
      // useFindAndModify: false // Deprecated in recent Mongoose versions
    });
    console.log('MongoDB connected successfully.');
  } catch (err) {
    console.error('MongoDB connection error:', err.message);
    process.exit(1); // Exit if connection fails
  }
};

module.exports = connectDB;

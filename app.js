// Import the Express framework for building the web server
const express = require('express');

// Import CORS middleware to enable Cross-Origin Resource Sharing
const cors = require('cors');

// Import the 'fs' module's promises API for asynchronous file system operations
const fs = require('fs').promises;

// Load environment variables from a .env file into process.env
require('dotenv').config();

// Import the application's route definitions
const routes = require('./routes');

// Create an instance of the Express application
const app = express();

// Configure Express to parse incoming JSON requests with a size limit of 10MB
app.use(express.json({ limit: '10mb' }));

// Configure Express to parse URL-encoded payloads with a size limit of 10MB
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Enable CORS for all incoming requests (allows requests from different origins)
app.use(cors());

// Mount the application's routes at the root path
app.use('/', routes);

/**
 * Ensures that required directories exist at server startup.
 * If a directory does not exist, it will be created.
 * This is important for directories where files will be uploaded or responses stored.
 */
const initializeDirectories = async () => {
  // List of directories to check/create
  const dirs = ['uploads', 'responses'];
  for (const dir of dirs) {
    try {
      // Attempt to create the directory (does nothing if it already exists)
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      // Log an error if directory creation fails
      console.error(`Failed to create directory ${dir}:`, error.message);
    }
  }
};

// Export the Express app instance and the directory initialization function
module.exports = { app, initializeDirectories };
// Import the Express app instance and a function to initialize required directories
const { app, initializeDirectories } = require('./app');

// Import the SessionManager service for handling user sessions
const SessionManager = require('./services/sessionService');

// Import configuration settings (such as session cleanup interval)
const CONFIG = require('./config/config');

// Set the port for the server to listen on (use environment variable if available, otherwise default to 3000)
const port = process.env.PORT || 3000;

// Start the Express server and perform initialization tasks
app.listen(port, async () => {
  // Log the server URL to the console
  console.log(`Server running on http://localhost:${port}`);

  // Ensure necessary directories exist before handling requests
  await initializeDirectories();
  console.log('Directories initialized');

  // Set up a periodic task to clean up old user sessions
  setInterval(() => {
    // Attempt to clean up old sessions; log any errors that occur
    SessionManager.cleanupOldSessions().catch(error => {
      console.error('Session cleanup error:', error.message);
    });
    // The interval is determined by the SESSION_CLEANUP_HOURS config value (converted to milliseconds)
  }, CONFIG.SESSION_CLEANUP_HOURS * 60 * 60 * 1000);
});
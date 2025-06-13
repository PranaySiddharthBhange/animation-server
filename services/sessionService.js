const fs = require('fs').promises;
const path = require('path');
const CONFIG = require('../config/config');

// SessionManager handles session data storage and cleanup
class SessionManager {
  /**
   * Retrieves session data from disk for a given session ID.
   * Looks for a session.json file in the corresponding session folder.
   * @param {string} sessionId - The unique session identifier.
   * @returns {Promise<object|null>} - Parsed session data, or null if not found.
   */
  static async getSession(sessionId) {
    try {
      // Construct the path to the session.json file
      const sessionPath = path.join('responses', `session_${sessionId}`, 'session.json');
      // Read the file contents as UTF-8 text
      const data = await fs.readFile(sessionPath, 'utf-8');
      // Parse and return the JSON data
      return JSON.parse(data);
    } catch (error) {
      // If the file does not exist, return null (session not found)
      if (error.code !== 'ENOENT') {
        // Log other errors (e.g., permission issues)
        console.error(`Error reading session ${sessionId}:`, error.message);
      }
      return null;
    }
  }

  /**
   * Updates or creates session data on disk for a given session ID.
   * Merges the provided update object with any existing session data.
   * @param {string} sessionId - The unique session identifier.
   * @param {object} update - The data to merge into the session.
   * @returns {Promise<object>} - The updated session object.
   */
  static async updateSession(sessionId, update) {
    // Define the session folder and file paths
    const sessionFolder = path.join('responses', `session_${sessionId}`);
    const sessionPath = path.join(sessionFolder, 'session.json');

    try {
      // Default session object with creation timestamp
      let session = { createdAt: new Date().toISOString() };

      try {
        // Try to read existing session data if it exists
        const existingData = await fs.readFile(sessionPath, 'utf-8');
        session = JSON.parse(existingData);
      } catch (error) {
        // If file doesn't exist, continue with default session object
      }

      // Merge existing session data with the update and add/update timestamp
      const updatedSession = {
        ...session,
        ...update,
        updatedAt: new Date().toISOString()
      };

      // Ensure the session folder exists
      await fs.mkdir(sessionFolder, { recursive: true });
      // Write the updated session data to disk in pretty JSON format
      await fs.writeFile(sessionPath, JSON.stringify(updatedSession, null, 2));

      return updatedSession;
    } catch (error) {
      // Log and rethrow any errors encountered during update
      console.error(`Error updating session ${sessionId}:`, error.message);
      throw error;
    }
  }

  /**
   * Removes old session folders from disk based on the configured session lifetime.
   * Checks the modification time of each session.json file and deletes folders older than the cutoff.
   * @returns {Promise<void>}
   */
  static async cleanupOldSessions() {
    try {
      const responsesDir = 'responses';
      // Read all entries (files and folders) in the responses directory
      const entries = await fs.readdir(responsesDir, { withFileTypes: true });
      // Calculate the cutoff time (sessions older than this will be deleted)
      const cutoffTime = Date.now() - (CONFIG.SESSION_CLEANUP_HOURS * 60 * 60 * 1000);
      let cleanedCount = 0;

      for (const entry of entries) {
        // Only process directories that start with "session_"
        if (entry.isDirectory() && entry.name.startsWith('session_')) {
          const sessionPath = path.join(responsesDir, entry.name);
          const sessionFile = path.join(sessionPath, 'session.json');

          try {
            // Get stats for the session.json file
            const stats = await fs.stat(sessionFile);
            // If the file's last modification time is before the cutoff, delete the folder
            if (stats.mtime.getTime() < cutoffTime) {
              await fs.rm(sessionPath, { recursive: true, force: true });
              cleanedCount++;
              console.log(`Cleaned up old session: ${entry.name}`);
            }
          } catch (error) {
            // If session.json is missing or unreadable, attempt to delete the folder anyway
            try {
              await fs.rm(sessionPath, { recursive: true, force: true });
              cleanedCount++;
            } catch (cleanupError) {
              // Log any errors encountered during forced cleanup
              console.error(`Failed to cleanup ${entry.name}:`, cleanupError.message);
            }
          }
        }
      }

      // Log the number of cleaned sessions if any were deleted
      if (cleanedCount > 0) {
        console.log(`Cleaned up ${cleanedCount} old sessions`);
      }
    } catch (error) {
      // Log any errors encountered during the cleanup process
      console.error('Error during session cleanup:', error.message);
    }
  }
}

module.exports =  SessionManager;
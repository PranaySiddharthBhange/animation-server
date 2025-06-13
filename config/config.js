// Configuration object for environment variables and constants
const CONFIG = {
  // Autodesk Forge client ID (from environment variable)
  FORGE_CLIENT_ID: process.env.FORGE_CLIENT_ID,
  // Autodesk Forge client secret (from environment variable)
  FORGE_CLIENT_SECRET: process.env.FORGE_CLIENT_SECRET,
  // Gemini API key for Google LLM (from environment variable)
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  // Number of hours to keep session data before cleanup
  SESSION_CLEANUP_HOURS: 24, // How long to keep session data
  // Maximum allowed file upload size (in bytes), here set to 100MB
  MAX_FILE_SIZE: 100 * 1024 * 1024, // 100MB file upload limit
  // Maximum time (in minutes) to wait for Forge translation to complete
  TRANSLATION_TIMEOUT_MINUTES: 30, // Max wait for Forge translation
  // Interval (in milliseconds) between checks for translation status
  TRANSLATION_CHECK_INTERVAL: 10000, // 10 seconds between translation status checks
};

// Ensure all required environment variables are set
const requiredEnvVars = ['FORGE_CLIENT_ID', 'FORGE_CLIENT_SECRET', 'GEMINI_API_KEY'];
// Collect any missing environment variables
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
  // Log an error and exit the process if any required variables are missing
  console.error(`Missing required environment variables: ${missingVars.join(', ')}`);
  process.exit(1);
}
module.exports = CONFIG;
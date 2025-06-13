const ForgeClient = require('../services/forgeService');
const SessionManager = require('../services/sessionService');
const CONFIG = require('../config/config');

/**
 * Controller for handling authentication requests.
 * - Validates the provided session ID.
 * - Checks if the session exists and is not expired.
 * - Generates a new Forge viewer access token (read-only).
 * - Responds with the token and session age.
 *
 * @param {object} req - Express request object (expects req.body.sessionId)
 * @param {object} res - Express response object
 */
const authenticate = async (req, res) => {
   try {
    const { sessionId } = req.body;

    // Validate session ID format (must be alphanumeric, dashes allowed)
    if (!sessionId || !sessionId.match(/^[a-f0-9-]+$/i)) {
      return res.status(400).json({
        error: 'Invalid session ID format',
        code: 'INVALID_SESSION_ID'
      });
    }

    // Retrieve session data using SessionManager
    const session = await SessionManager.getSession(sessionId);

    // If session not found, return 404 error
    if (!session) {
      return res.status(404).json({
        error: 'Session not found',
        code: 'SESSION_NOT_FOUND'
      });
    }

    // Check if session is still valid (not expired)
    const sessionDate = new Date(session.createdAt);
    const hoursDiff = (Date.now() - sessionDate.getTime()) / (1000 * 60 * 60);

    // If session is older than allowed, reject the request
    if (hoursDiff > CONFIG.SESSION_CLEANUP_HOURS) {
      return res.status(403).json({
        error: 'Session too old to generate new token',
        code: 'SESSION_EXPIRED',
        maxAgeHours: CONFIG.SESSION_CLEANUP_HOURS
      });
    }

    // Generate a new viewer token (read-only scope)
    const forgeClient = new ForgeClient(CONFIG.FORGE_CLIENT_ID, CONFIG.FORGE_CLIENT_SECRET);
    const viewerToken = await forgeClient.getAccessToken(null, ['data:read']);

    // Respond with the access token and session age
    res.json({
      accessToken: viewerToken,
      tokenType: 'Bearer',
      expiresIn: 3600, // 1 hour expiration
      sessionAgeHours: hoursDiff.toFixed(2)
    });

  } catch (error) {
    // Log error and respond with 500 Internal Server Error
    console.error('Auth endpoint error:', error.message);
    res.status(500).json({
      error: 'Failed to generate access token',
      details: error.message,
      code: 'AUTH_ERROR'
    });
  }
};

module.exports = { authenticate };
const SessionManager = require('../services/sessionService');

/**
 * Controller function to handle GET requests for session status.
 * Retrieves the status and related information for a given session ID.
 * Responds with session details or appropriate error messages.
 * 
 * @param {object} req - Express request object (expects req.params.sessionId)
 * @param {object} res - Express response object
 */
const getStatus = async (req, res) => {
  try {
    const sessionId = req.params.sessionId;

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

    // Respond with session status and relevant details
    res.json({
      status: session.status,         // Current status of the session (e.g., 'processing', 'completed')
      message: session.message,       // Optional message about the session
      progress: session.progress || 0, // Progress value (default to 0 if not set)
      result: session.result,         // Result data if available
      error: session.error,           // Any error information if present
      createdAt: session.createdAt,   // Timestamp when session was created
      updatedAt: session.updatedAt    // Timestamp when session was last updated
    });
  } catch (error) {
    // Log error and respond with 500 Internal Server Error
    console.error('Status endpoint error:', error.message);
    res.status(500).json({
      error: 'Failed to get session status',
      details: error.message,
      code: 'STATUS_ERROR'
    });
  }
};

module.exports = { getStatus };
// Required imports
const fs = require('fs').promises;
const path = require('path');
const SessionManager = require('../services/sessionService');
const { generateAnimationWithGemini } = require('../services/geminiService');

/**
 * Controller for generating animation commands for a given session.
 * - Validates the session ID and checks if processing is completed.
 * - Loads the model's object hierarchy and properties from disk.
 * - Calls the Gemini LLM service to generate animation commands.
 * - Responds with the generated animation command sequence as JSON.
 *
 * @param {object} req - Express request object (expects req.params.sessionId)
 * @param {object} res - Express response object
 */
const generateAnimation = async (req, res) => {
  try {
    const sessionId = req.params.sessionId;

    // Retrieve session data using SessionManager
    const session = await SessionManager.getSession(sessionId);

    // If session not found, return 404 error
    if (!session) {
      return res.status(404).json({
        error: 'Session not found',
        code: 'SESSION_NOT_FOUND'
      });
    }

    // If session is not completed, return 400 error
    if (session.status !== 'completed') {
      return res.status(400).json({
        error: 'Session processing not completed',
        code: 'SESSION_NOT_READY',
        currentStatus: session.status
      });
    }

    // Construct paths to hierarchy and properties JSON files for this session
    const responsePath = path.join('responses', `session_${sessionId}`);
    const hierarchyPath = path.join(responsePath, '09_object_hierarchy.json');
    const propertiesPath = path.join(responsePath, '10_properties_all_objects.json');

    // Load hierarchy and properties data from disk in parallel
    const [hierarchyData, propertiesData] = await Promise.all([
      fs.readFile(hierarchyPath, 'utf-8').then(JSON.parse),
      fs.readFile(propertiesPath, 'utf-8').then(JSON.parse)
    ]);

    // Generate animation commands using Gemini LLM
    const animationCommands = await generateAnimationWithGemini(hierarchyData, propertiesData);

    // Respond with the generated animation commands as JSON
    res.json(animationCommands);

  } catch (error) {
    // Log error and respond with 500 Internal Server Error
    console.error('Animation generation error:', error.message);
    res.status(500).json({
      error: 'Failed to generate animation',
      details: error.message,
      code: 'ANIMATION_ERROR'
    });
  }
};

module.exports = { generateAnimation };
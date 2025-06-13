// Import Express framework to create the router
const express = require('express');

// Import middleware for handling file uploads (specifically for zip files)
const upload = require('../middleware/uploadMiddleware');

// Import controller for processing uploaded files (main workflow)
const { processUpload } = require('../controllers/processController');

// Import controller for checking the status of a session/process
const { getStatus } = require('../controllers/statusController');

// Import controller for handling authentication requests
const { authenticate } = require('../controllers/authController');

// Import controller for generating animation commands for a session
const { generateAnimation } = require('../controllers/animationController');

// Create a new Express router instance
const router = express.Router();

/**
 * Route: POST /process
 * Description: Handles the upload of a zip file containing model data.
 * Middleware: Uses upload.single('zipfile') to process a single file upload with the field name 'zipfile'.
 * Controller: processUpload handles the main processing logic after upload.
 */
router.post('/process', upload.single('zipfile'), processUpload);

/**
 * Route: GET /status/:sessionId
 * Description: Retrieves the current status of a processing session by session ID.
 * Controller: getStatus returns the status information.
 */
router.get('/status/:sessionId', getStatus);

/**
 * Route: POST /auth
 * Description: Handles authentication requests (e.g., for obtaining tokens).
 * Controller: authenticate processes authentication logic.
 */
router.post('/auth', authenticate);

/**
 * Route: GET /generate-animation/:sessionId
 * Description: Generates animation commands for a given session ID.
 * Controller: generateAnimation triggers the animation generation process.
 */
router.get('/generate-animation/:sessionId', generateAnimation);

// Export the router to be used in the main app
module.exports = router;
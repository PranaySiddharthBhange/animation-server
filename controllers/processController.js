const { v4: uuidv4 } = require('uuid'); // For generating unique session IDs
const AdmZip = require('adm-zip'); // For extracting ZIP files
const fs = require('fs').promises; // Promise-based file system API
const path = require('path'); // Node.js path utilities
const ForgeClient = require('../services/forgeService'); // Service for interacting with Autodesk Forge APIs
const SessionManager = require('../services/sessionService'); // Service for managing session data
const FileUtils = require('../utils/fileUtils'); // Utility functions for file operations
const CONFIG = require('../config/config'); // Application configuration

// Main function to process uploaded files and interact with Forge APIs
async function processFiles(sessionId, folderPath, responsePath) {
  // Create a new ForgeClient instance with credentials from config
  const forgeClient = new ForgeClient(CONFIG.FORGE_CLIENT_ID, CONFIG.FORGE_CLIENT_SECRET);

  try {
    // Step 1: Get Forge access token
    await SessionManager.updateSession(sessionId, {
      status: 'processing',
      message: 'Getting access token',
      progress: 5
    });

    const accessToken = await forgeClient.getAccessToken(responsePath);

    // Step 2: Create a new bucket for this session
    await SessionManager.updateSession(sessionId, {
      message: 'Creating bucket',
      progress: 10
    });

    // Generate a unique bucket key for this session
    const bucketKey = `bucket_${uuidv4().replace(/-/g, '')}`;
    await forgeClient.createBucket(accessToken, bucketKey, responsePath);

    // Step 3: Upload all files to the bucket
    await SessionManager.updateSession(sessionId, {
      message: 'Uploading files',
      progress: 20
    });

    // Upload all files in the extracted folder to Forge, updating progress as files are uploaded
    await forgeClient.uploadAllFiles(accessToken, bucketKey, folderPath, responsePath,
      (msg) => SessionManager.updateSession(sessionId, { message: msg, progress: 25 }));

    // Step 4: Detect the main assembly file (.iam)
    await SessionManager.updateSession(sessionId, {
      message: 'Detecting assembly file',
      progress: 30
    });

    // Look for the main assembly file in the uploaded files
    const assemblyFile = await FileUtils.detectAssemblyFile(folderPath);
    if (!assemblyFile) throw new Error('No assembly (.iam) file found');

    // Step 5: Link references for the assembly (e.g., .ipt files referenced by .iam)
    await SessionManager.updateSession(sessionId, {
      message: 'Linking references',
      progress: 40
    });

    await forgeClient.linkReferences(accessToken, bucketKey, assemblyFile, folderPath, responsePath);

    // Step 6: Start translation job (convert model to SVF2 for viewing)
    await SessionManager.updateSession(sessionId, {
      message: 'Starting translation',
      progress: 50
    });

    const encodedUrn = await forgeClient.startTranslationJob(accessToken, bucketKey, assemblyFile, responsePath);

    // Step 7: Wait for translation to complete (polling status)
    await SessionManager.updateSession(sessionId, {
      message: 'Translating model (this may take several minutes)',
      progress: 60
    });

    await forgeClient.checkTranslationStatus(accessToken, encodedUrn, responsePath,
      (msg) => SessionManager.updateSession(sessionId, { message: msg, progress: 65 }));

    // Step 8: Retrieve metadata (viewable GUID needed for further queries)
    await SessionManager.updateSession(sessionId, {
      message: 'Retrieving metadata',
      progress: 80
    });

    const guidViewable = await forgeClient.getMetadata(accessToken, encodedUrn, responsePath);

    // Step 9: Retrieve object hierarchy (structure of the model)
    await SessionManager.updateSession(sessionId, {
      message: 'Extracting hierarchy',
      progress: 85
    });

    await forgeClient.getObjectHierarchy(accessToken, encodedUrn, guidViewable, responsePath);

    // Step 10: Retrieve all properties for all objects in the model
    await SessionManager.updateSession(sessionId, {
      message: 'Retrieving properties',
      progress: 95
    });

    await forgeClient.getProperties(accessToken, encodedUrn, guidViewable, responsePath);

    // Mark session as completed and store key results
    await SessionManager.updateSession(sessionId, {
      status: 'completed',
      message: 'Processing completed successfully',
      progress: 100,
      result: {
        accessToken,
        encodedUrn,
        bucketKey
      }
    });

  } catch (error) {
    // On error, update session status and log error
    console.error(`Processing failed for session ${sessionId}:`, error.message);
    await SessionManager.updateSession(sessionId, {
      status: 'failed',
      message: error.message,
      error: error.message,
      progress: 0
    });
  } finally {
    // Always clean up uploaded files (remove extracted folder)
    await FileUtils.cleanupPath(folderPath);
  }
}

/**
 * Express controller for handling file upload and starting the processing workflow.
 * - Validates the uploaded ZIP file.
 * - Creates a new session and directories.
 * - Extracts the ZIP file.
 * - Starts background processing (non-blocking).
 * - Responds immediately with the session ID.
 */
const processUpload = async (req, res) => {
  let sessionId = null;
  let zipPath = null;

  try {
    // Validate file presence
    if (!req.file) {
      return res.status(400).json({
        error: 'ZIP file is required',
        code: 'MISSING_FILE'
      });
    }

    zipPath = req.file.path;
    sessionId = uuidv4();

    // Validate ZIP file contents (ensure it's not empty and is a valid ZIP)
    try {
      const zip = new AdmZip(zipPath);
      const entries = zip.getEntries();
      if (entries.length === 0) {
        throw new Error('ZIP file is empty');
      }
    } catch (error) {
      return res.status(400).json({
        error: 'Invalid ZIP file',
        details: error.message,
        code: 'INVALID_ZIP'
      });
    }

    // Create a new session record in the session manager
    await SessionManager.updateSession(sessionId, {
      status: 'queued',
      message: 'Processing queued',
      progress: 0,
      fileName: req.file.originalname
    });

    // Prepare session-specific directories for uploads and responses
    const sessionFolder = `session_${sessionId}`;
    const uploadPath = path.join('uploads', sessionFolder);
    const responsePath = path.join('responses', sessionFolder);

    await fs.mkdir(uploadPath, { recursive: true });
    await fs.mkdir(responsePath, { recursive: true });

    // Extract ZIP file to the upload directory
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(uploadPath, true);

    // Start background processing (non-blocking, does not delay response)
    processFiles(sessionId, uploadPath, responsePath).catch(error => {
      console.error(`Background processing failed for ${sessionId}:`, error.message);
    });

    // Respond immediately with session ID so client can poll for status
    res.json({
      success: true,
      message: 'Processing started',
      sessionId
    });

  } catch (error) {
    console.error('Process endpoint error:', error.message);

    // Update session status if possible
    if (sessionId) {
      await SessionManager.updateSession(sessionId, {
        status: 'failed',
        message: 'Failed to start processing',
        error: error.message
      }).catch(() => { });
    }

    res.status(500).json({
      error: 'Failed to start processing',
      details: error.message,
      code: 'PROCESSING_ERROR'
    });
  } finally {
    // Always clean up the uploaded ZIP file (even on error)
    if (zipPath) {
      await FileUtils.cleanupPath(zipPath);
    }
  }
};

module.exports = { processUpload };
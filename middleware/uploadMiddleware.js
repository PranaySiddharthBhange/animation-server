const multer = require('multer'); // Middleware for handling file uploads
const fs = require('fs').promises; // Promise-based file system API
const { v4: uuidv4 } = require('uuid'); // Library for generating unique IDs
const CONFIG = require('../config/config'); // Import application configuration

// Configure Multer for file uploads (ZIP files only)
const storage = multer.diskStorage({
  /**
   * Determines the destination directory for uploaded files.
   * Ensures the upload directory exists before saving the file.
   * @param {object} req - The Express request object.
   * @param {object} file - The uploaded file object.
   * @param {function} cb - Callback to signal completion.
   */
  destination: async (req, file, cb) => {
    // Define the upload directory path
    const uploadPath = 'uploads/';
    try {
      // Create the directory if it doesn't exist (recursive for nested paths)
      await fs.mkdir(uploadPath, { recursive: true });
      cb(null, uploadPath); // Pass the directory to Multer
    } catch (error) {
      cb(error); // Pass any error to Multer
    }
  },
  /**
   * Generates a unique and sanitized filename for the uploaded file.
   * Combines a timestamp, UUID, and sanitized original filename.
   * @param {object} req - The Express request object.
   * @param {object} file - The uploaded file object.
   * @param {function} cb - Callback to signal completion.
   */
  filename: (req, file, cb) => {
    // Replace any non-alphanumeric, non-dot, non-dash characters with underscores
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    // Create a unique filename using timestamp and UUID
    cb(null, `${Date.now()}-${uuidv4()}-${sanitizedName}`);
  }
});

// Set up Multer middleware with custom storage and file restrictions
const upload = multer({
  storage,
  limits: {
    fileSize: CONFIG.MAX_FILE_SIZE, // Limit the maximum file size (from config)
    files: 1 // Only allow one file per request
  },
  /**
   * File filter to accept only ZIP files.
   * Checks MIME type and file extension.
   * @param {object} req - The Express request object.
   * @param {object} file - The uploaded file object.
   * @param {function} cb - Callback to signal acceptance or rejection.
   */
  fileFilter: (req, file, cb) => {
    // Accept only files with MIME type 'application/zip' or '.zip' extension
    if (file.mimetype === 'application/zip' || file.originalname.toLowerCase().endsWith('.zip')) {
      cb(null, true); // Accept the file
    } else {
      cb(new Error('Only ZIP files are allowed')); // Reject the file
    }
  }
});

module.exports =  upload;
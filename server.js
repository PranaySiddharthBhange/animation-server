const express = require('express');
const cors = require('cors');
const multer = require('multer');
const AdmZip = require('adm-zip');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Configuration
const CONFIG = {
  FORGE_CLIENT_ID: process.env.FORGE_CLIENT_ID,
  FORGE_CLIENT_SECRET: process.env.FORGE_CLIENT_SECRET,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  SESSION_CLEANUP_HOURS: 24,
  MAX_FILE_SIZE: 100 * 1024 * 1024, // 100MB
  TRANSLATION_TIMEOUT_MINUTES: 30,
  TRANSLATION_CHECK_INTERVAL: 10000, // 10 seconds
};

// Validate required environment variables
const requiredEnvVars = ['FORGE_CLIENT_ID', 'FORGE_CLIENT_SECRET', 'GEMINI_API_KEY'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
  console.error(`Missing required environment variables: ${missingVars.join(', ')}`);
  process.exit(1);
}

// Enhanced storage configuration with file size limits
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadPath = 'uploads/';
    try {
      await fs.mkdir(uploadPath, { recursive: true });
      cb(null, uploadPath);
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, `${Date.now()}-${uuidv4()}-${sanitizedName}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: CONFIG.MAX_FILE_SIZE,
    files: 1
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/zip' || file.originalname.toLowerCase().endsWith('.zip')) {
      cb(null, true);
    } else {
      cb(new Error('Only ZIP files are allowed'));
    }
  }
});

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cors());

// Create necessary directories on startup
const initializeDirectories = async () => {
  const dirs = ['uploads', 'responses'];
  for (const dir of dirs) {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      console.error(`Failed to create directory ${dir}:`, error.message);
    }
  }
};

// Enhanced session management with error handling
class SessionManager {
  static async getSession(sessionId) {
    try {
      const sessionPath = path.join('responses', `session_${sessionId}`, 'session.json');
      const data = await fs.readFile(sessionPath, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error(`Error reading session ${sessionId}:`, error.message);
      }
      return null;
    }
  }

  static async updateSession(sessionId, update) {
    const sessionFolder = path.join('responses', `session_${sessionId}`);
    const sessionPath = path.join(sessionFolder, 'session.json');

    try {
      let session = { createdAt: new Date().toISOString() };

      try {
        const existingData = await fs.readFile(sessionPath, 'utf-8');
        session = JSON.parse(existingData);
      } catch (error) {
        // File doesn't exist, use default session
      }

      const updatedSession = {
        ...session,
        ...update,
        updatedAt: new Date().toISOString()
      };

      await fs.mkdir(sessionFolder, { recursive: true });
      await fs.writeFile(sessionPath, JSON.stringify(updatedSession, null, 2));

      return updatedSession;
    } catch (error) {
      console.error(`Error updating session ${sessionId}:`, error.message);
      throw error;
    }
  }

  static async cleanupOldSessions() {
    try {
      const responsesDir = 'responses';
      const entries = await fs.readdir(responsesDir, { withFileTypes: true });
      const cutoffTime = Date.now() - (CONFIG.SESSION_CLEANUP_HOURS * 60 * 60 * 1000);
      let cleanedCount = 0;

      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('session_')) {
          const sessionPath = path.join(responsesDir, entry.name);
          const sessionFile = path.join(sessionPath, 'session.json');

          try {
            const stats = await fs.stat(sessionFile);
            if (stats.mtime.getTime() < cutoffTime) {
              await fs.rm(sessionPath, { recursive: true, force: true });
              cleanedCount++;
              console.log(`Cleaned up old session: ${entry.name}`);
            }
          } catch (error) {
            // Session folder might be incomplete, clean it up anyway
            try {
              await fs.rm(sessionPath, { recursive: true, force: true });
              cleanedCount++;
            } catch (cleanupError) {
              console.error(`Failed to cleanup ${entry.name}:`, cleanupError.message);
            }
          }
        }
      }

      if (cleanedCount > 0) {
        console.log(`Cleaned up ${cleanedCount} old sessions`);
      }
    } catch (error) {
      console.error('Error during session cleanup:', error.message);
    }
  }
}

// Enhanced file utilities
class FileUtils {
  static async saveResponseToFile(responsePath, stepName, data) {
    // Only save essential data, not full responses
    const essentialData = this.extractEssentialData(stepName, data);
    const filePath = path.join(responsePath, `${stepName}.json`);
    await fs.writeFile(filePath, JSON.stringify(essentialData, null, 2));
  }

  static extractEssentialData(stepName, data) {
    switch (stepName) {
      case '01_get_access_token':
        return {
          access_token: data.access_token,
          expires_in: data.expires_in,
          token_type: data.token_type
        };
      case '06_start_translation_job':
        return {
          result: data.result,
          urn: data.urn,
          acceptedJobs: data.acceptedJobs
        };
      case '08_metadata':
        return {
          data: {
            type: data.data?.type,
            metadata: data.data?.metadata?.map(m => ({
              guid: m.guid,
              name: m.name,
              role: m.role
            }))
          }
        };
      case '09_object_hierarchy':
        return data; // Keep full hierarchy for animation
      case '10_properties_all_objects':
        return data; // Keep full properties for animation
      default:
        return { status: 'completed', timestamp: new Date().toISOString() };
    }
  }

  static async detectAssemblyFile(folderPath) {
    try {
      const files = await fs.readdir(folderPath, { recursive: true });
      for (const file of files) {
        if (typeof file === 'string' && file.toLowerCase().endsWith('.iam')) {
          return file;
        }
      }
      return null;
    } catch (error) {
      console.error('Error detecting assembly file:', error.message);
      return null;
    }
  }

  static async cleanupPath(filePath) {
    try {
      await fs.rm(filePath, { recursive: true, force: true });
    } catch (error) {
      console.error(`Cleanup failed for ${filePath}:`, error.message);
    }
  }
}

// Enhanced Forge API client with better error handling
class ForgeClient {
  constructor(clientId, clientSecret) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.baseURL = 'https://developer.api.autodesk.com';
  }

  async getAccessToken(responsePath) {
    const credentials = `${this.clientId}:${this.clientSecret}`;
    const encodedCredentials = Buffer.from(credentials).toString('base64');

    try {
      const response = await axios.post(
        `${this.baseURL}/authentication/v2/token`,
        new URLSearchParams({
          grant_type: 'client_credentials',
          scope: 'data:write data:read bucket:create bucket:delete'
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
            'Authorization': `Basic ${encodedCredentials}`
          },
          timeout: 30000
        }
      );

      await FileUtils.saveResponseToFile(responsePath, '01_get_access_token', response.data);
      return response.data.access_token;
    } catch (error) {
      const message = error.response?.data?.error_description || error.message;
      throw new Error(`Access token error: ${message}`);
    }
  }

  async createBucket(accessToken, bucketKey, responsePath) {
    try {
      const response = await axios.post(
        `${this.baseURL}/oss/v2/buckets`,
        {
          bucketKey,
          policyKey: 'transient',
          access: 'full'
        },
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

      await FileUtils.saveResponseToFile(responsePath, '02_create_bucket', { success: true });
      return true;
    } catch (error) {
      if (error.response?.status === 409) {
        // Bucket already exists
        await FileUtils.saveResponseToFile(responsePath, '02_create_bucket', { success: true, existed: true });
        return true;
      }
      const message = error.response?.data?.reason || error.message;
      throw new Error(`Bucket creation failed: ${message}`);
    }
  }

  async uploadAllFiles(accessToken, bucketKey, folderPath, responsePath, updateProgress) {
    const files = [];

    const walkDir = async (dir) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walkDir(fullPath);
        } else {
          files.push({
            name: entry.name,
            path: fullPath,
            relative: path.relative(folderPath, fullPath)
          });
        }
      }
    };

    await walkDir(folderPath);
    let uploadedCount = 0;

    for (const file of files) {
      try {
        await this.uploadSingleFile(accessToken, bucketKey, file, responsePath);
        uploadedCount++;
        if (updateProgress) {
          updateProgress(`Uploaded ${uploadedCount}/${files.length} files`);
        }
      } catch (error) {
        console.error(`Error uploading ${file.name}:`, error.message);
        throw error; // Stop on first upload failure
      }
    }
  }

  async uploadSingleFile(accessToken, bucketKey, file, responsePath) {
    // Get signed URL
    const encodedFileName = encodeURIComponent(file.name);
    const signedUrlResponse = await axios.get(
      `${this.baseURL}/oss/v2/buckets/${bucketKey}/objects/${encodedFileName}/signeds3upload?minutesExpiration=60`,
      {
        headers: { 'Authorization': `Bearer ${accessToken}` },
        timeout: 30000
      }
    );

    const { urls: [signedUrl], uploadKey } = signedUrlResponse.data;

    // Upload to S3
    const fileData = await fs.readFile(file.path);
    await axios.put(signedUrl, fileData, {
      headers: { 'Content-Type': 'application/octet-stream' },
      timeout: 120000 // 2 minutes for file upload
    });

    // Finalize upload
    await axios.post(
      `${this.baseURL}/oss/v2/buckets/${bucketKey}/objects/${file.name}/signeds3upload`,
      {
        ossbucketKey: bucketKey,
        ossSourceFileObjectKey: file.name,
        access: 'full',
        uploadKey
      },
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );
  }

  async linkReferences(accessToken, bucketKey, assemblyFile, folderPath, responsePath) {
    try {
      const assemblyUrn = `urn:adsk.objects:os.object:${bucketKey}/${assemblyFile}`;
      const encodedUrn = this.base64EncodeUrn(assemblyUrn);

      const references = [];
      const files = await fs.readdir(folderPath, { recursive: true });

      for (const file of files) {
        if (typeof file === 'string' && file.toLowerCase().endsWith('.ipt')) {
          const relPath = path.relative(folderPath, path.join(folderPath, file)).replace(/\\/g, '/');
          references.push({
            urn: `urn:adsk.objects:os.object:${bucketKey}/${path.basename(file)}`,
            relativePath: relPath,
            filename: path.basename(file)
          });
        }
      }

      await axios.post(
        `${this.baseURL}/modelderivative/v2/designdata/${encodedUrn}/references`,
        {
          urn: assemblyUrn,
          filename: assemblyFile,
          references
        },
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          timeout: 60000
        }
      );

      await FileUtils.saveResponseToFile(responsePath, '05_link_references', { success: true, referencesCount: references.length });
      return true;
    } catch (error) {
      const message = error.response?.data?.errorMessage || error.message;
      throw new Error(`Link references failed: ${message}`);
    }
  }

  async startTranslationJob(accessToken, bucketKey, assemblyFile, responsePath) {
    try {
      const assemblyUrn = `urn:adsk.objects:os.object:${bucketKey}/${assemblyFile}`;
      const encodedUrn = this.base64EncodeUrn(assemblyUrn);

      const response = await axios.post(
        `${this.baseURL}/modelderivative/v2/designdata/job`,
        {
          input: {
            urn: encodedUrn,
            checkReferences: true
          },
          output: {
            formats: [
              {
                type: "svf2",
                views: ["2d", "3d"]
              }
            ]
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'x-ads-force': 'true'
          },
          timeout: 60000
        }
      );

      await FileUtils.saveResponseToFile(responsePath, '06_start_translation_job', response.data);
      return encodedUrn;
    } catch (error) {
      const message = error.response?.data?.errorMessage || error.message;
      throw new Error(`Translation job failed: ${message}`);
    }
  }

  async checkTranslationStatus(accessToken, encodedUrn, responsePath, updateProgress) {
    const maxAttempts = Math.floor((CONFIG.TRANSLATION_TIMEOUT_MINUTES * 60 * 1000) / CONFIG.TRANSLATION_CHECK_INTERVAL);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await axios.get(
          `${this.baseURL}/modelderivative/v2/designdata/${encodedUrn}/manifest`,
          {
            headers: { 'Authorization': `Bearer ${accessToken}` },
            timeout: 30000
          }
        );

        const status = response.data.status;
        const progress = response.data.progress || '0%';

        if (updateProgress) {
          updateProgress(`Translation ${status} - ${progress}`);
        }

        if (status === 'success') {
          await FileUtils.saveResponseToFile(responsePath, '07_translation_status', { status, progress });
          return true;
        }

        if (status === 'failed' || status === 'timeout') {
          const errorMsg = response.data.messages?.map(m => m.message).join('; ') || `Translation ${status}`;
          throw new Error(errorMsg);
        }

        await new Promise(resolve => setTimeout(resolve, CONFIG.TRANSLATION_CHECK_INTERVAL));
      } catch (error) {
        if (error.response?.status === 404 && attempt < 3) {
          // Manifest might not be ready yet, wait a bit more
          await new Promise(resolve => setTimeout(resolve, CONFIG.TRANSLATION_CHECK_INTERVAL));
          continue;
        }
        throw error;
      }
    }

    throw new Error(`Translation timeout after ${CONFIG.TRANSLATION_TIMEOUT_MINUTES} minutes`);
  }

  async getMetadata(accessToken, encodedUrn, responsePath) {
    try {
      const response = await axios.get(
        `${this.baseURL}/modelderivative/v2/designdata/${encodedUrn}/metadata`,
        {
          headers: { 'Authorization': `Bearer ${accessToken}` },
          timeout: 30000
        }
      );

      await FileUtils.saveResponseToFile(responsePath, '08_metadata', response.data);

      if (response.data.data?.metadata?.length > 0) {
        return response.data.data.metadata[0].guid;
      }

      throw new Error('No viewable files found');
    } catch (error) {
      const message = error.response?.data?.errorMessage || error.message;
      throw new Error(`Metadata retrieval failed: ${message}`);
    }
  }

  async getObjectHierarchy(accessToken, encodedUrn, guidViewable, responsePath) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const response = await axios.get(
          `${this.baseURL}/modelderivative/v2/designdata/${encodedUrn}/metadata/${guidViewable}`,
          {
            headers: { 'Authorization': `Bearer ${accessToken}` },
            timeout: 30000
          }
        );

        if (response.data.data) {
          await FileUtils.saveResponseToFile(responsePath, '09_object_hierarchy', response.data);
          return response.data;
        }

        await new Promise(resolve => setTimeout(resolve, 5000));
      } catch (error) {
        if (attempt === 4) {
          const message = error.response?.data?.errorMessage || error.message;
          throw new Error(`Object hierarchy failed: ${message}`);
        }
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }

  async getProperties(accessToken, encodedUrn, guidViewable, responsePath) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const response = await axios.get(
          `${this.baseURL}/modelderivative/v2/designdata/${encodedUrn}/metadata/${guidViewable}/properties`,
          {
            headers: { 'Authorization': `Bearer ${accessToken}` },
            timeout: 30000
          }
        );

        if (response.data.data) {
          await FileUtils.saveResponseToFile(responsePath, '10_properties_all_objects', response.data);
          return response.data;
        }

        await new Promise(resolve => setTimeout(resolve, 5000));
      } catch (error) {
        if (attempt === 4) {
          const message = error.response?.data?.errorMessage || error.message;
          throw new Error(`Properties retrieval failed: ${message}`);
        }
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }

  base64EncodeUrn(urn) {
    return Buffer.from(urn).toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  }
}

// Enhanced main processing function
async function processFiles(sessionId, folderPath, responsePath) {
  const forgeClient = new ForgeClient(CONFIG.FORGE_CLIENT_ID, CONFIG.FORGE_CLIENT_SECRET);

  try {
    await SessionManager.updateSession(sessionId, {
      status: 'processing',
      message: 'Getting access token',
      progress: 5
    });

    const accessToken = await forgeClient.getAccessToken(responsePath);

    await SessionManager.updateSession(sessionId, {
      message: 'Creating bucket',
      progress: 10
    });

    const bucketKey = `bucket_${uuidv4().replace(/-/g, '')}`;
    await forgeClient.createBucket(accessToken, bucketKey, responsePath);

    await SessionManager.updateSession(sessionId, {
      message: 'Uploading files',
      progress: 20
    });

    await forgeClient.uploadAllFiles(accessToken, bucketKey, folderPath, responsePath,
      (msg) => SessionManager.updateSession(sessionId, { message: msg, progress: 25 }));

    await SessionManager.updateSession(sessionId, {
      message: 'Detecting assembly file',
      progress: 30
    });

    const assemblyFile = await FileUtils.detectAssemblyFile(folderPath);
    if (!assemblyFile) throw new Error('No assembly (.iam) file found');

    await SessionManager.updateSession(sessionId, {
      message: 'Linking references',
      progress: 40
    });

    await forgeClient.linkReferences(accessToken, bucketKey, assemblyFile, folderPath, responsePath);

    await SessionManager.updateSession(sessionId, {
      message: 'Starting translation',
      progress: 50
    });

    const encodedUrn = await forgeClient.startTranslationJob(accessToken, bucketKey, assemblyFile, responsePath);

    await SessionManager.updateSession(sessionId, {
      message: 'Translating model (this may take several minutes)',
      progress: 60
    });

    await forgeClient.checkTranslationStatus(accessToken, encodedUrn, responsePath,
      (msg) => SessionManager.updateSession(sessionId, { message: msg, progress: 65 }));

    await SessionManager.updateSession(sessionId, {
      message: 'Retrieving metadata',
      progress: 80
    });

    const guidViewable = await forgeClient.getMetadata(accessToken, encodedUrn, responsePath);

    await SessionManager.updateSession(sessionId, {
      message: 'Extracting hierarchy',
      progress: 85
    });

    await forgeClient.getObjectHierarchy(accessToken, encodedUrn, guidViewable, responsePath);

    await SessionManager.updateSession(sessionId, {
      message: 'Retrieving properties',
      progress: 95
    });

    await forgeClient.getProperties(accessToken, encodedUrn, guidViewable, responsePath);

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
    console.error(`Processing failed for session ${sessionId}:`, error.message);
    await SessionManager.updateSession(sessionId, {
      status: 'failed',
      message: error.message,
      error: error.message,
      progress: 0
    });
  } finally {
    // Clean up uploaded files
    await FileUtils.cleanupPath(folderPath);
  }
}

// Routes with enhanced error handling
app.post('/process', upload.single('zipfile'), async (req, res) => {
  let sessionId = null;
  let zipPath = null;

  try {
    if (!req.file) {
      return res.status(400).json({
        error: 'ZIP file is required',
        code: 'MISSING_FILE'
      });
    }

    zipPath = req.file.path;
    sessionId = uuidv4();

    // Validate ZIP file
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

    // Create session
    await SessionManager.updateSession(sessionId, {
      status: 'queued',
      message: 'Processing queued',
      progress: 0,
      fileName: req.file.originalname
    });

    // Setup directories
    const sessionFolder = `session_${sessionId}`;
    const uploadPath = path.join('uploads', sessionFolder);
    const responsePath = path.join('responses', sessionFolder);

    await fs.mkdir(uploadPath, { recursive: true });
    await fs.mkdir(responsePath, { recursive: true });

    // Extract ZIP
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(uploadPath, true);

    // Start background processing
    processFiles(sessionId, uploadPath, responsePath).catch(error => {
      console.error(`Background processing failed for ${sessionId}:`, error.message);
    });

    res.json({
      success: true,
      message: 'Processing started',
      sessionId
    });

  } catch (error) {
    console.error('Process endpoint error:', error.message);

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
    // Clean up uploaded ZIP file
    if (zipPath) {
      await FileUtils.cleanupPath(zipPath);
    }
  }
});

app.get('/status/:sessionId', async (req, res) => {
  try {
    const sessionId = req.params.sessionId;

    if (!sessionId || !sessionId.match(/^[a-f0-9-]+$/i)) {
      return res.status(400).json({
        error: 'Invalid session ID format',
        code: 'INVALID_SESSION_ID'
      });
    }

    const session = await SessionManager.getSession(sessionId);

    if (!session) {
      return res.status(404).json({
        error: 'Session not found',
        code: 'SESSION_NOT_FOUND'
      });
    }

    res.json({
      status: session.status,
      message: session.message,
      progress: session.progress || 0,
      result: session.result,
      error: session.error,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt
    });
  } catch (error) {
    console.error('Status endpoint error:', error.message);
    res.status(500).json({
      error: 'Failed to get session status',
      details: error.message,
      code: 'STATUS_ERROR'
    });
  }
});

app.get('/generate-animation/:sessionId', async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const session = await SessionManager.getSession(sessionId);

    if (!session) {
      return res.status(404).json({
        error: 'Session not found',
        code: 'SESSION_NOT_FOUND'
      });
    }

    if (session.status !== 'completed') {
      return res.status(400).json({
        error: 'Session processing not completed',
        code: 'SESSION_NOT_READY',
        currentStatus: session.status
      });
    }

    const responsePath = path.join('responses', `session_${sessionId}`);
    const hierarchyPath = path.join(responsePath, '09_object_hierarchy.json');
    const propertiesPath = path.join(responsePath, '10_properties_all_objects.json');

    const [hierarchyData, propertiesData] = await Promise.all([
      fs.readFile(hierarchyPath, 'utf-8').then(JSON.parse),
      fs.readFile(propertiesPath, 'utf-8').then(JSON.parse)
    ]);

    // Generate animation using Gemini
    const animationCommands = await generateAnimationWithGemini(hierarchyData, propertiesData);

    res.json(animationCommands);

  } catch (error) {
    console.error('Animation generation error:', error.message);
    res.status(500).json({
      error: 'Failed to generate animation',
      details: error.message,
      code: 'ANIMATION_ERROR'
    });
  }
});

async function generateAnimationWithGemini(hierarchyData, propertiesData) {
  // Describe hierarchy
  function describeHierarchy(node, level = 0) {
    let description = '  '.repeat(level) + `- ${node.name} (ID: ${node.objectid})\n`;
    if (node.objects) {
      node.objects.forEach(child => {
        description += describeHierarchy(child, level + 1);
      });
    }
    return description;
  }

  let hierarchyDescription = "Model Hierarchy:\n";
  hierarchyData.data.objects.forEach(root => {
    hierarchyDescription += describeHierarchy(root);
  });

  // Describe properties
  let propertiesDescription = "Key Properties:\n";
  propertiesData.data.collection.forEach(item => {
    propertiesDescription += `- ${item.name} (ID: ${item.objectid}):\n`;
    for (const [category, props] of Object.entries(item.properties)) {
      if (typeof props === 'object') {
        propertiesDescription += `  • ${category}:\n`;
        for (const [key, value] of Object.entries(props)) {
          propertiesDescription += `    ◦ ${key}: ${value}\n`;
        }
      } else {
        propertiesDescription += `  • ${category}: ${props}\n`;
      }
    }
  });

  const prompt = `
You are an expert 3D animation assistant for Autodesk Forge models. 
Generate a sequence of animation commands for the following fragments that will create a logical, visually appealing animation of disassembly.

${hierarchyDescription}

${propertiesDescription}

Command format (JSON array of objects):
[
  {
    "fragmentId": <number>,
    "action": "rotate" | "scale" | "translate",
    "params": {
      // For "rotate": "axis" ("x","y","z"), "angle": <degrees>
      // For "scale": "factor": <number>
      // For "translate": "x": <number>, "y": <number>, "z": <number>
    }
  }
]

Guidelines:
1. Create an disassembly view showing assembly relationships
2. Move parts along logical axes based on their position in the assembly
3. Rotate rotating components (shaft, rotor, screws) to show movements of disassembly
4. Scale small parts to make them more visible
5. Use reasonable translations depending on part size for disassembly
6. Include 8-12 commands for a comprehensive animation at the end assembly should disassemble completely and then reassemble
7. Prioritize moving outer components first then inner ones
8. Consider mechanical relationships between parts
9. Also add rotation for parts that have rotational movement

Generate only the JSON array with no additional text.
`.trim();

  try {
    const response = await axios.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + CONFIG.GEMINI_API_KEY,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 1000
        }
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000
      }
    );

    let text = response.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";

    // Clean code blocks
    if (text.startsWith("```json")) text = text.replace(/^```json/, "").replace(/```$/, "").trim();
    else if (text.startsWith("```")) text = text.replace(/^```/, "").replace(/```$/, "").trim();

    // Try to parse JSON
    try {
      return JSON.parse(text);
    } catch (parseError) {
      console.error("JSON parse failed:", parseError.message);
      throw new Error(`Invalid JSON from Gemini: ${text.substring(0, 100)}...`);
    }
  } catch (error) {
    console.error("Gemini API error:", error.message);
    throw new Error(`Animation generation failed: ${error.response?.data?.error?.message || error.message}`);
  }
}
// Start the server and initialize directories
app.listen(port, async () => {
  console.log(`Server running on http://localhost:${port}`);
  await initializeDirectories();
  console.log('Directories initialized');

  // Start session cleanup interval
  setInterval(() => {
    SessionManager.cleanupOldSessions().catch(error => {
      console.error('Session cleanup error:', error.message);
    });
  }, CONFIG.SESSION_CLEANUP_HOURS * 60 * 60 * 1000); // Cleanup every SESSION_CLEANUP_HOURS
});

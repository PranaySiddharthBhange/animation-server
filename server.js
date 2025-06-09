const express = require('express');
const cors = require('cors');
const multer = require('multer');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const FormData = require('form-data');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

const FORGE_CLIENT_ID = process.env.FORGE_CLIENT_ID;
const FORGE_CLIENT_SECRET = process.env.FORGE_CLIENT_SECRET;

// Configure storage for uploaded ZIP files
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = 'uploads/';
    fs.mkdirSync(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    cb(null, `${uuidv4()}-${file.originalname}`);
  }
});

const upload = multer({ storage });

// Create necessary directories
['uploads', 'responses'].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// Session management functions
function getSession(sessionId) {
  try {
    const sessionPath = path.join('responses', `session_${sessionId}`, 'session.json');
    if (fs.existsSync(sessionPath)) {
      return JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
    }
    return null;
  } catch (error) {
    console.error(`Error reading session ${sessionId}:`, error);
    return null;
  }
}

function updateSession(sessionId, update) {
  const sessionFolder = path.join('responses', `session_${sessionId}`);
  const sessionPath = path.join(sessionFolder, 'session.json');
  
  try {
    let session = {};
    if (fs.existsSync(sessionPath)) {
      session = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
    }
    
    const updatedSession = {...session, ...update};
    fs.mkdirSync(sessionFolder, { recursive: true });
    fs.writeFileSync(sessionPath, JSON.stringify(updatedSession, null, 2));
    
    return updatedSession;
  } catch (error) {
    console.error(`Error updating session ${sessionId}:`, error);
    return null;
  }
}

// Endpoint to handle processing requests
app.post('/process', upload.single('zipfile'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'ZIP file is required' });
    }

    const zipPath = req.file.path;
    const sessionId = uuidv4();

    // Create session entry
    updateSession(sessionId, {
      status: 'queued',
      message: 'Processing started',
      progress: 0
    });

    // Create session directories
    const sessionFolder = `session_${sessionId}`;
    const uploadPath = path.join('uploads', sessionFolder);
    const responsePath = path.join('responses', sessionFolder);
    fs.mkdirSync(uploadPath, { recursive: true });
    fs.mkdirSync(responsePath, { recursive: true });

    // Unzip files
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(uploadPath, true);

    // Start background processing
    processFiles(sessionId, uploadPath, responsePath);

    res.json({
      success: true,
      message: 'Processing started',
      sessionId
    });
  } catch (error) {
    res.status(500).json({ 
      error: error.message,
      details: error.stack 
    });
  } finally {
    // Clean up uploaded ZIP file
    if (req.file) fs.unlink(req.file.path, () => {});
  }
});

// Session status endpoint
app.get('/status/:sessionId', (req, res) => {
  const sessionId = req.params.sessionId;
  const session = getSession(sessionId);
  
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  res.json({
    status: session.status,
    message: session.message,
    progress: session.progress,
    result: session.result,
    error: session.error
  });
});

app.get('/generate-animation/:sessionId', async (req, res) => {
  const sessionId = req.params.sessionId;
  const session = getSession(sessionId);
  
  if (!session) {
    return res.status(400).json({ error: 'Invalid or missing sessionId' });
  }

  const responsePath = path.join('responses', `session_${sessionId}`);
  const hierarchyPath = path.join(responsePath, '09_object_hierarchy.json');
  const propertiesPath = path.join(responsePath, '10_properties_all_objects.json');

  try {
    const hierarchyData = JSON.parse(fs.readFileSync(hierarchyPath, 'utf-8'));
    const propertiesData = JSON.parse(fs.readFileSync(propertiesPath, 'utf-8'));

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
6. Include 20-30 commands for a comprehensive animation at the end assembly should disassemble completely and then reassemble
7. Prioritize moving outer components first then inner ones
8. Consider mechanical relationships between parts

Generate only the JSON array with no additional text.
`.trim();

    const geminiRes = await axios.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + process.env.GEMINI_API_KEY,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 1000
        }
      },
      {
        headers: { 'Content-Type': 'application/json' }
      }
    );

    let text = geminiRes.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";

    // Clean code blocks
    if (text.startsWith("```json")) text = text.replace(/^```json/, "").replace(/```$/, "").trim();
    else if (text.startsWith("```")) text = text.replace(/^```/, "").replace(/```$/, "").trim();

    // Log raw text for debugging
    console.log("Gemini raw response:", text);

    // Try to parse JSON
    let commands;
    try {
      commands = JSON.parse(text);
    } catch (parseError) {
      console.error("JSON parse failed:", parseError.message);
      return res.status(500).json({ error: "Gemini returned invalid JSON", rawText: text });
    }

    return res.json(commands);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to generate animation", details: err.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).send('Server is healthy');
});

// Helper function to save API responses
function saveResponseToFile(responsePath, stepName, data) {
  const filePath = path.join(responsePath, `${stepName}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// Base64 encode URN helper
function base64EncodeUrn(urn) {
  return Buffer.from(urn).toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

// Forge API functions
async function getAccessToken(responsePath) {
  const credentials = `${FORGE_CLIENT_ID}:${FORGE_CLIENT_SECRET}`;
  const encodedCredentials = Buffer.from(credentials).toString('base64');
  
  try {
    const response = await axios.post(
      'https://developer.api.autodesk.com/authentication/v2/token',
      new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'data:write data:read bucket:create bucket:delete'
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
          'Authorization': `Basic ${encodedCredentials}`
        }
      }
    );

    saveResponseToFile(responsePath, '01_get_access_token', response.data);
    return response.data.access_token;
  } catch (error) {
    throw new Error(`Access token error: ${error.response?.data || error.message}`);
  }
}

async function createBucket(accessToken, bucketKey, responsePath) {
  try {
    const response = await axios.post(
      'https://developer.api.autodesk.com/oss/v2/buckets',
      {
        bucketKey,
        policyKey: 'transient',
        access: 'full'
      },
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    saveResponseToFile(responsePath, '02_create_bucket', response.data);
    return true;
  } catch (error) {
    if (error.response?.status === 409) {
      return true;
    }
    throw new Error(`Bucket creation failed: ${error.response?.data || error.message}`);
  }
}

async function getSignedUrl(accessToken, bucketKey, fileName, responsePath) {
  try {
    const encodedFileName = encodeURIComponent(fileName);
    const url = `https://developer.api.autodesk.com/oss/v2/buckets/${bucketKey}/objects/${encodedFileName}/signeds3upload?minutesExpiration=60`;
    
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    saveResponseToFile(responsePath, `03_get_signed_url_${fileName}`, response.data);
    return {
      signedUrl: response.data.urls[0],
      uploadKey: response.data.uploadKey
    };
  } catch (error) {
    throw new Error(`Signed URL failed for ${fileName}: ${error.response?.data || error.message}`);
  }
}

async function uploadFileToS3(signedUrl, filePath) {
  try {
    const fileData = fs.readFileSync(filePath);
    const response = await axios.put(signedUrl, fileData, {
      headers: {
        'Content-Type': 'application/octet-stream'
      }
    });
    return response.status === 200;
  } catch (error) {
    throw new Error(`S3 upload failed for ${filePath}: ${error.message}`);
  }
}

async function finalizeUpload(accessToken, bucketKey, fileName, uploadKey, responsePath) {
  try {
    const url = `https://developer.api.autodesk.com/oss/v2/buckets/${bucketKey}/objects/${fileName}/signeds3upload`;
    
    const response = await axios.post(
      url,
      {
        ossbucketKey: bucketKey,
        ossSourceFileObjectKey: fileName,
        access: 'full',
        uploadKey
      },
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    saveResponseToFile(responsePath, `04_finalize_upload_${fileName}`, response.data);
    return true;
  } catch (error) {
    throw new Error(`Finalize upload failed for ${fileName}: ${error.response?.data || error.message}`);
  }
}

async function uploadAllFiles(accessToken, bucketKey, folderPath, responsePath) {
  const files = [];
  
  function walkDir(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else {
        files.push({
          name: entry.name,
          path: fullPath,
          relative: path.relative(folderPath, fullPath)
        });
      }
    }
  }

  walkDir(folderPath);

  for (const file of files) {
    try {
      const { signedUrl, uploadKey } = await getSignedUrl(
        accessToken, 
        bucketKey, 
        file.name, 
        responsePath
      );
      
      await uploadFileToS3(signedUrl, file.path);
      await finalizeUpload(
        accessToken, 
        bucketKey, 
        file.name, 
        uploadKey, 
        responsePath
      );
    } catch (error) {
      console.error(`Error uploading ${file.name}:`, error.message);
    }
  }
}

function detectAssemblyFile(folderPath) {
  const files = fs.readdirSync(folderPath, { recursive: true });
  for (const file of files) {
    if (typeof file === 'string' && file.toLowerCase().endsWith('.iam')) {
      return file;
    }
  }
  return null;
}

async function linkReferences(accessToken, bucketKey, assemblyFile, folderPath, responsePath) {
  try {
    const assemblyUrn = `urn:adsk.objects:os.object:${bucketKey}/${assemblyFile}`;
    const encodedUrn = base64EncodeUrn(assemblyUrn);
    
    const references = [];
    const files = fs.readdirSync(folderPath, { recursive: true });
    
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

    const url = `https://developer.api.autodesk.com/modelderivative/v2/designdata/${encodedUrn}/references`;
    
    const response = await axios.post(
      url,
      {
        urn: assemblyUrn,
        filename: assemblyFile,
        references
      },
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    saveResponseToFile(responsePath, '05_link_references', response.data);
    return true;
  } catch (error) {
    throw new Error(`Link references failed: ${error.response?.data || error.message}`);
  }
}

async function startTranslationJob(accessToken, bucketKey, assemblyFile, responsePath) {
  try {
    const assemblyUrn = `urn:adsk.objects:os.object:${bucketKey}/${assemblyFile}`;
    const encodedUrn = base64EncodeUrn(assemblyUrn);
    
    const url = "https://developer.api.autodesk.com/modelderivative/v2/designdata/job";
    
    const response = await axios.post(
      url,
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
        }
      }
    );

    saveResponseToFile(responsePath, '06_start_translation_job', response.data);
    return encodedUrn;
  } catch (error) {
    throw new Error(`Translation job failed: ${error.response?.data || error.message}`);
  }
}

async function checkTranslationStatus(accessToken, encodedUrn, responsePath) {
  try {
    const url = `https://developer.api.autodesk.com/modelderivative/v2/designdata/${encodedUrn}/manifest`;
    
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await axios.get(url, {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      });
      
      saveResponseToFile(responsePath, `07_translation_status`, response.data);
      
      const status = response.data.status;
      if (status === 'success') return true;
      if (status === 'failed' || status === 'timeout') {
        throw new Error(`Translation ${status}`);
      }
      
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    throw new Error('Translation timeout after 10 minutes');
  } catch (error) {
    throw new Error(`Translation status check failed: ${error.message}`);
  }
}

async function retrieveListOfViewableFiles(accessToken, encodedUrn, responsePath) {
  try {
    const url = `https://developer.api.autodesk.com/modelderivative/v2/designdata/${encodedUrn}/metadata`;
    
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });
    
    saveResponseToFile(responsePath, '08_metadata', response.data);
    
    if (response.data.data?.metadata?.length > 0) {
      return response.data.data.metadata[0].guid;
    }
    
    throw new Error('No viewable files found');
  } catch (error) {
    throw new Error(`Viewable files retrieval failed: ${error.response?.data || error.message}`);
  }
}

async function getObjectHierarchy(accessToken, encodedUrn, guidViewable, responsePath) {
  try {
    const url = `https://developer.api.autodesk.com/modelderivative/v2/designdata/${encodedUrn}/metadata/${guidViewable}`;
    
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await axios.get(url, {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      });
      
      saveResponseToFile(responsePath, `09_object_hierarchy`, response.data);
      
      if (response.data.data) {
        return response.data;
      }
      
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
    
    throw new Error('Object hierarchy extraction timeout');
  } catch (error) {
    throw new Error(`Object hierarchy failed: ${error.response?.data || error.message}`);
  }
}

async function retrievePropertiesAllObjects(accessToken, encodedUrn, guidViewable, responsePath) {
  try {
    const url = `https://developer.api.autodesk.com/modelderivative/v2/designdata/${encodedUrn}/metadata/${guidViewable}/properties`;
    
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await axios.get(url, {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      });
      
      saveResponseToFile(responsePath, `10_properties_all_objects`, response.data);
      
      if (response.data.data) {
        return response.data;
      }
      
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
    
    throw new Error('Properties extraction timeout');
  } catch (error) {
    throw new Error(`Properties retrieval failed: ${error.response?.data || error.message}`);
  }
}

// Main processing function
async function processFiles(sessionId, folderPath, responsePath) {
  try {
    updateSession(sessionId, {
      status: 'processing',
      message: 'Getting access token',
      progress: 5
    });

    const accessToken = await getAccessToken(responsePath);
    if (!accessToken) throw new Error('Failed to get access token');

    updateSession(sessionId, {
      message: 'Creating bucket',
      progress: 10
    });
    
    const bucketKey = `bucket_${uuidv4().replace(/-/g, '')}`;
    const bucketCreated = await createBucket(accessToken, bucketKey, responsePath);
    if (!bucketCreated) throw new Error('Failed to create bucket');

    updateSession(sessionId, {
      message: 'Uploading files',
      progress: 20
    });
    
    await uploadAllFiles(accessToken, bucketKey, folderPath, responsePath);

    updateSession(sessionId, {
      message: 'Detecting assembly',
      progress: 30
    });
    
    const assemblyFile = detectAssemblyFile(folderPath);
    if (!assemblyFile) throw new Error('No assembly (.iam) file found');

    updateSession(sessionId, {
      message: 'Linking references',
      progress: 40
    });
    
    const linked = await linkReferences(accessToken, bucketKey, assemblyFile, folderPath, responsePath);
    if (!linked) throw new Error('Failed to link references');

    updateSession(sessionId, {
      message: 'Starting translation',
      progress: 50
    });
    
    const encodedUrn = await startTranslationJob(accessToken, bucketKey, assemblyFile, responsePath);
    if (!encodedUrn) throw new Error('Failed to start translation job');

    updateSession(sessionId, {
      message: 'Translating model (this may take several minutes)',
      progress: 60
    });
    
    await checkTranslationStatus(accessToken, encodedUrn, responsePath);

    updateSession(sessionId, {
      message: 'Retrieving viewables',
      progress: 70
    });
    
    const guidViewable = await retrieveListOfViewableFiles(accessToken, encodedUrn, responsePath);
    if (!guidViewable) throw new Error('Failed to retrieve viewable files');

    updateSession(sessionId, {
      message: 'Extracting hierarchy',
      progress: 80
    });
    
    await getObjectHierarchy(accessToken, encodedUrn, guidViewable, responsePath);

    updateSession(sessionId, {
      message: 'Retrieving properties',
      progress: 90
    });
    
    await retrievePropertiesAllObjects(accessToken, encodedUrn, guidViewable, responsePath);

    updateSession(sessionId, {
      status: 'completed',
      message: 'Processing finished',
      progress: 100,
      result: {
        accessToken,
        encodedUrn
      }
    });
  } catch (error) {
    updateSession(sessionId, {
      status: 'failed',
      message: 'Processing failed',
      error: error.message,
      details: error.stack
    });
  } finally {
    // Clean up unzipped files
    try {
      fs.rmSync(folderPath, { recursive: true, force: true });
      console.log(`Cleaned up folder: ${folderPath}`);
    } catch (cleanupError) {
      console.error(`Cleanup failed for ${folderPath}:`, cleanupError);
    }
  }
}

// Session cleanup on startup
function cleanupOldSessions() {
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours
  
  try {
    const sessionDirs = fs.readdirSync('responses')
      .filter(dir => dir.startsWith('session_'))
      .map(dir => ({
        path: path.join('responses', dir),
        name: dir,
        sessionId: dir.replace('session_', '')
      }));
    
    for (const sessionDir of sessionDirs) {
      try {
        const session = getSession(sessionDir.sessionId);
        if (!session) continue;
        
        // Delete sessions older than maxAge
        const createdTime = new Date(session.createdAt || 0).getTime();
        if (now - createdTime > maxAge) {
          fs.rmSync(sessionDir.path, { recursive: true, force: true });
          console.log(`Cleaned up old session: ${sessionDir.name}`);
        }
      } catch (error) {
        console.error(`Error cleaning session ${sessionDir.name}:`, error);
      }
    }
  } catch (error) {
    console.error('Session cleanup failed:', error);
  }
}

// Start the server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  
  // Add creation timestamp to session files
  cleanupOldSessions();
  
  if (!FORGE_CLIENT_ID || !FORGE_CLIENT_SECRET) {
    console.error('Missing Forge credentials in environment variables!');
  }
});
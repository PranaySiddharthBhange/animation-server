const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const FileUtils = require('../utils/fileUtils');
const CONFIG = require('../config/config');

/**
 * ForgeClient encapsulates all Autodesk Forge API interactions,
 * including authentication, bucket management, file uploads, translation jobs,
 * and retrieval of model metadata and properties.
 */
class ForgeClient {
  /**
   * Initialize the ForgeClient with client credentials.
   * @param {string} clientId - Autodesk Forge client ID.
   * @param {string} clientSecret - Autodesk Forge client secret.
   */
  constructor(clientId, clientSecret) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.baseURL = 'https://developer.api.autodesk.com';
  }

  /**
   * Obtain an OAuth access token from Forge.
   * Optionally saves the token response to disk.
   * @param {string|null} responsePath - Path to save the token response (optional).
   * @param {string[]} scopes - Array of OAuth scopes to request.
   * @returns {Promise<string>} - The access token string.
   */
  async getAccessToken(responsePath = null, scopes = [
    'data:write',
    'data:read',
    'bucket:create',
    'bucket:delete'
  ]) {
    const credentials = `${this.clientId}:${this.clientSecret}`;
    const encodedCredentials = Buffer.from(credentials).toString('base64');

    try {
      const response = await axios.post(
        `${this.baseURL}/authentication/v2/token`,
        new URLSearchParams({
          grant_type: 'client_credentials',
          scope: scopes.join(' ')
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

      // Save token response if a path is provided
      if (responsePath) {
        await FileUtils.saveResponseToFile(responsePath, '01_get_access_token', response.data);
      }

      return response.data.access_token;
    } catch (error) {
      const message = error.response?.data?.error_description || error.message;
      throw new Error(`Access token error: ${message}`);
    }
  }

  /**
   * Create a new Forge bucket for file uploads.
   * If the bucket already exists, marks it as such.
   * @param {string} accessToken - OAuth access token.
   * @param {string} bucketKey - Unique bucket key.
   * @param {string} responsePath - Path to save the response.
   * @returns {Promise<boolean>} - True if bucket created or already exists.
   */
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

  /**
   * Upload all files in a folder (recursively) to a Forge bucket.
   * Calls uploadSingleFile for each file found.
   * @param {string} accessToken - OAuth access token.
   * @param {string} bucketKey - Forge bucket key.
   * @param {string} folderPath - Local folder to upload.
   * @param {string} responsePath - Path to save responses.
   * @param {function} updateProgress - Optional callback for progress updates.
   */
  async uploadAllFiles(accessToken, bucketKey, folderPath, responsePath, updateProgress) {
    const files = [];

    // Recursively walk the directory to collect all files
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

    // Upload each file one by one
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

  /**
   * Upload a single file to Forge using a signed S3 URL.
   * Handles S3 upload and finalizes with Forge.
   * @param {string} accessToken - OAuth access token.
   * @param {string} bucketKey - Forge bucket key.
   * @param {object} file - File object with name and path.
   * @param {string} responsePath - Path to save responses.
   */
  async uploadSingleFile(accessToken, bucketKey, file, responsePath) {
    // Get signed URL for S3 upload
    const encodedFileName = encodeURIComponent(file.name);
    const signedUrlResponse = await axios.get(
      `${this.baseURL}/oss/v2/buckets/${bucketKey}/objects/${encodedFileName}/signeds3upload?minutesExpiration=60`,
      {
        headers: { 'Authorization': `Bearer ${accessToken}` },
        timeout: 30000
      }
    );

    const { urls: [signedUrl], uploadKey } = signedUrlResponse.data;

    // Upload file data to S3
    const fileData = await fs.readFile(file.path);
    await axios.put(signedUrl, fileData, {
      headers: { 'Content-Type': 'application/octet-stream' },
      timeout: 120000 // 2 minutes for file upload
    });

    // Finalize the upload with Forge
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

  /**
   * Link references for assembly files (e.g., .iam referencing .ipt).
   * Finds all .ipt files and links them to the assembly in Forge.
   * @param {string} accessToken - OAuth access token.
   * @param {string} bucketKey - Forge bucket key.
   * @param {string} assemblyFile - Main assembly file name.
   * @param {string} folderPath - Local folder containing files.
   * @param {string} responsePath - Path to save responses.
   * @returns {Promise<boolean>} - True if linking succeeded.
   */
  async linkReferences(accessToken, bucketKey, assemblyFile, folderPath, responsePath) {
    try {
      const assemblyUrn = `urn:adsk.objects:os.object:${bucketKey}/${assemblyFile}`;
      const encodedUrn = this.base64EncodeUrn(assemblyUrn);

      const references = [];
      const files = await fs.readdir(folderPath, { recursive: true });

      // Find all .ipt files and add as references
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

  /**
   * Start a translation job for the uploaded assembly file.
   * Requests SVF2 output for both 2D and 3D views.
   * @param {string} accessToken - OAuth access token.
   * @param {string} bucketKey - Forge bucket key.
   * @param {string} assemblyFile - Main assembly file name.
   * @param {string} responsePath - Path to save responses.
   * @returns {Promise<string>} - The encoded URN for the translation job.
   */
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

  /**
   * Poll Forge for translation status until complete or timeout.
   * Saves the final status to disk.
   * @param {string} accessToken - OAuth access token.
   * @param {string} encodedUrn - Base64-encoded URN.
   * @param {string} responsePath - Path to save responses.
   * @param {function} updateProgress - Optional callback for progress updates.
   * @returns {Promise<boolean>} - True if translation succeeded.
   */
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

  /**
   * Retrieve model metadata (such as viewable GUIDs).
   * Saves metadata to disk and returns the first viewable GUID.
   * @param {string} accessToken - OAuth access token.
   * @param {string} encodedUrn - Base64-encoded URN.
   * @param {string} responsePath - Path to save responses.
   * @returns {Promise<string>} - The first viewable GUID.
   */
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

  /**
   * Retrieve the object hierarchy for the model.
   * Retries up to 5 times if data is not immediately available.
   * @param {string} accessToken - OAuth access token.
   * @param {string} encodedUrn - Base64-encoded URN.
   * @param {string} guidViewable - GUID of the viewable.
   * @param {string} responsePath - Path to save responses.
   * @returns {Promise<object>} - The object hierarchy data.
   */
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

  /**
   * Retrieve all properties for all objects in the model.
   * Retries up to 5 times if data is not immediately available.
   * @param {string} accessToken - OAuth access token.
   * @param {string} encodedUrn - Base64-encoded URN.
   * @param {string} guidViewable - GUID of the viewable.
   * @param {string} responsePath - Path to save responses.
   * @returns {Promise<object>} - The properties data.
   */
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

  /**
   * Encode a URN for use in Forge API URLs.
   * Uses base64 encoding and replaces URL-unsafe characters.
   * @param {string} urn - The URN to encode.
   * @returns {string} - The base64-encoded URN.
   */
  base64EncodeUrn(urn) {
    return Buffer.from(urn).toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  }
}

module.exports = ForgeClient;
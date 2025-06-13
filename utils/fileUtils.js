const fs = require('fs').promises;
const path = require('path');

/**
 * FileUtils provides utility functions for file operations such as saving API responses,
 * extracting essential data, detecting assembly files, and cleaning up files or directories.
 */
class FileUtils {
  /**
   * Saves only the essential data from an API response to a JSON file on disk.
   * The file is named after the stepName and stored in the specified responsePath.
   * @param {string} responsePath - Directory where the response file will be saved.
   * @param {string} stepName - The name of the API step (used as the filename).
   * @param {object} data - The full API response data.
   */
  static async saveResponseToFile(responsePath, stepName, data) {
    // Extract only the necessary fields for the given step
    const essentialData = this.extractEssentialData(stepName, data);
    // Construct the full file path for saving the response
    const filePath = path.join(responsePath, `${stepName}.json`);
    // Write the essential data to the file in pretty-printed JSON format
    await fs.writeFile(filePath, JSON.stringify(essentialData, null, 2));
  }

  /**
   * Extracts only the necessary fields from API responses based on the step name.
   * This reduces storage and ensures only relevant data is persisted.
   * @param {string} stepName - The name of the API step.
   * @param {object} data - The full API response data.
   * @returns {object} - The filtered essential data.
   */
  static extractEssentialData(stepName, data) {
    switch (stepName) {
      case '01_get_access_token':
        // Return only token-related fields
        return {
          access_token: data.access_token,
          expires_in: data.expires_in,
          token_type: data.token_type
        };
      case '06_start_translation_job':
        // Return job result and identifiers
        return {
          result: data.result,
          urn: data.urn,
          acceptedJobs: data.acceptedJobs
        };
      case '08_metadata':
        // Return only type and a simplified metadata array
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
        // Keep the full object hierarchy for animation purposes
        return data;
      case '10_properties_all_objects':
        // Keep all object properties for animation
        return data;
      default:
        // For other steps, return a simple status and timestamp
        return { status: 'completed', timestamp: new Date().toISOString() };
    }
  }

  /**
   * Detects the main assembly file (.iam) in a given folder.
   * Searches recursively and returns the first .iam file found.
   * @param {string} folderPath - The path to the folder to search.
   * @returns {Promise<string|null>} - The filename of the assembly file, or null if not found.
   */
  static async detectAssemblyFile(folderPath) {
    try {
      // Read all files in the folder (recursively)
      const files = await fs.readdir(folderPath, { recursive: true });
      for (const file of files) {
        // Check if the file is a string and ends with .iam (case-insensitive)
        if (typeof file === 'string' && file.toLowerCase().endsWith('.iam')) {
          return file;
        }
      }
      // Return null if no .iam file is found
      return null;
    } catch (error) {
      // Log any errors encountered during directory reading
      console.error('Error detecting assembly file:', error.message);
      return null;
    }
  }

  /**
   * Removes a file or directory from disk.
   * Uses recursive and force options to ensure deletion of non-empty directories.
   * @param {string} filePath - The path to the file or directory to remove.
   */
  static async cleanupPath(filePath) {
    try {
      // Remove the file or directory recursively and force deletion
      await fs.rm(filePath, { recursive: true, force: true });
    } catch (error) {
      // Log any errors encountered during cleanup
      console.error(`Cleanup failed for ${filePath}:`, error.message);
    }
  }
}

module.exports = FileUtils;
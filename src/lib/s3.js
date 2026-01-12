// AWS S3 Configuration for document uploads
// Using signed URLs for secure, time-limited access to documents

import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

// Initialize S3 client
const s3Client = new S3Client({
  region: import.meta.env.VITE_AWS_REGION,
  credentials: {
    accessKeyId: import.meta.env.VITE_AWS_ACCESS_KEY_ID,
    secretAccessKey: import.meta.env.VITE_AWS_SECRET_ACCESS_KEY,
  },
})

const BUCKET_NAME = import.meta.env.VITE_S3_BUCKET

// URL expiration time in seconds (1 hour)
const URL_EXPIRATION = 3600

/**
 * Upload a document to S3
 * @param {File} file - The file to upload
 * @param {string} path - The path/folder in S3 (e.g., 'jobs/uuid')
 * @returns {Promise<{fileName, filePath, fileSize, mimeType}>}
 */
export const uploadDocument = async (file, path) => {
  const fileName = `${Date.now()}_${file.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`
  const filePath = `${path}/${fileName}`

  // Convert file to array buffer for upload
  const arrayBuffer = await file.arrayBuffer()

  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: filePath,
    Body: arrayBuffer,
    ContentType: file.type,
    // Add metadata for tracking
    Metadata: {
      'original-filename': encodeURIComponent(file.name),
      'uploaded-at': new Date().toISOString(),
    },
  })

  try {
    await s3Client.send(command)
    
    return {
      fileName: file.name,
      filePath,
      fileSize: file.size,
      mimeType: file.type,
    }
  } catch (error) {
    console.error('S3 Upload error:', error)
    throw new Error(`Failed to upload document: ${error.message}`)
  }
}

/**
 * Get a signed URL for viewing/downloading a document
 * URLs expire after URL_EXPIRATION seconds (default 1 hour)
 * @param {string} filePath - The S3 key/path of the file
 * @returns {Promise<string>} - Signed URL
 */
export const getDocumentUrl = async (filePath) => {
  if (!filePath) return null

  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: filePath,
  })

  try {
    const signedUrl = await getSignedUrl(s3Client, command, {
      expiresIn: URL_EXPIRATION,
    })
    return signedUrl
  } catch (error) {
    console.error('Error generating signed URL:', error)
    throw new Error(`Failed to generate document URL: ${error.message}`)
  }
}

/**
 * Delete a document from S3
 * @param {string} filePath - The S3 key/path of the file
 */
export const deleteDocument = async (filePath) => {
  const command = new DeleteObjectCommand({
    Bucket: BUCKET_NAME,
    Key: filePath,
  })

  try {
    await s3Client.send(command)
  } catch (error) {
    console.error('S3 Delete error:', error)
    throw new Error(`Failed to delete document: ${error.message}`)
  }
}

/**
 * Generate a pre-signed URL for direct upload from browser
 * Useful for large files - upload directly to S3 without going through your server
 * @param {string} path - The path/folder in S3
 * @param {string} fileName - The file name
 * @param {string} contentType - The MIME type
 * @returns {Promise<{uploadUrl, filePath}>}
 */
export const getUploadUrl = async (path, fileName, contentType) => {
  const sanitizedFileName = `${Date.now()}_${fileName.replace(/[^a-zA-Z0-9.-]/g, '_')}`
  const filePath = `${path}/${sanitizedFileName}`

  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: filePath,
    ContentType: contentType,
  })

  try {
    const uploadUrl = await getSignedUrl(s3Client, command, {
      expiresIn: 300, // 5 minutes to complete upload
    })
    
    return {
      uploadUrl,
      filePath,
    }
  } catch (error) {
    console.error('Error generating upload URL:', error)
    throw new Error(`Failed to generate upload URL: ${error.message}`)
  }
}
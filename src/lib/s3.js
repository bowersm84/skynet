// S3 Configuration for document uploads
// We'll use Supabase Storage for MVP (simpler), 
// can migrate to S3 later if needed

import { supabase } from './supabase'

export const uploadDocument = async (file, path) => {
  const fileExt = file.name.split('.').pop()
  const fileName = `${Date.now()}_${file.name}`
  const filePath = `${path}/${fileName}`

  const { data, error } = await supabase.storage
    .from('documents')
    .upload(filePath, file)

  if (error) {
    console.error('Upload error:', error)
    throw error
  }

  // Get public URL
  const { data: urlData } = supabase.storage
    .from('documents')
    .getPublicUrl(filePath)

  return {
    fileName: file.name,
    filePath,
    fileUrl: urlData.publicUrl,
    fileSize: file.size,
    mimeType: file.type
  }
}

export const deleteDocument = async (filePath) => {
  const { error } = await supabase.storage
    .from('documents')
    .remove([filePath])

  if (error) {
    console.error('Delete error:', error)
    throw error
  }
}

export const getDocumentUrl = (filePath) => {
  const { data } = supabase.storage
    .from('documents')
    .getPublicUrl(filePath)
  
  return data.publicUrl
}
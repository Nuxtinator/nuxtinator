import {
  Input,
  Output,
  Conversion,
  Mp4OutputFormat,
  BufferTarget,
  BlobSource,
  ALL_FORMATS,
} from 'mediabunny'
import fixWebmDuration from 'fix-webm-duration'
import { getActiveSlug } from '#tenant'

interface UploadProgress {
  stage: 'validating' | 'compressing' | 'uploading' | 'finalizing' | 'complete' | 'error'
  progress: number
  message: string
  estimatedTimeRemaining?: number
}

interface VideoMetadata {
  duration: number
  width: number
  height: number
  fileSize: number
  originalFileSize: number
  compressionRatio?: number
}

const ACCEPTED_FORMATS = ['.mp4', '.mov', '.webm', '.avi']
const ACCEPTED_MIME_TYPES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/avi', 'video/x-msvideo']
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024 // 2GB
const COMPRESSION_THRESHOLD = 50 * 1024 * 1024 // 50MB

export const useVideoUpload = () => {
  const uploadProgress = ref<UploadProgress>({
    stage: 'validating',
    progress: 0,
    message: 'Ready to upload'
  })

  const selectedFile = ref<File | null>(null)
  const videoMetadata = ref<VideoMetadata | null>(null)
  const videoPreviewUrl = ref<string | null>(null)
  const isUploading = ref(false)
  const error = ref<string | null>(null)
  const shareToken = ref<string | null>(null)
  const videoId = ref<string | null>(null)

  // Detect if device is mobile
  const isMobile = () => {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
  }

  // Validate file
  const validateFile = (file: File): { valid: boolean; error?: string } => {
    // Check file size
    if (file.size > MAX_FILE_SIZE) {
      return { valid: false, error: 'File exceeds 2GB limit. Please choose a smaller file.' }
    }

    // Check file extension
    const fileName = file.name.toLowerCase()
    const hasValidExtension = ACCEPTED_FORMATS.some(ext => fileName.endsWith(ext))

    if (!hasValidExtension) {
      return {
        valid: false,
        error: `Invalid file format. Please upload a video file (${ACCEPTED_FORMATS.join(', ')})`
      }
    }

    // Check MIME type
    if (!ACCEPTED_MIME_TYPES.includes(file.type)) {
      return {
        valid: false,
        error: 'File type not recognized as a video. Please select a valid video file.'
      }
    }

    return { valid: true }
  }

  // Extract video metadata
  const extractVideoMetadata = async (file: File): Promise<VideoMetadata> => {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video')
      video.preload = 'metadata'

      video.onloadedmetadata = () => {
        window.URL.revokeObjectURL(video.src)
        resolve({
          duration: Math.round(video.duration),
          width: video.videoWidth,
          height: video.videoHeight,
          fileSize: file.size,
          originalFileSize: file.size
        })
      }

      video.onerror = () => {
        window.URL.revokeObjectURL(video.src)
        reject(new Error('Unable to read video metadata. The file may be corrupted.'))
      }

      video.src = URL.createObjectURL(file)
    })
  }

  // Generate thumbnail from video
  const generateThumbnail = async (file: File): Promise<Blob> => {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video')
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')

      video.onloadedmetadata = () => {
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        video.currentTime = 1 // Seek to 1 second
      }

      video.onseeked = () => {
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
          canvas.toBlob((blob) => {
            window.URL.revokeObjectURL(video.src)
            if (blob) {
              resolve(blob)
            } else {
              reject(new Error('Failed to generate thumbnail'))
            }
          }, 'image/jpeg', 0.8)
        } else {
          reject(new Error('Failed to get canvas context'))
        }
      }

      video.onerror = () => {
        window.URL.revokeObjectURL(video.src)
        reject(new Error('Failed to load video for thumbnail'))
      }

      video.src = URL.createObjectURL(file)
    })
  }

  // Compress video using Mediabunny (WebCodecs - hardware accelerated)
  const compressVideo = async (file: File): Promise<Blob> => {
    try {
      uploadProgress.value = {
        stage: 'compressing',
        progress: 5,
        message: 'Initializing video processor...'
      }

      // Create input from file
      const input = new Input({
        formats: ALL_FORMATS,
        source: new BlobSource(file)
      })

      // Create output target
      const bufferTarget = new BufferTarget()
      const output = new Output({
        format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
        target: bufferTarget,
      })

      uploadProgress.value = {
        stage: 'compressing',
        progress: 10,
        message: 'Analyzing video...'
      }

      // Initialize conversion with compression settings
      const conversion = await Conversion.init({
        input,
        output,
        video: {
          width: 1280, // Max width (will maintain aspect ratio)
          bitrate: 2_500_000, // 2.5 Mbps
        },
        audio: {
          bitrate: 128_000, // 128 kbps
        },
      })

      if (!conversion.isValid) {
        console.warn('Some tracks could not be converted:', conversion.discardedTracks)
      }

      // Track progress
      conversion.onProgress = (progress: number) => {
        const percentage = Math.round(progress * 90) + 10 // 10-100%
        uploadProgress.value = {
          stage: 'compressing',
          progress: percentage,
          message: `Compressing video (hardware accelerated)... ${percentage}%`
        }
      }

      // Execute conversion
      await conversion.execute()

      // Get the compressed buffer
      const compressedBuffer = bufferTarget.buffer
      if (!compressedBuffer) throw new Error('Compression produced no output')
      const compressedBlob = new Blob([compressedBuffer], { type: 'video/mp4' })

      uploadProgress.value = {
        stage: 'compressing',
        progress: 100,
        message: `Compression complete! Reduced from ${formatFileSize(file.size)} to ${formatFileSize(compressedBlob.size)}`
      }

      return compressedBlob
    } catch (err) {
      console.error('Compression error:', err)
      throw new Error('Video compression failed. Uploading original file instead.')
    }
  }

  // Remux fragmented MP4 to flat MP4 for progressive playback
  const remuxToFlatMp4 = async (fmp4Blob: Blob): Promise<Blob> => {
    const input = new Input({
      formats: ALL_FORMATS,
      source: new BlobSource(fmp4Blob),
    })

    const bufferTarget = new BufferTarget()
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: bufferTarget,
    })

    const conversion = await Conversion.init({ input, output })

    await conversion.execute()
    if (!bufferTarget.buffer) throw new Error('Remux produced no output')
    return new Blob([bufferTarget.buffer], { type: 'video/mp4' })
  }

  // Upload to S3
  const uploadToS3 = async (videoBlob: Blob, thumbnailBlob: Blob, originalFileName: string, metadata: VideoMetadata) => {
    try {
      uploadProgress.value = {
        stage: 'uploading',
        progress: 0,
        message: 'Requesting upload URL...'
      }

      // Get pre-signed upload URLs
      const response = await $fetch('/api/videos/upload-url', {
        method: 'POST',
        body: {
          fileName: originalFileName,
          contentType: 'video/mp4',
          withThumbnail: true
        }
      })

      if (!response.success) {
        throw new Error('Failed to get upload URL')
      }

      const { videoId: vid, videoUploadUrl, thumbnailUploadUrl } = response

      videoId.value = vid

      uploadProgress.value = {
        stage: 'uploading',
        progress: 10,
        message: 'Uploading video...'
      }

      // Upload video
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest()

        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            const percentage = Math.round((e.loaded / e.total) * 80) + 10 // 10-90%
            uploadProgress.value = {
              stage: 'uploading',
              progress: percentage,
              message: `Uploading video... ${percentage}%`
            }
          }
        })

        xhr.addEventListener('load', () => {
          if (xhr.status === 200) {
            resolve()
          } else {
            reject(new Error(`Upload failed with status ${xhr.status}`))
          }
        })

        xhr.addEventListener('error', () => {
          reject(new Error('Network error during upload'))
        })

        xhr.open('PUT', videoUploadUrl)
        xhr.setRequestHeader('Content-Type', 'video/mp4')
        xhr.send(videoBlob)
      })

      uploadProgress.value = {
        stage: 'uploading',
        progress: 92,
        message: 'Uploading thumbnail...'
      }

      // Upload thumbnail
      if (thumbnailUploadUrl) {
        await fetch(thumbnailUploadUrl, {
          method: 'PUT',
          headers: {
            'Content-Type': 'image/jpeg'
          },
          body: thumbnailBlob
        })
      }

      uploadProgress.value = {
        stage: 'finalizing',
        progress: 95,
        message: 'Finalizing upload...'
      }

      // Complete upload
      const completeResponse = await $fetch<{ success: boolean; shareToken?: string }>('/api/videos/upload-complete', {
        method: 'POST',
        body: {
          videoId: vid,
          videoKey: response.videoKey,
          thumbnailKey: response.thumbnailKey,
          duration: metadata.duration,
          fileSize: videoBlob.size,
          width: metadata.width,
          height: metadata.height,
          source: 'upload',
          originalFilename: originalFileName,
          originalFileSize: metadata.originalFileSize,
          compressionRatio: metadata.compressionRatio
        }
      })

      if (!completeResponse.success || !completeResponse.shareToken) {
        throw new Error('Failed to finalize upload')
      }

      shareToken.value = completeResponse.shareToken

      uploadProgress.value = {
        stage: 'complete',
        progress: 100,
        message: 'Upload complete!'
      }

      return completeResponse
    } catch (err: any) {
      console.error('Upload error:', err)
      throw new Error(err.message || 'Upload failed. Please try again.')
    }
  }

  // Main upload function
  const uploadVideo = async () => {
    if (!selectedFile.value) {
      error.value = 'No file selected'
      return
    }

    isUploading.value = true
    error.value = null

    try {
      const file = selectedFile.value

      // Stage 1: Validate file
      uploadProgress.value = {
        stage: 'validating',
        progress: 0,
        message: 'Analyzing video...'
      }

      const validation = validateFile(file)
      if (!validation.valid) {
        throw new Error(validation.error)
      }

      // Extract metadata
      const metadata = await extractVideoMetadata(file)
      videoMetadata.value = metadata

      // Generate thumbnail
      const thumbnailBlob = await generateThumbnail(file)

      // Stage 2: Compress if needed
      let videoBlob: Blob = file
      let compressionRatio: number | undefined

      const shouldCompress = file.size >= COMPRESSION_THRESHOLD && !isMobile()

      if (shouldCompress) {
        uploadProgress.value = {
          stage: 'compressing',
          progress: 0,
          message: 'Preparing hardware-accelerated compression...'
        }

        try {
          const compressedBlob = await compressVideo(file)

          compressionRatio = parseFloat(((file.size - compressedBlob.size) / file.size * 100).toFixed(2))
          videoBlob = compressedBlob

          if (videoMetadata.value) {
            videoMetadata.value.fileSize = compressedBlob.size
            videoMetadata.value.compressionRatio = compressionRatio
          }
        } catch (compressionError: any) {
          console.warn('Compression failed, uploading original:', compressionError)
          // Continue with original file
          uploadProgress.value = {
            stage: 'uploading',
            progress: 0,
            message: 'Uploading original file...'
          }
        }
      } else if (file.size >= COMPRESSION_THRESHOLD && isMobile()) {
        uploadProgress.value = {
          stage: 'uploading',
          progress: 0,
          message: 'Large file detected. This may take a while on mobile...'
        }
      }

      // Stage 3: Remux fMP4 to flat MP4 for progressive playback
      if (videoBlob.type === 'video/mp4' || file.name.toLowerCase().endsWith('.mp4')) {
        try {
          uploadProgress.value = {
            stage: 'compressing',
            progress: 100,
            message: 'Optimizing for streaming...'
          }
          videoBlob = await remuxToFlatMp4(videoBlob)
        } catch (remuxError) {
          console.warn('Remux failed, uploading as-is:', remuxError)
        }
      }

      // Stage 4: Upload to S3
      if (videoMetadata.value) {
        await uploadToS3(videoBlob, thumbnailBlob, file.name, videoMetadata.value)
      }

      // Success!
      isUploading.value = false
    } catch (err: any) {
      console.error('Upload failed:', err)
      error.value = err.message || 'Upload failed. Please try again.'
      uploadProgress.value = {
        stage: 'error',
        progress: 0,
        message: error.value || 'Upload failed'
      }
      isUploading.value = false
    }
  }

  // Upload screen recording (for recorded videos)
  const uploadRecording = async (
    recordedChunks: Blob[],
    recordedVideoUrl: string,
    recordingTime: number,
    format?: { mimeType: string; isMP4: boolean } | null,
    audience: VideoAudience = { visibility: 'private' }
  ) => {
    if (!recordedVideoUrl || recordedChunks.length === 0) {
      throw new Error('No recording to upload')
    }

    try {
      isUploading.value = true
      uploadProgress.value = {
        stage: 'uploading',
        progress: 0,
        message: 'Preparing upload...'
      }

      const isMP4 = format?.isMP4 ?? false
      const mimeType = format?.mimeType || 'video/webm'

      // Create blob from recorded chunks
      const rawBlob = new Blob(recordedChunks, { type: mimeType })

      let blob: Blob
      let finalMimeType: string
      let fileExtension: string

      if (isMP4) {
        // MediaRecorder MP4 is fragmented — remux to flat MP4 for progressive playback
        uploadProgress.value = {
          stage: 'compressing',
          progress: 0,
          message: 'Optimizing for streaming...'
        }

        try {
          blob = await remuxToFlatMp4(rawBlob)
        } catch (remuxError) {
          console.warn('MP4 remux failed, uploading as-is:', remuxError)
          blob = rawBlob
        }
        finalMimeType = 'video/mp4'
        fileExtension = 'mp4'
      } else {
        // WebM recording - convert to MP4 for iOS compatibility
        uploadProgress.value = {
          stage: 'compressing',
          progress: 0,
          message: 'Converting to MP4 for universal playback...'
        }

        try {
          blob = await compressVideo(new File([rawBlob], 'recording.webm', { type: 'video/webm' }))
          // compressVideo outputs fMP4 — remux to flat MP4
          uploadProgress.value = {
            stage: 'compressing',
            progress: 100,
            message: 'Optimizing for streaming...'
          }
          blob = await remuxToFlatMp4(blob)
          finalMimeType = 'video/mp4'
          fileExtension = 'mp4'
        } catch (conversionError) {
          console.warn('MP4 conversion failed, uploading WebM:', conversionError)
          // Fallback: fix WebM duration and upload as WebM
          blob = await fixWebmDuration(rawBlob, recordingTime * 1000)
          finalMimeType = 'video/webm'
          fileExtension = 'webm'
        }
      }

      const fileSize = blob.size

      // Generate thumbnail from video URL
      const thumbnailBlob = await generateThumbnailFromUrl(recordedVideoUrl)

      uploadProgress.value = {
        stage: 'uploading',
        progress: 5,
        message: 'Requesting upload URL...'
      }

      // Step 1: Request pre-signed URLs from server
      const urlResponse = await $fetch('/api/videos/upload-url', {
        method: 'POST',
        body: {
          fileName: `recording-${Date.now()}.${fileExtension}`,
          contentType: finalMimeType,
          withThumbnail: !!thumbnailBlob,
        },
      })

      if (!urlResponse.success || !urlResponse.videoUploadUrl) {
        throw new Error('Failed to get upload URLs')
      }

      videoId.value = urlResponse.videoId

      uploadProgress.value = {
        stage: 'uploading',
        progress: 10,
        message: 'Uploading video...'
      }

      // Step 2: Upload video directly to S3 using pre-signed URL
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest()

        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            // Video upload is 10-90% of total progress
            const progress = Math.round((e.loaded / e.total) * 80) + 10
            uploadProgress.value = {
              stage: 'uploading',
              progress,
              message: `Uploading video... ${progress}%`
            }
          }
        })

        xhr.addEventListener('load', () => {
          if (xhr.status === 200) {
            resolve()
          } else {
            reject(new Error(`Video upload failed with status ${xhr.status}`))
          }
        })

        xhr.addEventListener('error', () => {
          reject(new Error('Video upload failed - network error'))
        })

        xhr.open('PUT', urlResponse.videoUploadUrl)
        xhr.setRequestHeader('Content-Type', finalMimeType)
        xhr.send(blob)
      })

      // Step 3: Upload thumbnail directly to S3 (if exists)
      if (thumbnailBlob && urlResponse.thumbnailUploadUrl) {
        uploadProgress.value = {
          stage: 'uploading',
          progress: 92,
          message: 'Uploading thumbnail...'
        }

        await fetch(urlResponse.thumbnailUploadUrl, {
          method: 'PUT',
          headers: {
            'Content-Type': 'image/jpeg'
          },
          body: thumbnailBlob
        })
      }

      uploadProgress.value = {
        stage: 'finalizing',
        progress: 95,
        message: 'Finalizing upload...'
      }

      // Step 4: Save metadata to database
      const completeResponse = await $fetch<{ success: boolean; shareToken?: string }>('/api/videos/upload-complete', {
        method: 'POST',
        body: {
          videoId: urlResponse.videoId,
          videoKey: urlResponse.videoKey,
          thumbnailKey: urlResponse.thumbnailKey,
          duration: recordingTime,
          fileSize,
          source: 'recording',
          visibility: audience.visibility,
          teamId: audience.teamId ?? null,
          linkEnabled: audience.linkEnabled ?? false
        },
      })

      if (!completeResponse.success || !completeResponse.shareToken) {
        throw new Error('Failed to save video metadata')
      }

      // Success!
      shareToken.value = completeResponse.shareToken
      uploadProgress.value = {
        stage: 'complete',
        progress: 100,
        message: 'Upload complete!'
      }
      isUploading.value = false

      return true
    } catch (err: any) {
      console.error('Error uploading recording:', err)
      isUploading.value = false
      uploadProgress.value = {
        stage: 'error',
        progress: 0,
        message: err.message || 'Upload failed. Please try again.'
      }
      error.value = err.message || 'Upload failed. Please try again.'
      throw err
    }
  }

  // Generate thumbnail from video URL
  const generateThumbnailFromUrl = async (videoUrl: string): Promise<Blob> => {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video')
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')

      video.onloadedmetadata = () => {
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        video.currentTime = 1 // Seek to 1 second
      }

      video.onseeked = () => {
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
          canvas.toBlob((blob) => {
            if (blob) {
              resolve(blob)
            } else {
              reject(new Error('Failed to generate thumbnail'))
            }
          }, 'image/jpeg', 0.8)
        } else {
          reject(new Error('Failed to get canvas context'))
        }
      }

      video.onerror = () => {
        reject(new Error('Failed to load video for thumbnail'))
      }

      // videoUrl is the recording's preview blob URL, owned by the caller and
      // still needed for preview/download/retry after this runs. Don't revoke
      // it here — revoking would kill the live recording if the upload fails.
      video.src = videoUrl
    })
  }

  // Select file
  const selectFile = async (file: File) => {
    selectedFile.value = file
    error.value = null

    // Create preview URL
    if (videoPreviewUrl.value) {
      URL.revokeObjectURL(videoPreviewUrl.value)
    }
    videoPreviewUrl.value = URL.createObjectURL(file) || null

    // Validate immediately
    const validation = validateFile(file)
    if (!validation.valid) {
      error.value = validation.error ?? null
      return
    }

    // Extract metadata for preview
    try {
      const metadata = await extractVideoMetadata(file)
      videoMetadata.value = metadata
    } catch (err: any) {
      error.value = err.message
    }
  }

  // Reset state
  const reset = () => {
    selectedFile.value = null
    videoMetadata.value = null
    if (videoPreviewUrl.value) {
      URL.revokeObjectURL(videoPreviewUrl.value)
    }
    videoPreviewUrl.value = null
    isUploading.value = false
    error.value = null
    shareToken.value = null
    videoId.value = null
    uploadProgress.value = {
      stage: 'validating',
      progress: 0,
      message: 'Ready to upload'
    }
  }

  // Format file size
  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes'
    const k = 1024
    const sizes = ['Bytes', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i]
  }

  // Format duration
  const formatDuration = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const secs = seconds % 60

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`
  }

  // Computed: Generate shareable link from share token. In multi-tenant mode
  // the URL includes the active org slug — anonymous visitors hitting the
  // unprefixed `/watch/...` get bounced by the tenant route guard, while
  // `/@<slug>/watch/...` is whitelisted and resolves the same page via the
  // tenancy layer's pages:extend alias.
  const shareableLink = computed(() => {
    if (!shareToken.value) return null
    const siteUrl = window.location.origin
    const slug = getActiveSlug()
    const prefix = slug ? `/@${slug}` : ''
    return `${siteUrl}${prefix}/watch/${shareToken.value}`
  })

  // Computed: Extract just the progress number for backward compatibility
  const uploadProgressNumber = computed(() => uploadProgress.value.progress)

  // Alias for reset (for backward compatibility with screen recorder)
  const resetUpload = reset

  return {
    // State
    selectedFile,
    videoMetadata,
    videoPreviewUrl,
    isUploading,
    error,
    uploadProgress,
    uploadProgressNumber,
    shareToken,
    videoId,

    // Computed
    shareableLink,

    // Methods
    selectFile,
    uploadVideo,
    uploadRecording,
    reset,
    resetUpload,
    formatFileSize,
    formatDuration,

    // Constants
    ACCEPTED_FORMATS,
    MAX_FILE_SIZE
  }
}

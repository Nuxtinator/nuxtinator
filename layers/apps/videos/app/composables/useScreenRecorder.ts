import { playCountdownBeep, getWebcamDimensions, getWebcamPosition } from '../utils/recording-helpers'
import fixWebmDuration from 'fix-webm-duration'

export type RecordingMode = 'screen' | 'webcam' | 'both'

// Get the best supported recording format (prefer MP4 for iOS compatibility)
const getRecordingMimeType = (): { mimeType: string; isMP4: boolean } => {
  // Prefer MP4 for universal playback (especially iOS Safari)
  if (MediaRecorder.isTypeSupported('video/mp4;codecs=avc1,mp4a.40.2')) {
    return { mimeType: 'video/mp4;codecs=avc1,mp4a.40.2', isMP4: true }
  }
  if (MediaRecorder.isTypeSupported('video/mp4')) {
    return { mimeType: 'video/mp4', isMP4: true }
  }
  // Fallback to WebM (Firefox, older browsers)
  if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9')) {
    return { mimeType: 'video/webm;codecs=vp9', isMP4: false }
  }
  return { mimeType: 'video/webm;codecs=vp8', isMP4: false }
}

export const useScreenRecorder = () => {
  // Use sub-composables
  const audioMixer = useAudioMixer()
  const pip = usePictureInPicture()
  const upload = useVideoUpload()

  // Recording state
  const mediaRecorder = ref<MediaRecorder | null>(null)
  const recordedChunks = ref<Blob[]>([])
  const isRecording = ref(false)
  const isPaused = ref(false)
  const recordedVideoUrl = ref<string | null>(null)
  const error = ref<string | null>(null)
  const recordingTime = ref(0)
  const countdown = ref(0)
  const isPreparingRecording = ref(false)
  const isPositioning = ref(false)

  // Streams
  const screenStream = ref<MediaStream | null>(null)
  const webcamStream = ref<MediaStream | null>(null)
  const audioStream = ref<MediaStream | null>(null)
  const combinedStream = ref<MediaStream | null>(null)

  // Recording settings
  const recordingMode = ref<RecordingMode>('both')
  const showWebcam = ref(true)
  const includeAudio = ref(true)

  // Microphone selection. `null` means use the system default device.
  const selectedAudioDeviceId = ref<string | null>(null)
  const availableMics = ref<MediaDeviceInfo[]>([])

  // Internal state
  const tabRecordingFallback = ref(false)
  const displaySurfaceType = ref<string | null>(null)
  const recordingFormat = ref<{ mimeType: string; isMP4: boolean } | null>(null)

  // Canvas for compositing
  let canvas: HTMLCanvasElement | null = null
  let canvasCtx: CanvasRenderingContext2D | null = null
  let animationFrameId: number | null = null
  let recordingInterval: NodeJS.Timeout | null = null

  // Check if browser supports screen recording
  const isSupported = computed(() => {
    return typeof navigator !== 'undefined'
      && typeof navigator.mediaDevices?.getDisplayMedia === 'function'
      && typeof navigator.mediaDevices?.getUserMedia === 'function'
  })

  // Composite screen + webcam into canvas
  const compositeStreams = async (): Promise<MediaStream> => {
    if (!screenStream.value || !webcamStream.value) {
      throw new Error('Screen and webcam streams required for composition')
    }

    // Create video elements
    const screenVideo = document.createElement('video')
    const webcamVideo = document.createElement('video')

    screenVideo.srcObject = screenStream.value
    webcamVideo.srcObject = webcamStream.value

    await screenVideo.play()
    await webcamVideo.play()

    // Wait for metadata to load
    await new Promise<void>((resolve) => {
      if (screenVideo.videoWidth > 0) {
        resolve()
      } else {
        screenVideo.addEventListener('loadedmetadata', () => resolve(), { once: true })
      }
    })

    // Create canvas
    canvas = document.createElement('canvas')
    canvas.width = screenVideo.videoWidth
    canvas.height = screenVideo.videoHeight
    canvasCtx = canvas.getContext('2d')

    if (!canvasCtx) {
      throw new Error('Could not get canvas context')
    }

    // Animation loop to composite frames
    const drawFrame = () => {
      if (!canvasCtx || !canvas) return

      // Draw screen
      canvasCtx.drawImage(screenVideo, 0, 0, canvas.width, canvas.height)

      // Draw webcam overlay
      const dimensions = getWebcamDimensions(canvas.width, canvas.height)
      const position = getWebcamPosition(canvas.width, canvas.height, dimensions.width, dimensions.height)

      // Draw border/shadow
      canvasCtx.shadowColor = 'rgba(0, 0, 0, 0.5)'
      canvasCtx.shadowBlur = 10

      // Draw webcam
      canvasCtx.drawImage(
        webcamVideo,
        position.x,
        position.y,
        dimensions.width,
        dimensions.height
      )

      canvasCtx.shadowBlur = 0

      animationFrameId = requestAnimationFrame(drawFrame)
    }

    drawFrame()

    // Get stream from canvas
    const canvasStream = canvas.captureStream(30) // 30 FPS

    // Enable Picture-in-Picture to keep canvas rendering active
    try {
      await pip.openPip(webcamStream.value)

      // Only hide webcam overlay for entire screen (monitor) recordings
      const isEntireScreen = displaySurfaceType.value === 'monitor'
      if (isEntireScreen) {
        showWebcam.value = false
      }
    } catch (pipError) {
      console.warn('Picture-in-Picture not available:', pipError)
    }

    return canvasStream
  }

  // Stop all tracks
  const stopAllTracks = () => {
    if (screenStream.value) {
      screenStream.value.getTracks().forEach(track => track.stop())
      screenStream.value = null
    }
    if (webcamStream.value) {
      webcamStream.value.getTracks().forEach(track => track.stop())
      webcamStream.value = null
    }
    if (audioStream.value) {
      audioStream.value.getTracks().forEach(track => track.stop())
      audioStream.value = null
    }
    if (combinedStream.value) {
      combinedStream.value.getTracks().forEach(track => track.stop())
      combinedStream.value = null
    }
  }

  // Enumerate available microphones. Labels are only populated once the user has
  // granted microphone permission at least once, so callers should refresh this
  // after a successful permission prompt.
  const loadAudioDevices = async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      availableMics.value = devices.filter(d => d.kind === 'audioinput')
    } catch (err) {
      console.error('Could not enumerate audio devices:', err)
    }
  }

  // Build the microphone track constraints, pinning the user-selected device when set.
  const micConstraints = (): MediaTrackConstraints => {
    const constraints: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    }
    if (selectedAudioDeviceId.value) {
      constraints.deviceId = { exact: selectedAudioDeviceId.value }
    }
    return constraints
  }

  // Start recording with countdown
  const startRecording = async (mode: RecordingMode = 'screen', preferredDisplaySurface?: 'monitor' | 'window' | 'browser') => {
    try {
      error.value = null
      recordedChunks.value = []
      recordedVideoUrl.value = null
      recordingTime.value = 0
      recordingMode.value = mode
      tabRecordingFallback.value = false
      displaySurfaceType.value = null
      isPreparingRecording.value = true

      let videoStream: MediaStream | null = null
      let skipCountdown = false

      // Get screen stream
      if (mode === 'screen' || mode === 'both') {
        const displayMediaConstraints: DisplayMediaStreamOptions = {
          video: {
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          } as MediaTrackConstraints,
          audio: true,
        }

        if (preferredDisplaySurface) {
          (displayMediaConstraints.video as MediaTrackConstraints).displaySurface = preferredDisplaySurface
        }

        screenStream.value = await navigator.mediaDevices.getDisplayMedia(displayMediaConstraints)
        videoStream = screenStream.value

        // Check display surface type
        const videoTrack = screenStream.value.getVideoTracks()[0]
        if (videoTrack) {
          const settings = videoTrack.getSettings()
          displaySurfaceType.value = settings.displaySurface as string

          // Skip countdown for window and tab recordings
          if (settings.displaySurface === 'browser' || settings.displaySurface === 'window') {
            skipCountdown = true
          }

          if (settings.displaySurface === 'browser' && mode === 'both') {
            tabRecordingFallback.value = true
          }
        }
      }

      // Get webcam stream
      if (mode === 'webcam' || mode === 'both') {
        webcamStream.value = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: mode === 'webcam' ? micConstraints() : false,
        })

        if (mode === 'webcam') {
          videoStream = webcamStream.value
        }
      }

      // Get microphone audio if user wants it
      if (includeAudio.value && mode !== 'webcam') {
        try {
          audioStream.value = await navigator.mediaDevices.getUserMedia({
            audio: micConstraints(),
            video: false,
          })
        } catch (err) {
          console.error('Could not access microphone:', err)
        }
      }

      // For monitor + both mode, use PiP positioning approach
      if (mode === 'both' && displaySurfaceType.value === 'monitor' && webcamStream.value) {
        await pip.openPip(webcamStream.value)
        isPositioning.value = true
        isPreparingRecording.value = false
        return
      }

      // For tab/window + both mode, use canvas compositing
      if (mode === 'both' && screenStream.value && webcamStream.value) {
        combinedStream.value = await compositeStreams()
        videoStream = combinedStream.value
      }

      if (!videoStream) {
        throw new Error('Failed to get video stream')
      }

      // Collect and mix audio sources
      const audioSources: MediaStream[] = []

      if (screenStream.value && screenStream.value.getAudioTracks().length > 0) {
        audioSources.push(screenStream.value)
      }

      if (audioStream.value && audioStream.value.getAudioTracks().length > 0) {
        audioSources.push(audioStream.value)
      }

      if (mode === 'webcam' && webcamStream.value && webcamStream.value.getAudioTracks().length > 0) {
        audioSources.push(webcamStream.value)
      }

      // Mix audio sources
      const finalAudioTrack = audioMixer.mixAudioSources(audioSources)

      // Create final stream with video and mixed audio
      const finalStream = new MediaStream([
        ...videoStream.getVideoTracks(),
        ...(finalAudioTrack ? [finalAudioTrack] : [])
      ])

      // Create MediaRecorder instance (prefer MP4 for iOS compatibility)
      recordingFormat.value = getRecordingMimeType()
      mediaRecorder.value = new MediaRecorder(finalStream, { mimeType: recordingFormat.value.mimeType })

      // Handle data available event
      mediaRecorder.value.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          recordedChunks.value.push(event.data)
        }
      }

      // Handle recording stop
      mediaRecorder.value.onstop = async () => {
        const format = recordingFormat.value
        const rawBlob = new Blob(recordedChunks.value, { type: format?.mimeType || 'video/webm' })

        // Fix WebM duration metadata for proper seeking/scrubbing in preview (not needed for MP4)
        const blob = format?.isMP4 ? rawBlob : await fixWebmDuration(rawBlob, recordingTime.value * 1000)
        recordedVideoUrl.value = URL.createObjectURL(blob)
        isRecording.value = false

        // Stop recording timer
        if (recordingInterval) {
          clearInterval(recordingInterval)
          recordingInterval = null
        }

        // Stop canvas animation
        if (animationFrameId) {
          cancelAnimationFrame(animationFrameId)
          animationFrameId = null
        }

        // Cleanup
        audioMixer.cleanup()
        pip.closePip()
        stopAllTracks()
      }

      // Handle user stopping sharing via browser UI
      if (screenStream.value) {
        const videoTrack = screenStream.value.getVideoTracks()[0]
        if (videoTrack) {
          videoTrack.onended = () => {
            stopRecording()
          }
        }
      }

      // Preparation complete
      isPreparingRecording.value = false

      // Countdown before starting recording
      if (!skipCountdown) {
        countdown.value = 3
        playCountdownBeep(3)
        await new Promise<void>((resolve) => {
          const countdownInterval = setInterval(() => {
            countdown.value--
            if (countdown.value === 0) {
              clearInterval(countdownInterval)
              resolve()
            } else {
              playCountdownBeep(countdown.value)
            }
          }, 1000)
        })
        await new Promise(resolve => setTimeout(resolve, 200))
      }

      // Start recording
      mediaRecorder.value.start(1000)
      isRecording.value = true

      // Start recording timer
      recordingInterval = setInterval(() => {
        if (!isPaused.value) {
          recordingTime.value++
        }
      }, 1000)
    } catch (err: any) {
      console.error('Error starting recording:', err)

      const isCancelled = err.name === 'NotAllowedError' ||
                         err.name === 'AbortError' ||
                         err.message?.toLowerCase().includes('permission denied') ||
                         err.message?.toLowerCase().includes('user denied')

      if (!isCancelled) {
        error.value = err.message || 'Failed to start recording'
      }

      isRecording.value = false
      isPreparingRecording.value = false
      if (!isPositioning.value) {
        stopAllTracks()
      }
    }
  }

  // Finalize recording after PiP positioning
  const finalizeRecording = async () => {
    try {
      error.value = null
      recordedChunks.value = []
      recordedVideoUrl.value = null
      recordingTime.value = 0

      if (!screenStream.value) {
        throw new Error('No screen stream available')
      }

      const videoStream = screenStream.value

      // Collect and mix audio sources
      const audioSources: MediaStream[] = []

      if (screenStream.value && screenStream.value.getAudioTracks().length > 0) {
        audioSources.push(screenStream.value)
      }

      if (audioStream.value && audioStream.value.getAudioTracks().length > 0) {
        audioSources.push(audioStream.value)
      }

      const finalAudioTrack = audioMixer.mixAudioSources(audioSources)

      // Create final stream
      const finalStream = new MediaStream([
        ...videoStream.getVideoTracks(),
        ...(finalAudioTrack ? [finalAudioTrack] : [])
      ])

      // Create MediaRecorder (prefer MP4 for iOS compatibility)
      recordingFormat.value = getRecordingMimeType()
      mediaRecorder.value = new MediaRecorder(finalStream, { mimeType: recordingFormat.value.mimeType })

      mediaRecorder.value.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          recordedChunks.value.push(event.data)
        }
      }

      mediaRecorder.value.onstop = async () => {
        const format = recordingFormat.value
        const rawBlob = new Blob(recordedChunks.value, { type: format?.mimeType || 'video/webm' })

        // Fix WebM duration metadata for proper seeking/scrubbing in preview (not needed for MP4)
        const blob = format?.isMP4 ? rawBlob : await fixWebmDuration(rawBlob, recordingTime.value * 1000)
        recordedVideoUrl.value = URL.createObjectURL(blob)
        isRecording.value = false

        if (recordingInterval) {
          clearInterval(recordingInterval)
          recordingInterval = null
        }

        audioMixer.cleanup()
        pip.closePip()
        stopAllTracks()
      }

      if (screenStream.value) {
        const videoTrack = screenStream.value.getVideoTracks()[0]
        if (videoTrack) {
          videoTrack.onended = () => {
            stopRecording()
          }
        }
      }

      isPositioning.value = false

      // Countdown
      countdown.value = 3
      playCountdownBeep(3)
      await new Promise<void>((resolve) => {
        const countdownInterval = setInterval(() => {
          countdown.value--
          if (countdown.value === 0) {
            clearInterval(countdownInterval)
            resolve()
          } else {
            playCountdownBeep(countdown.value)
          }
        }, 1000)
      })
      await new Promise(resolve => setTimeout(resolve, 200))

      // Start recording
      mediaRecorder.value.start(1000)
      isRecording.value = true

      recordingInterval = setInterval(() => {
        if (!isPaused.value) {
          recordingTime.value++
        }
      }, 1000)

      return true
    } catch (err: any) {
      console.error('Error finalizing recording:', err)

      const isCancelled = err.name === 'NotAllowedError' ||
                         err.name === 'AbortError' ||
                         err.message?.toLowerCase().includes('permission denied') ||
                         err.message?.toLowerCase().includes('user denied')

      if (!isCancelled) {
        error.value = err.message || 'Failed to start recording'
      }

      isRecording.value = false
      isPositioning.value = false
      return false
    }
  }

  // Cancel positioning
  const cancelPositioning = () => {
    pip.closePip()
    stopAllTracks()
    isPositioning.value = false
    displaySurfaceType.value = null
  }

  // Stop recording
  const stopRecording = () => {
    if (mediaRecorder.value && isRecording.value) {
      mediaRecorder.value.stop()
    }
  }

  // Pause recording
  const pauseRecording = () => {
    if (mediaRecorder.value && isRecording.value && !isPaused.value && mediaRecorder.value.state === 'recording') {
      mediaRecorder.value.pause()
      isPaused.value = true
    }
  }

  // Resume recording
  const resumeRecording = () => {
    if (mediaRecorder.value && isRecording.value && isPaused.value && mediaRecorder.value.state === 'paused') {
      mediaRecorder.value.resume()
      isPaused.value = false
    }
  }

  // Upload to S3
  const uploadToS3 = async (audience: VideoAudience = { visibility: 'private' }) => {
    try {
      await upload.uploadRecording(recordedChunks.value, recordedVideoUrl.value!, recordingTime.value, recordingFormat.value, audience)
      return true
    } catch (err: any) {
      error.value = err.message || 'Failed to upload video'
      return false
    }
  }

  // Download recording
  const downloadRecording = () => {
    if (!recordedVideoUrl.value) return

    const format = recordingFormat.value
    const extension = format?.isMP4 ? 'mp4' : 'webm'
    const a = document.createElement('a')
    a.href = recordedVideoUrl.value
    a.download = `screen-recording-${Date.now()}.${extension}`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  // Reset/clear recording
  const resetRecording = () => {
    if (recordedVideoUrl.value) {
      URL.revokeObjectURL(recordedVideoUrl.value)
    }
    recordedVideoUrl.value = null
    recordedChunks.value = []
    recordingTime.value = 0
    error.value = null
    tabRecordingFallback.value = false
    displaySurfaceType.value = null
    isPositioning.value = false
    recordingFormat.value = null
    upload.resetUpload()
  }

  // Format recording time as MM:SS
  const formattedTime = computed(() => {
    const minutes = Math.floor(recordingTime.value / 60)
    const seconds = recordingTime.value % 60
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
  })

  // Cleanup on unmount
  onUnmounted(() => {
    stopAllTracks()
    if (recordedVideoUrl.value) {
      URL.revokeObjectURL(recordedVideoUrl.value)
    }
    if (recordingInterval) {
      clearInterval(recordingInterval)
    }
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId)
    }
    audioMixer.cleanup()
    pip.closePip()
  })

  // Computed: Get recording size
  const recordingSize = computed(() => {
    if (recordedChunks.value.length === 0) return 0
    return recordedChunks.value.reduce((total, chunk) => total + chunk.size, 0)
  })

  return {
    // State
    isSupported,
    isRecording,
    isPaused,
    recordedVideoUrl,
    error,
    recordingTime,
    formattedTime,
    recordingSize,
    isUploading: upload.isUploading,
    uploadProgress: upload.uploadProgress,
    uploadProgressNumber: upload.uploadProgressNumber,
    shareToken: upload.shareToken,
    shareableLink: upload.shareableLink,
    countdown,
    isPreparingRecording,
    tabRecordingFallback,
    isPipActive: pip.isPipActive,
    displaySurfaceType,
    isPositioning,
    recordingFormat,

    // Recording settings
    recordingMode,
    showWebcam,
    includeAudio,
    selectedAudioDeviceId,
    availableMics,

    // Streams
    webcamStream,

    // Methods
    loadAudioDevices,
    startRecording,
    finalizeRecording,
    cancelPositioning,
    stopRecording,
    pauseRecording,
    resumeRecording,
    uploadToS3,
    downloadRecording,
    resetRecording,
  }
}

import React, { useRef, useEffect, useImperativeHandle, forwardRef, useState } from 'react';
import { audioService } from '../services/audioService';

export interface CameraHandle {
  capture: (lowRes?: boolean, silent?: boolean) => Promise<string | null>;
  isReady: () => boolean;
}

const Camera = forwardRef<CameraHandle>((_, ref) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isCameraReady, setIsCameraReady] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    let mounted = true;

    const startCamera = async () => {
      audioService.speak("Opening camera...");
      
      try {
        let mediaStream: MediaStream;
        
        // 1. Correct Stream Initialization with Fallback
        try {
            mediaStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: { exact: "environment" } },
                audio: false
            });
        } catch (err) {
            console.warn("Exact environment facing mode failed, trying loose constraint.");
            try {
                mediaStream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: "environment" },
                    audio: false
                });
            } catch (err2) {
                console.warn("Environment camera failed, using default.");
                mediaStream = await navigator.mediaDevices.getUserMedia({
                    video: true,
                    audio: false
                });
            }
        }

        if (!mounted) {
            mediaStream.getTracks().forEach(track => track.stop());
            return;
        }

        streamRef.current = mediaStream;

        if (videoRef.current) {
            videoRef.current.srcObject = mediaStream;
            
            // 2. Wait Until Video is Playing & 3. Metadata Loaded
            videoRef.current.onloadedmetadata = async () => {
                if (!mounted || !videoRef.current) return;
                try {
                    await videoRef.current.play();
                    
                    // 5. Auto-Focus Simulation Delay
                    // Give the hardware a moment to settle exposure and focus
                    await new Promise(resolve => setTimeout(resolve, 800));
                    
                    if (mounted) {
                        setIsCameraReady(true);
                        audioService.speak("Camera ready.");
                    }
                } catch (e) {
                    console.error("Video play error:", e);
                    audioService.speak("Camera error. Please restart app.");
                }
            };
        }

      } catch (err) {
        console.error("Camera Init Error:", err);
        if (mounted) audioService.speak("Camera error: please check permissions.");
      }
    };

    startCamera();

    return () => {
      mounted = false;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  useImperativeHandle(ref, () => ({
    isReady: () => isCameraReady,
    
    // 6. Proper Capture Flow
    capture: async (lowRes = false, silent = false) => {
        if (!isCameraReady || !videoRef.current || !canvasRef.current) {
            if (!silent) audioService.speak("Camera is loading...");
            return null;
        }

        const video = videoRef.current;
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        
        if (!ctx) return null;

        // 3. Ensure Canvas Has Correct Dimensions
        if (video.videoWidth === 0 || video.videoHeight === 0) {
             return null; 
        }

        const scale = lowRes ? 0.5 : 1.0;
        canvas.width = video.videoWidth * scale;
        canvas.height = video.videoHeight * scale;

        // 7. Add Spoken Feedback
        if (!silent) audioService.speak("Capturing image...");

        // g. Draw video frame to canvas
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        // 4. Fix Blank Image Error (Brightness Check)
        const checkBrightness = () => {
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const data = imageData.data;
            let sum = 0;
            // Sample pixels for speed (every 16th byte = every 4th pixel)
            for(let i=0; i<data.length; i+=16) { 
                sum += (data[i] + data[i+1] + data[i+2]) / 3;
            }
            return sum / (data.length / 16);
        };

        let brightness = checkBrightness();

        if (brightness < 15) { // Threshold for "black" or very dark
             if (!silent) audioService.speak("The image appears to be black. Trying again...");
             
             // Wait for exposure adjustment
             await new Promise(r => setTimeout(r, 600));
             ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
             brightness = checkBrightness();
             
             if (brightness < 15) {
                 if (!silent) audioService.speak("Image is still too dark. Please ensure camera is not covered.");
                 // We return the image anyway, Gemini might handle it or we could return null
             }
        }

        if (!silent) audioService.speak("Image captured. Processing...");

        // h. Convert to base64
        return canvas.toDataURL('image/jpeg', lowRes ? 0.5 : 0.8);
    }
  }));

  return (
    <div className="hidden">
      <video 
        ref={videoRef} 
        autoPlay 
        playsInline 
        muted 
        style={{ display: 'none' }} 
      />
      <canvas ref={canvasRef} style={{ display: 'none' }} />
    </div>
  );
});

export default Camera;
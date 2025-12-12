import React from 'react';
import { AppState } from '../types';

interface AudioRingProps {
  state: AppState;
  size: number;
}

const AudioRing: React.FC<AudioRingProps> = ({ state, size }) => {
  const isListening = state === AppState.LISTENING;
  const isSpeaking = state === AppState.SPEAKING;
  const isProcessing = state === AppState.PROCESSING_INTENT || state === AppState.ANALYZING || state === AppState.CAPTURING;
  const isIdle = !isListening && !isSpeaking && !isProcessing;

  // Calculate dynamic styles based on state
  let opacity = 0.2;
  let scale = 1.0;
  let animationSpeed = '20s'; // Default slow

  if (isListening) {
      opacity = 0.7;
      scale = 1.1;
      animationSpeed = '8s';
  } else if (isSpeaking) {
      opacity = 0.8;
      scale = 1.2;
      animationSpeed = '12s';
  } else if (isProcessing) {
      opacity = 0.6;
      scale = 1.05;
      animationSpeed = '4s'; // Fast rotation for thinking
  }

  // Base diameter for the glow blobs (slightly larger than button)
  // Button is approx 288px (w-72). We want the glow to extend beyond.
  const blobSize = size * 0.85;

  return (
    <div 
      className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 pointer-events-none flex items-center justify-center z-0" 
      style={{ width: size, height: size }}
    >
      <style>{`
        @keyframes blob-spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes blob-wave {
          0% { border-radius: 60% 40% 30% 70% / 60% 30% 70% 40%; }
          50% { border-radius: 30% 60% 70% 40% / 50% 60% 30% 60%; }
          100% { border-radius: 60% 40% 30% 70% / 60% 30% 70% 40%; }
        }
        @keyframes blob-pulse-listen {
          0% { transform: scale(1); opacity: 0.6; }
          50% { transform: scale(1.15); opacity: 0.8; }
          100% { transform: scale(1); opacity: 0.6; }
        }
        @keyframes blob-breathe-speak {
            0% { transform: scale(1); opacity: 0.7; }
            50% { transform: scale(1.25); opacity: 0.9; }
            100% { transform: scale(1); opacity: 0.7; }
        }
        
        .wavy-glow-container {
            position: absolute;
            display: flex;
            align-items: center;
            justify-content: center;
            width: 100%;
            height: 100%;
        }

        .blob-layer {
           position: absolute;
           width: 100%;
           height: 100%;
           border-radius: 50%; /* Fallback */
           mix-blend-mode: multiply;
           filter: blur(40px); /* Soft glow */
           transition: all 1.5s ease-in-out;
        }

        /* Animation Classes */
        .anim-idle {
            animation: blob-spin 20s linear infinite, blob-wave 10s ease-in-out infinite;
        }
        .anim-listening {
            animation: blob-spin 8s linear infinite, blob-wave 5s ease-in-out infinite, blob-pulse-listen 2s ease-in-out infinite;
        }
        .anim-speaking {
            animation: blob-spin 15s linear infinite, blob-wave 8s ease-in-out infinite, blob-breathe-speak 3s ease-in-out infinite;
        }
        .anim-processing {
            animation: blob-spin 3s linear infinite, blob-wave 3s ease-in-out infinite;
        }

      `}</style>

      {/* Inner Container for scaling/positioning */}
      <div 
        className="wavy-glow-container"
        style={{ width: blobSize, height: blobSize }}
      >
          {/* Layer 1: Lavender/Teal */}
          <div 
            className={`blob-layer bg-gradient-to-br from-violet-400 to-teal-300 
                ${isListening ? 'anim-listening' : isSpeaking ? 'anim-speaking' : isProcessing ? 'anim-processing' : 'anim-idle'}
            `}
            style={{ opacity: opacity }}
          />

          {/* Layer 2: Pink/Blue (Offset/Reverse) */}
          <div 
            className={`blob-layer bg-gradient-to-tr from-pink-400 to-blue-400 
                ${isListening ? 'anim-listening' : isSpeaking ? 'anim-speaking' : isProcessing ? 'anim-processing' : 'anim-idle'}
            `}
            style={{ 
                opacity: opacity * 0.8, 
                animationDirection: 'reverse', 
                animationDelay: '-2s',
                transform: 'scale(0.9)'
            }}
          />
      </div>
    </div>
  );
};

export default AudioRing;
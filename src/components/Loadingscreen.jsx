import { useState, useEffect } from 'react'

export default function LoadingScreen({ onComplete }) {
  const [phase, setPhase] = useState(0)
  // Phases: 0=black, 1=logo fade in, 2=skynet text, 3=subtitle, 4=progress, 5=fade out
  const [progress, setProgress] = useState(0)
  const [glitchText, setGlitchText] = useState('')
  const [fadeOut, setFadeOut] = useState(false)

  const skynetFull = 'SkyNet'
  const glitchChars = '!@#$%^&*01'

  // Phase timing — longer, more cinematic pacing
  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 500),      // Logo fade in
      setTimeout(() => setPhase(2), 2200),      // Start SkyNet text
      setTimeout(() => setPhase(3), 3800),      // Subtitle
      setTimeout(() => setPhase(4), 4800),      // Progress bar
    ]
    return () => timers.forEach(clearTimeout)
  }, [])

  // Glitch typing effect for "SkyNet"
  useEffect(() => {
    if (phase < 2) return
    
    let currentIndex = 0
    let glitchCount = 0
    
    const interval = setInterval(() => {
      if (currentIndex >= skynetFull.length) {
        setGlitchText(skynetFull)
        clearInterval(interval)
        return
      }

      // Show glitch characters before revealing real character
      if (glitchCount < 4) {
        const revealed = skynetFull.substring(0, currentIndex)
        const glitchChar = glitchChars[Math.floor(Math.random() * glitchChars.length)]
        const remaining = Array.from({ length: skynetFull.length - currentIndex - 1 }, () => 
          Math.random() > 0.7 ? glitchChars[Math.floor(Math.random() * glitchChars.length)] : ' '
        ).join('')
        setGlitchText(revealed + glitchChar + remaining)
        glitchCount++
      } else {
        currentIndex++
        glitchCount = 0
        setGlitchText(skynetFull.substring(0, currentIndex))
      }
    }, 60)

    return () => clearInterval(interval)
  }, [phase])

  // Progress bar — slower fill
  useEffect(() => {
    if (phase < 4) return

    const interval = setInterval(() => {
      setProgress(prev => {
        if (prev >= 100) {
          clearInterval(interval)
          // Pause at 100% before fade out
          setTimeout(() => setFadeOut(true), 600)
          setTimeout(() => onComplete(), 1200)
          return 100
        }
        // Slower, more deliberate progress with pauses
        const increment = prev < 15 ? 2 : prev < 40 ? 1.5 : prev < 65 ? 2 : prev < 85 ? 1.5 : 3
        return Math.min(prev + increment, 100)
      })
    }, 60)

    return () => clearInterval(interval)
  }, [phase, onComplete])

  return (
    <div className={`fixed inset-0 z-[100] bg-gray-950 flex flex-col items-center justify-center transition-opacity duration-700 ${fadeOut ? 'opacity-0' : 'opacity-100'}`}>
      
      {/* Animated background grid */}
      <div className="absolute inset-0 overflow-hidden opacity-10">
        <div className="absolute inset-0" style={{
          backgroundImage: `linear-gradient(rgba(0, 255, 170, 0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(0, 255, 170, 0.1) 1px, transparent 1px)`,
          backgroundSize: '40px 40px',
          animation: 'gridScroll 20s linear infinite'
        }} />
      </div>

      {/* Scanning line effect */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute left-0 right-0 h-px bg-gradient-to-r from-transparent via-skynet-accent/20 to-transparent"
          style={{ animation: 'scanLine 4s linear infinite' }} />
      </div>

      {/* Radial glow behind content */}
      <div className={`absolute w-[600px] h-[600px] rounded-full transition-opacity ${phase >= 1 ? 'opacity-100' : 'opacity-0'}`}
        style={{
          transitionDuration: '1500ms',
          background: 'radial-gradient(circle, rgba(0, 255, 170, 0.06) 0%, rgba(0, 255, 170, 0.02) 40%, transparent 70%)'
        }}
      />

      {/* Main content */}
      <div className="relative z-10 flex flex-col items-center">
        
        {/* Skybolt Logo — white version directly on dark bg */}
        <div className={`transition-all ease-out ${phase >= 1 ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-6 scale-90'}`}
          style={{ transitionDuration: '1200ms' }}>
          <img 
            src="/skybolt-logo-white.png" 
            alt="Skybolt Aerospace Fasteners" 
            className="h-14 w-auto mb-10"
            style={{
              filter: phase >= 2 ? 'drop-shadow(0 0 30px rgba(0, 255, 170, 0.15))' : 'none',
              transition: 'filter 1s ease'
            }}
          />
        </div>

        {/* Horizontal line accent */}
        <div className={`flex items-center gap-3 mb-8 transition-all ${phase >= 2 ? 'opacity-100' : 'opacity-0'}`}
          style={{ width: phase >= 2 ? '20rem' : '0', transitionDuration: '1000ms' }}>
          <div className="flex-1 h-px bg-gradient-to-r from-transparent via-skynet-accent/50 to-transparent" />
          <div className="w-1.5 h-1.5 bg-skynet-accent rounded-full animate-pulse" />
          <div className="flex-1 h-px bg-gradient-to-r from-transparent via-skynet-accent/50 to-transparent" />
        </div>

        {/* SkyNet Title — Glitch Effect */}
        <div className={`transition-opacity duration-500 ${phase >= 2 ? 'opacity-100' : 'opacity-0'}`}>
          <h1 className="text-7xl font-bold tracking-widest text-center font-mono">
            {glitchText.split('').map((char, i) => (
              <span 
                key={i}
                className={char === skynetFull[i] ? 'text-white' : 'text-skynet-accent'}
                style={{
                  textShadow: char === skynetFull[i] 
                    ? '0 0 30px rgba(255,255,255,0.2)' 
                    : '0 0 25px rgba(0, 255, 170, 0.8)',
                  transition: 'color 0.1s, text-shadow 0.1s'
                }}
              >
                {char}
              </span>
            ))}
          </h1>
        </div>

        {/* Subtitle */}
        <div className={`transition-all mt-4 ${phase >= 3 ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-3'}`}
          style={{ transitionDuration: '1000ms' }}>
          <p className="text-gray-500 text-sm tracking-[0.35em] uppercase">
            Manufacturing Execution System
          </p>
        </div>

        {/* Progress Section */}
        <div className={`mt-14 w-80 transition-all ${phase >= 4 ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'}`}
          style={{ transitionDuration: '800ms' }}>
          {/* Progress bar */}
          <div className="h-[3px] bg-gray-800/80 rounded-full overflow-hidden mb-4">
            <div 
              className="h-full rounded-full transition-all duration-75 ease-linear"
              style={{ 
                width: `${progress}%`,
                background: 'linear-gradient(90deg, #00FFAA, #00CC88, #00FFAA)',
                boxShadow: '0 0 12px rgba(0, 255, 170, 0.5), 0 0 4px rgba(0, 255, 170, 0.8)'
              }}
            />
          </div>
          
          {/* Status text */}
          <div className="flex justify-between items-center">
            <p className="text-gray-600 text-xs font-mono tracking-wide">
              {progress < 15 && 'Establishing secure connection...'}
              {progress >= 15 && progress < 30 && 'Authenticating credentials...'}
              {progress >= 30 && progress < 50 && 'Loading machine fleet...'}
              {progress >= 50 && progress < 65 && 'Syncing work orders...'}
              {progress >= 65 && progress < 80 && 'Initializing kiosk network...'}
              {progress >= 80 && progress < 95 && 'Calibrating dashboards...'}
              {progress >= 95 && progress < 100 && 'All systems nominal'}
              {progress >= 100 && (
                <span className="text-skynet-accent">● System Online</span>
              )}
            </p>
            <p className="text-gray-600 text-xs font-mono tabular-nums">{Math.round(progress)}%</p>
          </div>
        </div>
      </div>

      {/* Bottom branding */}
      <div className={`absolute bottom-8 transition-all ${phase >= 3 ? 'opacity-30' : 'opacity-0'}`}
        style={{ transitionDuration: '1000ms' }}>
        <p className="text-gray-600 text-[10px] tracking-[0.5em] uppercase">
          Skybolt Aeromotive Corp &middot; Leesburg, FL
        </p>
      </div>

      {/* CSS animations */}
      <style>{`
        @keyframes gridScroll {
          0% { transform: translate(0, 0); }
          100% { transform: translate(40px, 40px); }
        }
        @keyframes scanLine {
          0% { top: -2px; opacity: 0; }
          10% { opacity: 1; }
          90% { opacity: 1; }
          100% { top: 100%; opacity: 0; }
        }
      `}</style>
    </div>
  )
}
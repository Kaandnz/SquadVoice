import { useId } from 'react';

interface BrandLogoProps {
  size?: number;
  className?: string;
}

export function BrandLogo({ size = 46, className = '' }: BrandLogoProps) {
  const uid = useId().replace(/:/g, '');
  const bgId = `sv-bg-${uid}`;
  const glowTopId = `sv-gt-${uid}`;
  const glowCyanId = `sv-gc-${uid}`;
  const rimId = `sv-rim-${uid}`;
  const headsetId = `sv-hs-${uid}`;
  const waveId = `sv-wv-${uid}`;
  const shadowId = `sv-sh-${uid}`;
  const waveGlowId = `sv-wg-${uid}`;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 512 512"
      width={size}
      height={size}
      fill="none"
      className={`brand-logo-svg ${className}`.trim()}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={bgId} x1="40" y1="20" x2="472" y2="492" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#6470FF" />
          <stop offset="46%" stopColor="#4338CA" />
          <stop offset="100%" stopColor="#1B1654" />
        </linearGradient>
        <radialGradient id={glowTopId} cx="0.24" cy="0.14" r="0.62">
          <stop offset="0%" stopColor="#A5B4FC" stopOpacity="0.28" />
          <stop offset="100%" stopColor="#6366F1" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={glowCyanId} cx="0.80" cy="0.88" r="0.58">
          <stop offset="0%" stopColor="#22D3EE" stopOpacity="0.30" />
          <stop offset="100%" stopColor="#22D3EE" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={rimId} x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.30" />
          <stop offset="50%" stopColor="#FFFFFF" stopOpacity="0.05" />
          <stop offset="100%" stopColor="#67E8F9" stopOpacity="0.24" />
        </linearGradient>
        <linearGradient
          id={headsetId}
          x1="256"
          y1="96"
          x2="256"
          y2="404"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="100%" stopColor="#E2E8FF" />
        </linearGradient>
        <linearGradient
          id={waveId}
          x1="256"
          y1="204"
          x2="256"
          y2="348"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#A5F3FC" />
          <stop offset="50%" stopColor="#38BDF8" />
          <stop offset="100%" stopColor="#0EA5E9" />
        </linearGradient>
        <filter id={shadowId} x="-15%" y="-15%" width="130%" height="135%">
          <feDropShadow dx="0" dy="10" stdDeviation="12" floodColor="#0F0B3B" floodOpacity="0.46" />
        </filter>
        <filter id={waveGlowId} x="-30%" y="-25%" width="160%" height="150%">
          <feDropShadow dx="0" dy="4" stdDeviation="10" floodColor="#38BDF8" floodOpacity="0.55" />
        </filter>
      </defs>

      <rect width="512" height="512" rx="116" fill={`url(#${bgId})`} />
      <rect width="512" height="512" rx="116" fill={`url(#${glowTopId})`} />
      <rect width="512" height="512" rx="116" fill={`url(#${glowCyanId})`} />
      <rect x="6" y="6" width="500" height="500" rx="110" stroke={`url(#${rimId})`} strokeWidth="4" />

      <g transform="translate(0, -10)" filter={`url(#${shadowId})`}>
        <path
          d="M110 264C110 176 174 108 256 108C338 108 402 176 402 264C402 273 395 280 386 280C377 280 370 273 370 264C370 195 320 142 256 142C192 142 142 195 142 264C142 273 135 280 126 280C117 280 110 273 110 264Z"
          fill={`url(#${headsetId})`}
        />
        <rect x="142" y="248" width="22" height="88" rx="11" fill="#C7D2FE" fillOpacity="0.88" />
        <rect x="96" y="230" width="54" height="124" rx="27" fill={`url(#${headsetId})`} />
        <rect x="348" y="248" width="22" height="88" rx="11" fill="#C7D2FE" fillOpacity="0.88" />
        <rect x="362" y="230" width="54" height="124" rx="27" fill={`url(#${headsetId})`} />
        <path
          d="M388 334C388 378 354 402 296 402H272"
          stroke={`url(#${headsetId})`}
          strokeWidth="16"
          strokeLinecap="round"
        />
        <rect x="232" y="390" width="52" height="24" rx="12" fill={`url(#${headsetId})`} />
      </g>

      <g transform="translate(0, -10)" filter={`url(#${waveGlowId})`}>
        <rect x="196" y="252" width="26" height="80" rx="13" fill={`url(#${waveId})`} />
        <rect x="243" y="214" width="26" height="138" rx="13" fill={`url(#${waveId})`} />
        <rect x="290" y="240" width="26" height="98" rx="13" fill={`url(#${waveId})`} />
      </g>
    </svg>
  );
}

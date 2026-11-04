import React from 'react';

interface WindowIconProps {
  size?: number;
  strokeWidth?: number;
  className?: string;
}

// Classic window symbol: a frame divided into four panes.
export const WindowIcon: React.FC<WindowIconProps> = ({
  size = 24,
  strokeWidth = 2,
  className,
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <rect x="4" y="3" width="16" height="18" rx="1" />
    <path d="M12 3v18" />
    <path d="M4 12h16" />
  </svg>
);

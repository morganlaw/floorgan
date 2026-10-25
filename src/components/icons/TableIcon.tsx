import React from 'react';

/** Lucide-style furniture table icon (tabletop with legs), replaces the spreadsheet-looking `Table` glyph. */
export const TableIcon: React.FC<{ size?: number; strokeWidth?: number; className?: string }> = ({
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
    {/* Tabletop */}
    <rect x="2" y="6" width="20" height="3" rx="1" />
    {/* Legs */}
    <path d="M5 9v10" />
    <path d="M19 9v10" />
    {/* Apron / stretcher */}
    <path d="M5 13h14" />
  </svg>
);

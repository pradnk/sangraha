import { ImageResponse } from 'next/og';

/**
 * The iOS home-screen icon.
 *
 * Generated rather than committed as a binary so the mark has one definition —
 * change the SVG and this follows. iOS ignores SVG favicons and rounds the
 * corners itself, so this is drawn square and edge to edge.
 */
export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#1559ab',
        }}
      >
        <svg width="180" height="180" viewBox="0 0 64 64">
          <circle cx="32" cy="13" r="4.5" fill="#fff" opacity="0.55" />
          <circle cx="51" cy="32" r="4.5" fill="#fff" opacity="0.7" />
          <circle cx="32" cy="51" r="4.5" fill="#fff" opacity="0.85" />
          <circle cx="13" cy="32" r="4.5" fill="#fff" opacity="0.7" />
          <circle cx="32" cy="32" r="10" fill="#fff" />
        </svg>
      </div>
    ),
    size,
  );
}

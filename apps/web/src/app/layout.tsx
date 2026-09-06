import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  // A template rather than a fixed title: an organisation's own screens should
  // read "School attendance · Sangraha", not the other way round.
  title: { default: 'Sangraha', template: '%s · Sangraha' },
  description:
    'Sangraha — data collection for the social sector. NGOs define what they collect, field workers capture it on any phone, and it lands ready to analyse.',
  applicationName: 'Sangraha',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Zoom stays enabled. Pinch-to-zoom is a genuine accessibility tool for
  // anyone with low vision, and disabling it to make a layout behave is not a
  // trade this product makes.
  maximumScale: 5,
  themeColor: '#1d6fd0',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

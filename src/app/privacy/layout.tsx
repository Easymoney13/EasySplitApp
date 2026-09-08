import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Privacy Policy | EasySplit',
  description: 'How EasySplit processes receipt photos, account information, and shared bills, and how to control cloud scanning.',
  openGraph: { title: 'Privacy Policy | EasySplit', url: '/privacy' },
};

export default function PrivacyLayout({ children }: { children: ReactNode }) {
  return children;
}

# BillSplit (EasySplit)

BillSplit is a modern, real-time, collaborative web application built to make sharing and splitting bills with friends completely seamless. Snap a picture of a receipt, invite your friends with a QR code, claim your items in real-time, and let the app minimize the math to show exactly who owes what.

---

## Features

- **AI-Powered Receipt Scanning**: Snap a photo or upload a receipt to automatically parse items, categories, and prices using the Google Gemini API (with a client-side Tesseract OCR fallback).
- **Real-Time Collaboration**: Share a session link or QR code with friends. Everyone sees item claims and status updates instantly via WebSockets.
- **Group Management**: Track ongoing shared expenses with custom groups.
- **Smart Debt Minimization**: Includes an integrated simplification algorithm that calculates the absolute minimum number of transactions needed to settle all balances.
- **Bilingual & RTL Support**: Fully localized in English and Hebrew, including responsive Right-to-Left (RTL) layouts.
- **Firebase Google Sign-In**: Fast and secure authentication utilizing Google OAuth, optimized for both desktop popups and mobile redirects.
- **Modern Design**: Built with Next.js and Tailwind CSS featuring a fluid, responsive dark/light mode UI and micro-interactions.

---

## Tech Stack

- **Frontend**: Next.js 14 (React, App Router, TypeScript)
- **Styling**: Tailwind CSS, Lucide Icons
- **Backend & Real-Time**: Node.js, Express, WebSockets (ws)
- **Authentication**: Firebase Client SDK & Firebase Admin SDK (JWT Validation)
- **AI / OCR**: Google Gemini Vision API, Tesseract.js
- **Database**: Cloud Firestore in production. `db.json` is retained temporarily
  only as a protected migration source and for explicit local tests.

Before retiring any local runtime database, run `npm run verify:firestore` with
Firebase Admin credentials. It compares data without printing personal records
or modifying `db.json`. Use `npm run cutover:firestore` for a read-only dry-run;
`-- --apply` creates only a verified immutable snapshot and never overwrites
operational Firestore documents. The legacy boot migration is disabled.

---

## Getting Started

### Prerequisites

- Node.js (v18.0.0 or higher)
- A Firebase Project (with Google Auth enabled)
- A Google Gemini API Key (optional, can be input by users in Settings)

### Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/Easymoney13/BillSpltApp.git
   cd BillSpltApp

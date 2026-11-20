# Screen Rhythm

### Stay in your rhythm.

Screen Rhythm is a desktop screen-wellness companion that uses Presage SmartSpectra's real-time face analysis to observe blinking activity during computer sessions and encourage people to take occasional screen breaks.

Instead of simply counting screen time, Screen Rhythm makes screen habits more visible through live blink activity, session tracking and gentle reminders.

## The problem

People spend hours looking at screens, often without noticing how long they have been sitting in front of them.

Existing screen-time tools mostly track duration. They rarely make the experience of a screen session interactive or help users become more aware of their own patterns.

Screen Rhythm explores a different approach: using real-time camera-based signals to make screen habits easier to notice.

## What Screen Rhythm does

- **Real-time blink tracking:** Uses Presage SmartSpectra face-analysis readings to count detected blinks during an active session.
- **Live blink dashboard:** Displays blink counts, face-data duration and a rolling 60-second activity timeline.
- **Gentle break reminders:** Suggests short screen breaks based on session duration, with cautious use of changes in an individual's blink activity.
- **Interactive break experience:** Users can take a short break, dismiss a suggestion or adjust reminder intervals.
- **Camera diagnostics:** Displays camera frame rate, SDK input and processing rates, and other pipeline information.
- **Privacy-conscious processing:** Camera access requires user consent and is used during active sessions. Video is processed locally and is not recorded or saved.

## Built with

- Electron
- JavaScript
- HTML and CSS
- Node.js
- Presage SmartSpectra Node SDK

## How it works

1. The user opens Screen Rhythm and gives camera consent.
2. The user starts a screen session.
3. The application activates the camera and connects to Presage SmartSpectra.
4. SmartSpectra provides real-time face-analysis readings.
5. Screen Rhythm processes blink-detection events and updates the dashboard.
6. The reminder system monitors session duration and available blink activity.
7. The user receives gentle suggestions to take breaks.

## Privacy and data handling

Privacy is an important part of Screen Rhythm.

- Camera access is initiated only after the user starts a session.
- Video is processed live on the user's computer.
- Camera footage is not recorded or saved.
- The application does not require a user account.
- The SmartSpectra API key is stored in a local `.env` file and must never be committed to the public repository.

Screen Rhythm is a screen-wellness companion, not a medical application. It does not diagnose conditions or measure fatigue, stress, eye strain or medical health.

## Installation and setup

### Requirements

- Windows desktop computer
- Node.js and npm
- Webcam
- Presage SmartSpectra API access

### Setup

1. Clone the repository:

   ```bash
   git clone YOUR_GITHUB_REPOSITORY_URL
   ```

2. Enter the project directory:

   ```bash
   cd "SCREEN RHYTHM"
   ```

3. Install dependencies:

   ```bash
   npm install
   ```

4. Create a local `.env` file and configure your SmartSpectra API key using the environment variable expected by the application.

5. Start the application:

   ```bash
   npm start
   ```

   On Windows PowerShell, use:

   ```powershell
   npm.cmd start
   ```

Never publish your `.env` file or API key.

## Running tests

Run the automated tests with:

```powershell
npm.cmd test
```

The current automated test suite includes blink-detector and break-reminder tests.

## Current development status

Implemented:
- Electron desktop application.
- SmartSpectra integration.
- Camera consent and live preview.
- Real blink-event detection.
- Live blink activity dashboard.
- 60-second blink timeline.
- Configurable break reminders.
- Frame-pipeline diagnostics.
- Dark charcoal and golden-yellow interface.

Session history and final release packaging remain planned work.

## Performance note

The application targets at least 25 FPS for SmartSpectra processing. Actual performance depends on the camera, computer and frame-delivery pipeline.

During development, a live webcam test sustained a session of more than three minutes, with approximately 24 FPS reported by SmartSpectra. Performance still requires further validation.

## Project vision

Screen Rhythm aims to make people more aware of their screen habits through technology that is useful, interactive and easy to understand.

**Stay in your rhythm.**
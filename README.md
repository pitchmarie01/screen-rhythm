# Screen Rhythm

### Stay in your rhythm.

Screen Rhythm is a desktop screen-wellness companion that integrates Presage SmartSpectra's real-time face analysis to observe blinking activity during computer sessions and encourage people to take occasional screen breaks.

Instead of simply counting screen time, Screen Rhythm makes screen habits more visible through live blink activity, session tracking, and gentle reminders.

## The problem

People spend hours looking at screens, often without noticing how long they have been sitting in front of them.

Existing screen-time tools mostly track duration. They rarely make the experience of a screen session interactive or help users become more aware of their own patterns.

Screen Rhythm explores a different approach: using real-time camera-based signals to make screen habits easier to notice.

## What Screen Rhythm does

- **Real-time blink tracking:** Integrates Presage SmartSpectra face-analysis readings with Screen Rhythm's own blink-tracking logic to detect and count blink events.
- **Live blink dashboard:** Displays blink counts, session information, and a rolling 60-second blink activity timeline.
- **Gentle break reminders:** Suggests short screen breaks based on session duration.
- **Interactive break experience:** Users can take a short break, dismiss a suggestion, or adjust reminder intervals.
- **Camera diagnostics:** Displays camera frame rate, SDK input and processing rates, and other frame-pipeline information.
- **Privacy-conscious processing:** Camera access requires user permission. Video is processed locally and is not recorded or saved by the application.

## Built with

- Electron
- JavaScript
- HTML and CSS
- Node.js
- Presage SmartSpectra Node SDK

## How it works

1. The user opens Screen Rhythm and grants camera permission.
2. The user starts a screen session.
3. The application activates the camera and connects to Presage SmartSpectra.
4. SmartSpectra provides real-time face-analysis readings.
5. Screen Rhythm uses its own blink-tracking logic to detect and count blink events.
6. The dashboard updates with blink activity, session information, and processing diagnostics.
7. The reminder system monitors session duration and suggests occasional breaks.

## Privacy and data handling

Privacy is an important part of Screen Rhythm.

- Camera access requires user permission and is used during active sessions.
- Video frames are processed live on the user's computer.
- Camera footage is not recorded or saved by the application.
- Session summaries, including session information and blink counts, are stored locally.
- The application does not require a user account.
- SmartSpectra SDK telemetry is explicitly disabled in the application configuration using `enableTelemetry: false`.
- The SmartSpectra API key is stored in a local `.env` file and must never be committed to the public repository.

Screen Rhythm is a screen-wellness companion, not a medical application. It does not diagnose conditions or measure fatigue, stress, eye strain, attention, or medical health.

## Installation and setup

### Requirements

- Windows desktop computer
- Node.js and npm
- Webcam
- Presage SmartSpectra API access

### Setup

1. Clone the repository:

   ```bash
   git clone https://github.com/pitchmarie01/screen-rhythm.git
   ```

2. Enter the project directory:

   ```bash
   cd screen-rhythm
   ```

3. Install dependencies:

   ```bash
   npm install
   ```

4. Create a file named `.env` in the project root directory and add your Presage API key:

   ```env
   PRESAGE_API_KEY=your_presage_api_key_here
   ```

   Replace the placeholder with your own API key. Do not share or publish this key.

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

Run the automated test suite with:

```powershell
npm.cmd test
```

The project currently has 41 passing automated tests covering core application logic.

## Current development status

Implemented:

- Electron desktop application.
- Presage SmartSpectra SDK integration.
- Camera permission and live camera processing.
- Real blink-event detection using application-side logic.
- Live blink activity dashboard.
- Rolling 60-second blink timeline.
- Configurable, session-duration-based break reminders.
- Interactive break experience.
- Local session summaries and history.
- Frame-pipeline diagnostics.
- Dark charcoal and golden-yellow interface.

Final release packaging and further performance validation remain areas for improvement.

## Performance note

The application is designed to target approximately 25 FPS for SmartSpectra processing. Actual performance depends on the camera, computer, and frame-delivery pipeline.

During development, live webcam testing showed variable processing performance, with results around 24 FPS in one test. Performance can fluctuate depending on the hardware and operating conditions. The application displays live diagnostics so actual performance can be observed rather than assumed.

## Project vision

Screen Rhythm aims to make people more aware of their screen habits through technology that is useful, interactive, privacy-conscious, and easy to understand.

**Stay in your rhythm.**
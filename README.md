# NEXRAD Radar: Level II Processing Pipeline's Administrator "Console"

An Electron-based administration interface for the NOAA Levelii Nexrad Pipeline (https://github.com/JoshuaNewport/nexrad-levelii-pipeline)

## Prerequisites

- [Node.js](https://nodejs.org/) (v16.x or later recommended)
- [npm](https://www.npmjs.com/)

## Installation

1. Clone the repository:
   ```bash
   git clone <https://github.com/JoshuaNewport/nexrad-levelii-pipeline-administrator>
   cd noaa-levelii-nexrad-pipeline-administrator
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

## Development

To run the application in development mode:

```bash
npm start
```

This will launch the Electron application window. Ensure your backend Level II service is running at the configured `API_BASE` (default: `http://localhost:13480`).

## Features

- **System Control**: Start and pause the data fetcher.
- **Metrics Monitoring**: Real-time visualization of fetcher performance and success rates.
- **Station Management**: Add and remove NEXRAD radar stations.
- **System Configuration**: Real-time updates to memory and performance settings.

## Configuration

The application communicates with the backend via REST API. Refer to `HTML_API.md` for detailed endpoint specifications.

## Building for Production

To package the application for distribution, you can use `electron-builder` or `electron-forge` (not yet configured in `package.json`).

```bash
# Example if using electron-builder
npm run build
```

# Technology Stack

## Core Technologies

- **Electron**: Desktop application framework (v28.0.0)
- **Node.js**: Backend runtime with native module integration
- **Vue.js**: Frontend framework (v3.3.0) for reactive UI components
- **HTML/CSS/JavaScript**: Standard web technologies for UI

## Cloud Storage SDKs

- **AWS SDK v3**: `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`
- **AWS Credential Providers**: `@aws-sdk/credential-providers` (shared profile / SSO / AssumeRole support for S3)
- **Azure Storage**: `@azure/storage-blob` for Azure Blob Storage
- **Aliyun OSS**: `ali-oss` for Alibaba Cloud Object Storage
- **Custom PCG Client**: AWS ParallelCluster compatible storage

## Build System

- **electron-builder**: Cross-platform packaging and distribution
- **Jest**: Testing framework
- **npm scripts**: Build automation

## Common Commands

```bash
# Development
npm start                 # Start application in development mode
npm test                  # Run tests with Jest

# Building
npm run build            # Build for current platform
npm run build:win        # Build for Windows (portable + zip)
npm run build:mac        # Build for macOS (.app + .dmg)
npm run build:linux      # Build for Linux (AppImage)

# Dependencies
npm install              # Install all dependencies
```

## Development Tools

- **DevTools**: Enabled in development mode (Ctrl/Cmd+Shift+I)
- **Hot Reload**: Ctrl/Cmd+R for quick development iteration
- **Console Logging**: Comprehensive error logging and debugging

## Architecture Notes

- Main process handles file system operations and storage client management
- Renderer process manages UI and user interactions
- IPC communication between main and renderer processes
- Simple JSON-based configuration storage in user data directory
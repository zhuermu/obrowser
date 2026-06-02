# Project Structure

## Root Directory

```
obrowser/
├── main.js                 # Electron main process entry point
├── index.html             # Main application UI template
├── renderer.js            # Frontend logic and Vue.js components
├── simple-store.js        # JSON-based configuration storage utility
├── package.json           # Project dependencies and build configuration
└── package-lock.json      # Dependency lock file
```

## Storage Client Architecture

```
storage-clients/
├── StorageClientInterface.js    # Abstract interface defining common methods
├── StorageClientFactory.js      # Factory pattern for creating client instances
├── AWSS3Client.js              # AWS S3 implementation
├── AzureBlobClient.js          # Azure Blob Storage implementation
├── AliyunOSSClient.js          # Aliyun OSS implementation
└── PCGClient.js                # ParallelCluster compatible implementation
```

## Build and Distribution

```
build/                     # Build resources and assets
dist/                      # Distribution packages (generated)
release/                   # Release artifacts
```

## Assets

```
obrowser.icns             # macOS application icon
obrowser.ico              # Windows application icon
obrowser.png              # Linux application icon
obrowser.svg              # Vector icon source
entitlements.mac.plist    # macOS security entitlements
```

## Architecture Patterns

### Storage Client Pattern
- **Interface**: `StorageClientInterface` defines common methods all clients must implement
- **Factory**: `StorageClientFactory` creates appropriate client instances based on connection type
- **Implementations**: Each cloud provider has its own client class extending the interface

### Configuration Management
- **SimpleStore**: JSON-based key-value store for user settings and connections
- **Location**: User data directory (`~/.config/obrowser/` on Linux, `~/Library/Application Support/obrowser/` on macOS)

### IPC Communication
- **Main Process**: Handles file operations, storage clients, and system dialogs
- **Renderer Process**: Manages UI, user interactions, and Vue.js components
- **Communication**: Electron IPC handles for async operations between processes

## File Naming Conventions

- **Classes**: PascalCase (e.g., `StorageClientFactory`)
- **Files**: PascalCase for classes, camelCase for utilities (e.g., `simple-store.js`)
- **Methods**: camelCase (e.g., `listBuckets`, `uploadObject`)
- **Constants**: UPPER_SNAKE_CASE in factory mappings

## Extension Points

To add new storage providers:
1. Create new client class in `storage-clients/` extending `StorageClientInterface`
2. Register in `StorageClientFactory.CLIENT_TYPES`
3. Update UI form fields in `index.html` for provider-specific configuration
4. Add connection type handling in `main.js`
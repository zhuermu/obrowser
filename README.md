# Multi-Cloud Object Storage Browser

Cross-platform desktop application for browsing and managing files across multiple cloud object storage services.

## Interface

A quiet, keyboard-friendly workspace with light, dark, and system appearance.
Single-click to select, double-click to open, and use `Cmd/Ctrl K` for commands.

![OBrowser workspace (synthetic demo data)](docs/screenshots/workspace-light.png)

See the [UI design notes and previews](docs/ui-design.md) for the design references, interaction model, and verification steps.

## Supported Cloud Storage Services

- **AWS S3**: Amazon Simple Storage Service
- **Azure Blob Storage**: Microsoft Azure's object storage solution
- **Aliyun OSS**: Alibaba Cloud Object Storage Service
- **Google Cloud Storage**: via the native JSON API, authenticated with a service account JSON key file or Application Default Credentials

## Features

- Browse buckets/containers and objects across multiple cloud providers
- Upload and download files
- Create folders
- Delete files and folders
- Preview text files, images, PDFs, and more
- Generate temporary signed URLs for file access
- Manage multiple storage accounts
- Cross-platform (Windows, macOS, Linux)

## Installation

### Prerequisites

- Node.js 14+ and npm

### Building from Source

1. Clone the repository
```
git clone https://github.com/yourusername/s3browser.git
cd s3browser
```

2. Install dependencies
```
npm install
```

3. Start the application in development mode
```
npm start
```

4. Build for your platform
```
npm run build
```

## Usage

### Adding a Connection

1. Click "Add Connection" in the sidebar
2. Select the storage type
3. Enter the connection details:
   - **Connection Name**: A user-friendly name for the connection
   - **Storage Type**: AWS S3, Azure Blob, Aliyun OSS, or Google Cloud Storage
   - **Endpoint**: The service endpoint URL
   - **Region**: The service region
   - **Authentication Details**: Credentials required for the selected storage type
   - **Bucket/Container** (Optional): Default bucket/container to open on connection
   - **Prefix Path** (Optional): Default folder path to navigate to

### Authentication Details by Provider

#### AWS S3
- **Access Key**: AWS access key ID
- **Secret Key**: AWS secret access key

#### Azure Blob Storage
- **Account Name**: Azure storage account name
- **Account Key**: Azure storage account key

#### Aliyun OSS
- **Access Key**: Aliyun access key ID
- **Secret Key**: Aliyun access key secret

#### Google Cloud Storage
Google's primary credential is a single JSON key file, not an access-key/secret pair.

- **Auth Method**: `Service Account JSON Key File` or `Application Default Credentials`
- **Service Account JSON Key File**: path to a key created under IAM & Admin → Service Accounts → Keys → Add key → JSON. Only the path is stored in the connection profile; the private key stays in the file on disk.
- **Project ID** (optional): defaults to the project in the key file
- **API Endpoint** (optional): only for a private/regional endpoint or an emulator

Required roles: `Storage Object Viewer` to browse and download, `Storage Object Admin` to upload, create folders, or delete. Listing buckets additionally needs `storage.buckets.list` (e.g. `Storage Admin` at the project level).

For Application Default Credentials, run `gcloud auth application-default login` first. Note that user-account ADC has no private key, so signed URLs (used for preview and download) fall back to the IAM SignBlob API and need the `iam.serviceAccounts.signBlob` permission — a service account key avoids that.

If you specifically want an access-key/secret pair for GCS, those are "HMAC keys" for the S3-compatible XML API, created under Cloud Storage → Settings → Interoperability. GCP **API keys** (`AIza…`) cannot be used: they identify no principal, so IAM cannot authorize them for private buckets.

### File Operations

- **Browse Folders**: Double-click folders to navigate in and out of directories
- **Upload Files**: Select files from your computer to upload to the current folder
- **Download Files**: Select files and click the download button
- **Create Folders**: Create new folders in the current directory
- **Delete Files/Folders**: Select items and click the delete button
- **Preview Files**: Double-click a file, press Space on its focused row, or use its preview button.
- **Select Files**: Click to select, Shift-click for a range, or Cmd/Ctrl-click to add to a selection.
- **Filter**: Cmd/Ctrl+F filters the current location. It does not search across buckets.
- **Commands**: Cmd/Ctrl+K finds available actions and saved connections.

### UI Verification

Run `npm run test:ui` for isolated Electron interaction tests and screenshots. This uses synthetic in-memory storage and a temporary profile, never your real saved connections. Run `npm run test:ui -- --update-screenshots` to regenerate the checked-in design previews.

## Extending for Additional Storage Providers

The application is designed with extensibility in mind. To add support for additional storage providers:

1. Create a new client implementation in the `storage-clients` directory
2. Extend the `StorageClientInterface` class to implement required methods
3. Register the new client type in the `StorageClientFactory`
4. Update the UI to include the new storage type


## License

MIT

## Contributors

- List your contributors here

# Multi-Cloud Object Storage Browser

Cross-platform desktop application for browsing and managing files across multiple cloud object storage services.

## Supported Cloud Storage Services

- **AWS S3**: Amazon Simple Storage Service
- **Azure Blob Storage**: Microsoft Azure's object storage solution
- **Aliyun OSS**: Alibaba Cloud Object Storage Service
- **PCG (ParallelCluster)**: AWS ParallelCluster compatible storage

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
   - **Storage Type**: AWS S3, Azure Blob, Aliyun OSS, or PCG
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

#### PCG (ParallelCluster)
- **Access Key**: PCG access key ID
- **Secret Key**: PCG secret access key

### File Operations

- **Browse Folders**: Double-click folders to navigate in and out of directories
- **Upload Files**: Select files from your computer to upload to the current folder
- **Download Files**: Select files and click the download button
- **Create Folders**: Create new folders in the current directory
- **Delete Files/Folders**: Select items and click the delete button
- **Preview Files**: Click the preview button to view supported files (images, text, PDFs, etc.)

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

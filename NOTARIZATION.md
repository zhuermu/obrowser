# macOS 公证配置说明

## 配置步骤

### 1. 创建 App-Specific Password

1. 访问 https://appleid.apple.com/account/manage
2. 登录你的 Apple ID
3. 在"登录和安全"部分，找到"App 专用密码"
4. 点击"生成密码"
5. 输入标签（例如：OBrowser Notarization）
6. 复制生成的密码（格式：xxxx-xxxx-xxxx-xxxx）

### 2. 配置环境变量

编辑项目根目录的 `.env` 文件，填入以下信息：

```bash
# Your Apple ID email
APPLE_ID=your-apple-id@example.com

# App-Specific Password
APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
```

### 3. 构建并公证

运行以下命令构建并自动公证：

```bash
npm run build:mac
```

公证过程需要几分钟，构建工具会自动：
1. 签名应用
2. 上传到 Apple 进行公证
3. 等待公证完成
4. 将公证票据附加到应用

### 4. 不使用公证构建（可选）

如果只想签名但不公证（用于测试）：

```bash
npm run build:mac:no-notarize
```

## 注意事项

- `.env` 文件已添加到 `.gitignore`，不会被提交到版本控制
- 公证需要有效的 Apple Developer 账号
- 首次公证可能需要 5-10 分钟
- 公证后的应用可以在任何 Mac 上无警告运行

## 验证公证状态

构建完成后，可以验证公证状态：

```bash
spctl -a -vv -t install dist/mac/OBrowser.app
```

成功公证的应用会显示：
```
dist/mac/OBrowser.app: accepted
source=Notarized Developer ID
```

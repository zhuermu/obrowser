# OBrowser v0.0.6

## 🎉 新功能

### macOS 代码签名支持
- ✅ 使用 Apple Developer ID 证书签名
- ✅ 支持 macOS 公证（Notarization）
- ✅ 解决 "damaged and can't be opened" 问题
- ✅ 用户可以直接打开应用，无需额外操作

## 📦 下载

### macOS
- **OBrowser-0.0.6.dmg** - Intel Mac (x64)
- **OBrowser-0.0.6-arm64.dmg** - Apple Silicon (M1/M2/M3)
- **OBrowser-0.0.6-mac.zip** - Intel Mac (x64) 压缩包
- **OBrowser-0.0.6-arm64-mac.zip** - Apple Silicon 压缩包

### 安装说明

#### macOS
1. 下载对应架构的 .dmg 文件
2. 双击打开 .dmg
3. 将 OBrowser 拖到 Applications 文件夹
4. 首次打开时，右键点击应用选择"打开"

应用已经过代码签名，可以安全使用。

## 🔧 技术改进

- 配置 Developer ID Application 证书
- 添加 Hardened Runtime 支持
- 支持自动公证流程
- 同时支持 Intel 和 Apple Silicon 架构

## 📝 文档

- 新增 `NOTARIZATION.md` - 公证配置说明
- 新增 `.env.example` - 环境变量配置示例

---

**完整更新日志**: https://github.com/zhuermu/obrowser/compare/v0.0.5...v0.0.6

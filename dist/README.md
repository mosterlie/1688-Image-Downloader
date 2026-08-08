# 1688 Detail Image Downloader v2.1.0

一款基于 **Chrome Manifest V3** 规范开发的网页数据与图片一键采集扩展，专门用于快速抓取阿里巴巴 1688 商品详情页的核心素材。

---

## 📦 核心功能

1. **自动扫描页面**
   - 自动获取焦点打开新窗口，自动注入脚本抓取当前商品页数据。

2. **多区域智能采集**
   - 📄 **商品标题与网址**：提取商品名称与对应 URL，保存至 `1.【商品标题】.txt`。
   - 🖼️ **商品图册**：穿透并提取主图画廊的高清大图（自动剥离缩略图后缀）。
   - 🎨 **SKU 色卡**：精准锁定所有规格分组，提取对应图片与规格名称。
   - 📋 **商品详情图**：自动穿透 1688 声明式 Shadow DOM（`v-detail-*`）提取详情图。

3. **优雅的目录组织（独立编号系统）**
   ```text
   下载目录/
     └── 【商品标题】/
         ├── 1.gallery/                     (商品图册大图)
         │   ├── gallery_1.jpg
         │   └── ...
         ├── 2.sku/                         (SKU规格图)
         │   ├── sku_1_胡桃色实木框架+黑色皮.jpg
         │   └── ...
         ├── 3.detail/                      (商品详情大图)
         │   ├── detail_1.jpg
         │   └── ...
         └── 1.【商品标题】.txt              (标题+网页链接文本)
   ```

---

## 🚀 安装指南

1. **解压或直接加载**
   - 可直接使用目录中的源码文件夹 `d:\myCoding\picDownload\`。
   - 或解压打包文件 `1688_Image_Downloader_v2.1.0.zip` 到任意位置。
2. **导入 Chrome**
   - 打开 Chrome 浏览器，在地址栏输入 `chrome://extensions/`。
   - 勾选右上角的 **开发者模式**。
   - 点击 **「加载已解压的扩展程序」**，选择插件文件夹。

---

## 📁 文件清单

```text
d:\myCoding\picDownload\
├── manifest.json                  # Manifest V3 扩展配置文件
├── content.js                     # Content Script (数据提取与 Shadow DOM 穿透)
├── background.js                  # Background Service Worker (批量下载与流控)
├── popup.html                     # 弹出层界面 DOM
├── popup.css                      # 暗色暗紫科技感 UI 样式表
├── popup.js                       # 弹窗交互与自动扫描逻辑
├── icons/                         # 扩展图标 (16x16, 48x48, 128x128)
└── 1688_Image_Downloader_v2.1.0.zip # v2.1.0 发布打包文件
```

# Remote Viewer

一个最小可用的远程文件浏览器，通过 `ssh2` 连接远端服务器，浏览目录、上传本地文件、下载远程文件，并在 Web 界面中预览 PDF、图片、HTML 与文本内容。SSH 连接配置和 SSH Key 由应用自己管理，不再依赖本机 `.ssh` 配置。当前同时支持浏览器运行，以及 Electron 桌面壳方式运行。

## 已实现的核心能力

- 通过 SSH 读取远端目录
- 浏览远端目录中的子目录和常见文件
- 上传本地文件到当前远端目录
- 下载远端文件到本机
- PNG 直接预览
- PDF 拉回字节流后，使用 `pdf.js` 在浏览器端渲染成 canvas 图像
- HTML、文本、CSV/TSV 表格预览
- 支持缩放、100% 重置、适配宽度
- PDF 支持翻页

## 设计取舍

- 当前版本通过 `ssh2` 建立 SSH/SFTP 会话
- 应用内配置保存在 `~/.remote-viewer/profiles.json`，与本机 `.ssh` 配置隔离
- SSH Key 登录直接使用应用内保存或手动导入的私钥内容，不依赖 `IdentityFile` / `SSH_AUTH_SOCK`
- 支持密码登录；密码可选择保存在本机浏览器 `localStorage`
- 远端访问走 SFTP，不再依赖远端 `find` / `cat`
- 这样可以避免读取本机 SSH 配置带来的权限和安全边界问题

## 本地运行

```bash
npm install
npm run dev
```

开发模式下：

- 前端: `http://localhost:5173`
- 后端 API: `http://localhost:4173`

生产构建：

```bash
npm run build
npm run preview
```

## Windows 桌面版

开发调试：

```bash
npm run dev:desktop
```

本地启动桌面版：

```bash
npm run desktop:start
```

打包 Windows 安装包：

```bash
npm run desktop:dist
```

桌面版运行方式：

- Electron 主进程内嵌本地 Node 服务
- 前端仍然是同一套 React 预览器
- 因此 Web 版和桌面版的文件浏览、PDF 渲染、缩放逻辑完全共用

## 使用方式

1. 先在界面中手动填写连接信息，或保存为应用内配置
2. 选择认证方式：`SSH Key` 或 `Password`
3. 如有需要再填 `Username` 和 `Port`
4. 填写远端目录 `Root Path`
5. `SSH Key` 模式下粘贴私钥内容，或导入私钥文件
6. 点击“连接并读取目录”
7. 左侧进入目录，可上传本地文件到当前目录
8. 选择远端文件后，可在右侧预览或直接下载
9. 对 PDF、图片、HTML、文本内容可在右侧预览区进行缩放

## 后续建议

- 如果你需要大 PDF 的高性能缩略图列表，可以在服务端增加页面缓存
- 如果你需要更像“文件浏览器”，下一步可以补充 breadcrumb、收藏目录、搜索和懒加载

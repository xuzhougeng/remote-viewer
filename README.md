# Remote Viewer

一个最小可用的远程文件浏览器，通过 `ssh2` 连接远端服务器，浏览目录中的 PDF 和 PNG 文件，并在 Web 界面中进行高倍率缩放预览。当前同时支持浏览器运行，以及 Electron 桌面壳方式运行。

## 已实现的核心能力

- 通过 SSH 读取远端目录
- 浏览远端目录中的子目录、PDF、PNG
- PNG 直接预览
- PDF 拉回字节流后，使用 `pdf.js` 在浏览器端渲染成 canvas 图像
- 支持缩放、100% 重置、适配宽度
- PDF 支持翻页

## 设计取舍

- 当前版本通过 `ssh2` 建立 SSH/SFTP 会话
- 如果你希望直接复用本机 `~/.ssh/config` 的 Host Alias / IdentityFile，仍建议本机有可用的 `ssh`
- 网页端会读取本机 `~/.ssh/config` 中的 Host Alias，便于直接选择已配置主机
- 支持密码登录；密码可选择保存在本机浏览器 `localStorage`
- SSH Key 模式会优先使用 `~/.ssh/config` 中解析出的 `IdentityFile`，否则尝试 `SSH_AUTH_SOCK`
- 远端访问走 SFTP，不再依赖远端 `find` / `cat`
- Windows 桌面版如果需要 Alias/Key 解析，建议启用系统内置 OpenSSH Client

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

1. 在界面中填写 `Host / SSH Alias`，或者直接从 `~/.ssh/config` 选择
2. 选择认证方式：`SSH Key` 或 `Password`
3. 如有需要再填 `Username` 和 `Port`
4. 填写远端目录 `Root Path`
5. 点击“连接并读取目录”
6. 左侧进入目录，选择 PDF 或 PNG
7. 在右侧预览区进行缩放

## 后续建议

- 如果你需要大 PDF 的高性能缩略图列表，可以在服务端增加页面缓存
- 如果你需要更像“文件浏览器”，下一步可以补充 breadcrumb、收藏目录、搜索和懒加载

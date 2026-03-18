import { app, BrowserWindow } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startRemoteViewerServer } from "../server/app.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const isDev = Boolean(process.env.RV_DESKTOP_DEV_URL);
const devUrl = process.env.RV_DESKTOP_DEV_URL || "http://localhost:5173";
const serverPort = Number(process.env.RV_SERVER_PORT || 4173);
const packagedClientDist = path.resolve(currentDir, "../../dist");

let mainWindow: BrowserWindow | null = null;

async function createMainWindow() {
  if (!isDev) {
    await startRemoteViewerServer({
      clientDist: packagedClientDist,
      port: serverPort
    });
  }

  mainWindow = new BrowserWindow({
    width: 1500,
    height: 980,
    minWidth: 1160,
    minHeight: 760,
    backgroundColor: "#10151d",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (isDev) {
    await mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
    return;
  }

  await mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);
}

app.whenReady().then(async () => {
  await createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

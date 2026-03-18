import { startRemoteViewerServer } from "./app.js";

const port = Number(process.env.PORT || 4173);

void startRemoteViewerServer({ port }).then(() => {
  console.log(`Remote Viewer server listening on http://127.0.0.1:${port}`);
});

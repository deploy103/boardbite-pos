import { createServer } from "node:http";
import { env } from "./env.js";
import { createApp } from "./app.js";
import { attachSocket } from "./socket.js";

const app = createApp();
const httpServer = createServer(app);
attachSocket(httpServer);

httpServer.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`BoardBite POS server listening on port ${env.PORT} (${env.NODE_ENV})`);
});

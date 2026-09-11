import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import session from "express-session";
import rateLimit from "express-rate-limit";
import { env, isProduction } from "./env.js";
import { PrismaSessionStore } from "./auth/prismaSessionStore.js";
import { requireCustomHeader } from "./middleware/csrf.js";
import { authRouter } from "./routes/auth.routes.js";
import { customerRouter } from "./routes/customer.routes.js";
import { frontRouter } from "./routes/front.routes.js";
import { adminRouter } from "./routes/admin.routes.js";
import { posRouter } from "./routes/pos.routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(__dirname, "../../client/dist");

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
        },
      },
    }),
  );

  app.use(express.json({ limit: "200kb" }));
  app.use(cookieParser());

  app.use(
    session({
      name: "boardbite.sid",
      secret: env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      store: new PrismaSessionStore(),
      cookie: {
        httpOnly: true,
        secure: isProduction,
        sameSite: "lax",
        maxAge: 12 * 60 * 60 * 1000,
      },
    }),
  );

  app.use(requireCustomHeader);

  const loginLimiter = rateLimit({ windowMs: 5 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
  const customerLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });

  app.use("/api/staff/login", loginLimiter);
  app.use("/api/customer", customerLimiter);

  app.use("/api/staff", authRouter);
  app.use("/api/customer", customerRouter);
  app.use("/api/staff/front", frontRouter);
  app.use("/api/staff/admin", adminRouter);
  app.use("/api/staff/pos", posRouter);

  app.use(express.static(clientDist));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ error: "서버 오류가 발생했습니다." });
  });

  return app;
}

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

// 모노레포 루트의 .env 하나만 사용한다(server/dist, server/src 어디서 실행되든 동일 경로로 해석됨).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(8, "SESSION_SECRET은 최소 8자 이상이어야 합니다."),

  ADMINID: z.string().min(1),
  ADMINPASSWORD: z.string().min(1),
  FRONTID: z.string().min(1),
  FRONTPW: z.string().min(1),
  POSID: z.string().min(1),
  POSPW: z.string().min(1),
  SERVING_ID: z.string().min(1),
  SERVING_PW: z.string().min(1),
});

export const env = envSchema.parse(process.env);

export const isProduction = env.NODE_ENV === "production";

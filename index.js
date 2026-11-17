import { createServer } from "node:http";
import "dotenv/config";
import express from "express";
import cors from "cors";
import { MongoClient } from "mongodb";
import { todoSchema } from "./models/todoSchema.js";
import { createTodoRouter } from "./routers/todoRouter.js";

const port = process.env.PORT || 5000;
const mongoUri =
  process.env.MONGO_URI ?? "mongodb://127.0.0.1:27017/todo-backend";
const mongoClient = new MongoClient(mongoUri);
const app = express();
app.set("etag", false);
const todoCollection = mongoClient.db().collection("todos");
const localFrontendOrigin = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/;
const configuredFrontendOrigins = new Set(
  (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);
const isAllowedFrontendOrigin = (origin) =>
  localFrontendOrigin.test(origin) || configuredFrontendOrigins.has(origin);

app.use(
  cors({
    origin: (origin, callback) => {
      callback(null, !origin || isAllowedFrontendOrigin(origin));
    },
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  }),
);
app.use(express.json());
app.get("/health", (request, response) => {
  response.status(200).json({ status: "ok" });
});
app.use("/todos", (request, response, next) => {
  response.set("Cache-Control", "no-store");
  next();
});
app.use("/todos", createTodoRouter(todoCollection));
app.use((error, request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }

  const status = error.status === 413 ? 413 : error.status === 400 ? 400 : 500;
  if (status === 500) {
    console.error("요청 처리 실패:", error);
  }

  response.status(status).json({
    error: status === 500 ? "서버 오류가 발생했습니다." : "잘못된 요청입니다.",
  });
});

async function ensureTodoCollection() {
  const database = mongoClient.db();
  const collectionExists = await database
    .listCollections({ name: "todos" }, { nameOnly: true })
    .hasNext();

  if (collectionExists) {
    await database.command({
      collMod: "todos",
      validator: todoSchema,
      validationLevel: "strict",
      validationAction: "error",
    });
    return;
  }

  await database.createCollection("todos", {
    validator: todoSchema,
    validationLevel: "strict",
    validationAction: "error",
  });
}

const server = createServer(app);

function startServer() {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port);
  });
}

async function isServerAlreadyRunning() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return false;

    const health = await response.json();
    return health.status === "ok";
  } catch {
    // A listener without this server's health endpoint is still a port conflict.
    return false;
  }
}

let serverStarted = false;

try {
  await mongoClient.connect();
  console.log("몽고디비 연결 성공");
  await ensureTodoCollection();
  console.log("할 일 컬렉션 스키마 준비 완료");

  try {
    await startServer();
    serverStarted = true;
    console.log(`Server listening on http://localhost:${port}`);
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw error;

    if (await isServerAlreadyRunning()) {
      console.log(`서버가 이미 실행 중입니다: http://localhost:${port}`);
    } else {
      console.error(
        `포트 ${port}을(를) 다른 프로그램이 사용 중입니다. 해당 프로그램을 종료한 뒤 다시 실행하세요.`,
      );
      process.exitCode = 1;
    }
  }
} catch (error) {
  console.error("MongoDB 연결 또는 서버 시작 실패:", error);
  process.exitCode = 1;
} finally {
  if (!serverStarted) {
    await mongoClient.close();
  }
}

if (serverStarted) {
  server.on("error", (error) => {
    console.error("Failed to start server:", error);
    process.exitCode = 1;
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      server.close(async () => {
        await mongoClient.close();
        process.exit(0);
      });
    });
  }
}

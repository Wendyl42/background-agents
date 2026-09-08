#!/usr/bin/env node
/* global process, console */
// Isolated local workerd/D1 deployment; never invokes a cloud deployment command.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const state = resolve(root, ".cache/opensandbox");
const LOCAL_SANDBOX_STARTUP_TIMEOUT_MS = 600_000;
const bindingsFile = resolve(state, "control-plane-env.json");
const connection = JSON.parse(readFileSync(resolve(state, "connection.json"), "utf8"));
mkdirSync(state, { recursive: true });
if (!existsSync(bindingsFile)) {
  const secret = () => randomBytes(32).toString("base64");
  writeFileSync(
    bindingsFile,
    JSON.stringify(
      {
        SERVICE_AUTH_SECRET_GITHUB_BOT: secret(),
        SERVICE_AUTH_SECRET_WEB: secret(),
        BROWSER_AUTH_SECRET: secret(),
        TOKEN_ENCRYPTION_KEY: secret(),
        REPO_SECRETS_ENCRYPTION_KEY: secret(),
        IMAGE_CALLBACK_TOKEN_PEPPER: secret(),
      },
      null,
      2
    ) + "\n",
    { mode: 0o600, flag: "wx" }
  );
}
const privateBindings = JSON.parse(readFileSync(bindingsFile, "utf8"));
const gateway = JSON.parse(
  execFileSync("docker", ["network", "inspect", "bridge", "--format", "{{json .IPAM.Config}}"], {
    encoding: "utf8",
  })
)[0].Gateway;
const port = 8787;
const env = { ...privateBindings, OPENSANDBOX_API_KEY: connection.api_key };
writeFileSync(
  resolve(state, ".dev.vars"),
  Object.entries(env)
    .map(([key, value]) => {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== "string")
        throw new Error(
          "control-plane-env.json must contain environment variable names and string values"
        );
      return `${key}=${JSON.stringify(value)}`;
    })
    .join("\n") + "\n",
  { mode: 0o600 }
);

const config = {
  name: "openinspect-opensandbox-local",
  main: resolve(root, "packages/control-plane/src/index.ts"),
  compatibility_date: "2024-09-23",
  compatibility_flags: ["nodejs_compat"],
  vars: {
    DEPLOYMENT_NAME: "opensandbox-local",
    SANDBOX_PROVIDER: "opensandbox",
    SANDBOX_STARTUP_TIMEOUT_MS: String(LOCAL_SANDBOX_STARTUP_TIMEOUT_MS),
    OPENSANDBOX_API_URL: connection.api_url,
    OPENSANDBOX_IMAGE: connection.image,
    WORKER_URL: `http://${gateway}:${port}`,
    WEB_APP_URL: "http://localhost:3000",
    SCM_PROVIDER: "github",
    APP_NAME: "OpenInspect Local",
  },
  durable_objects: {
    bindings: [
      { name: "SESSION", class_name: "SessionDO" },
      { name: "SCHEDULER", class_name: "SchedulerDO" },
    ],
  },
  migrations: [{ tag: "v1", new_sqlite_classes: ["SessionDO", "SchedulerDO"] }],
  d1_databases: [
    {
      binding: "DB",
      database_id: "00000000-0000-0000-0000-000000000000",
      database_name: "openinspect-opensandbox-local",
      migrations_dir: resolve(root, "terraform/d1/migrations"),
    },
  ],
  kv_namespaces: [{ binding: "REPOS_CACHE", id: "00000000000000000000000000000000" }],
  r2_buckets: [{ binding: "MEDIA_BUCKET", bucket_name: "openinspect-opensandbox-local" }],
  queues: {
    producers: [{ binding: "IMAGE_BUILD_FINALIZATION_QUEUE", queue: "oi-local-finalization" }],
  },
};
const configPath = resolve(state, "wrangler.json");
writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
writeFileSync(
  resolve(state, "trace-connection.json"),
  JSON.stringify({
    controlPlaneUrl: `http://127.0.0.1:${port}`,
    exportServiceSecret: privateBindings.SERVICE_AUTH_SECRET_GITHUB_BOT,
    sandboxBackend: "opensandbox",
  }) + "\n",
  { mode: 0o600 }
);
const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");
const persist = resolve(state, "control-plane-state");
const processEnv = {
  ...process.env,
  WRANGLER_LOG_PATH: resolve(state, "wrangler.log"),
  WRANGLER_SEND_METRICS: "false",
};
const command = process.argv[2] ?? "serve";
if (command === "init" || command === "serve") {
  const migrationLog = openSync(resolve(state, "migrations.log"), "w", 0o600);
  try {
    execFileSync(
      process.execPath,
      [
        wrangler,
        "d1",
        "migrations",
        "apply",
        "DB",
        "--local",
        "--config",
        configPath,
        "--persist-to",
        persist,
      ],
      { cwd: root, env: processEnv, stdio: ["ignore", migrationLog, migrationLog] }
    );
  } finally {
    closeSync(migrationLog);
  }
  console.log("Local D1 migrations applied; details in .cache/opensandbox/migrations.log");
  const sandboxEnvFile = resolve(state, "sandbox-env.json");
  if (existsSync(sandboxEnvFile)) {
    // Use the application's validation/encryption contract when seeding local D1.
    const cryptoModule = resolve(state, "scoped-secrets.mjs");
    await build({
      entryPoints: [resolve(root, "packages/control-plane/src/db/scoped-secrets.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: cryptoModule,
    });
    const { prepareSecretsForWrite, encryptSecretEntries } = await import(cryptoModule);
    const prepared = prepareSecretsForWrite(JSON.parse(readFileSync(sandboxEnvFile, "utf8")));
    const { entries } = await encryptSecretEntries(
      prepared,
      new Set(),
      privateBindings.REPO_SECRETS_ENCRYPTION_KEY
    );
    const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
    const now = Date.now();
    const sqlPath = resolve(state, "seed-secrets.sql");
    writeFileSync(
      sqlPath,
      entries
        .map(
          ({ key, encryptedValue }) =>
            `INSERT INTO global_secrets(key,encrypted_value,created_at,updated_at) VALUES(${quote(key)},${quote(encryptedValue)},${now},${now}) ON CONFLICT(key) DO UPDATE SET encrypted_value=excluded.encrypted_value,updated_at=excluded.updated_at;`
        )
        .join("\n"),
      { mode: 0o600 }
    );
    if (entries.length) {
      execFileSync(
        process.execPath,
        [
          wrangler,
          "d1",
          "execute",
          "DB",
          "--local",
          "--config",
          configPath,
          "--persist-to",
          persist,
          "--file",
          sqlPath,
        ],
        { cwd: root, env: processEnv, stdio: "pipe" }
      );
      console.log(`Seeded ${entries.length} encrypted sandbox environment entries in local D1`);
    }
  }
} else throw new Error("Usage: node packages/opensandbox-infra/control-plane.mjs [init|serve]");
if (command === "serve") {
  const child = spawn(
    process.execPath,
    [
      wrangler,
      "dev",
      "--config",
      configPath,
      "--ip",
      "0.0.0.0",
      "--port",
      String(port),
      "--persist-to",
      persist,
      "--local",
    ],
    { cwd: root, env: processEnv, stdio: "inherit" }
  );
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code) => {
    process.exitCode = code ?? 0;
  });
}

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import toml from "toml";

const blueprint = fileURLToPath(new URL("../blueprints/keyzori/", import.meta.url));
const template = toml.parse(readFileSync(join(blueprint, "template.toml"), "utf8"));
const metadata = JSON.parse(readFileSync(join(blueprint, "meta.json"), "utf8"));

// Resolve only this blueprint's helpers. Dokploy's hash length is characters,
// unlike the repository's validation helper, which interprets it as bytes.
const variables = Object.fromEntries(Object.entries(template.variables).map(([key, value]) => {
  if (value === "${domain}") return [key, "keyzori.example.test"];
  const hash = /^\$\{hash:(\d+)\}$/.exec(value);
  assert.ok(hash, `Unsupported helper for ${key}`);
  const length = Number(hash[1]);
  return [key, randomBytes(Math.ceil(length / 2)).toString("hex").slice(0, length)];
}));
const generatedEnv = Object.fromEntries(template.config.env.map((entry) => {
  const resolved = entry.replace(/\$\{([^}]+)\}/g, (_, name) => {
    assert.ok(Object.hasOwn(variables, name), `Unknown variable: ${name}`);
    return variables[name];
  });
  const separator = resolved.indexOf("=");
  assert.ok(separator > 0);
  return [resolved.slice(0, separator), resolved.slice(separator + 1)];
}));
// Never inherit a developer's Keyzori credentials or connection settings.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("KEYZORI_")));
const project = `keyzori-test-${randomBytes(6).toString("hex")}`;

test("Keyzori template deployment", { timeout: 600_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "keyzori-template-test-"));
  const envFile = join(directory, "empty.env");
  writeFileSync(envFile, "");
  const args = ["compose", "--project-name", project, "--env-file", envFile, "-f", join(blueprint, "docker-compose.yml")];
  function compose(command, env = generatedEnv, allowFailure = false) {
    const result = spawnSync("docker", [...args, ...command], {
      env: { ...cleanEnv, ...env }, encoding: "utf8", timeout: 240_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (!allowFailure && result.status !== 0) {
      let message = result.stderr || result.error?.message || "Docker command failed";
      for (const value of Object.values(generatedEnv).filter(Boolean)) message = message.replaceAll(value, "[redacted]");
      throw new Error(`${command[0]} failed: ${message}`);
    }
    return result;
  }
  function apiCheck(script) {
    return compose(["exec", "-T", "keyzori", "bun", "-e", script]).stdout.trim();
  }
  const checkEndpoints = `
    for (const path of ["/health", "/ready", "/docs"]) {
      const response = await fetch("http://127.0.0.1:3000" + path);
      if (response.status !== 200) throw new Error(path + ": " + response.status);
    }
    for (const key of ["", "invalid-admin-key"]) {
      const response = await fetch("http://127.0.0.1:3000/admin/customers", {headers: {"X-Admin-Key": key}});
      if (response.status !== 401) throw new Error("Invalid credentials accepted");
    }
  `;
  let started = false;
  try {
    await t.test("generated credentials resolve and missing secrets fail closed", () => {
      assert.match(generatedEnv.KEYZORI_ADMIN_KEY, /^[a-f0-9]{32,}$/);
      assert.match(generatedEnv.KEYZORI_POSTGRES_PASSWORD, /^[a-f0-9]{32,}$/);
      assert.notEqual(generatedEnv.KEYZORI_ADMIN_KEY, generatedEnv.KEYZORI_POSTGRES_PASSWORD);
      for (const key of ["KEYZORI_ADMIN_KEY", "KEYZORI_POSTGRES_PASSWORD"]) {
        const env = { ...generatedEnv };
        delete env[key];
        const result = compose(["config", "--quiet"], env, true);
        assert.notEqual(result.status, 0, `${key} must be required`);
        assert.ok(result.stderr.includes(key));
      }
      const config = JSON.parse(compose(["config", "--format", "json"]).stdout);
      const service = config.services.keyzori;
      assert.equal(service.image, `ghcr.io/keyzori/keyzori:${metadata.version}`);
      const database = new URL(service.environment.KEYZORI_DATABASE_URL);
      assert.equal(database.password, config.services.postgres.environment.POSTGRES_PASSWORD);
      assert.equal(database.hostname, "postgres");
      assert.equal(service.environment.KEYZORI_REDIS_URL, "redis://redis:6379");
      for (const domain of template.config.domains) {
        const target = config.services[domain.serviceName];
        assert.ok(target);
        assert.equal(Number(target.environment.KEYZORI_PORT), domain.port);
      }
      for (const service of Object.values(config.services)) assert.ok(!service.ports?.length);
    });
    await t.test("fresh startup, readiness, docs, and authentication", () => {
      started = true;
      compose(["up", "-d", "--wait", "--wait-timeout", "180"]);
      apiCheck(checkEndpoints);
    });
    let customerId;
    await t.test("authenticated writes reach PostgreSQL and Redis", () => {
      customerId = apiCheck(`
        const response = await fetch("http://127.0.0.1:3000/admin/customers", {
          method: "POST", headers: {"Content-Type": "application/json", "X-Admin-Key": process.env.KEYZORI_ADMIN_KEY},
          body: JSON.stringify({email: "persistence@example.test", name: "Template persistence test"})
        });
        if (response.status !== 201) throw new Error("Customer creation: " + response.status);
        console.log((await response.json()).id);
      `);
      assert.ok(customerId);
      assert.equal(compose(["exec", "-T", "redis", "redis-cli", "SET", "template-persistence", "verified"]).stdout.trim(), "OK");
    });
    function verifyPersistence() {
      assert.ok(customerId, "Customer creation must succeed first");
      apiCheck(checkEndpoints + `
        const response = await fetch("http://127.0.0.1:3000/admin/customers/" + ${JSON.stringify(customerId)}, {
          headers: {"X-Admin-Key": process.env.KEYZORI_ADMIN_KEY}
        });
        if (response.status !== 200 || (await response.json()).email !== "persistence@example.test")
          throw new Error("PostgreSQL persistence failed");
      `);
      assert.equal(compose(["exec", "-T", "redis", "redis-cli", "GET", "template-persistence"]).stdout.trim(), "verified");
    }
    await t.test("restart preserves data and readiness", () => {
      compose(["restart"]);
      compose(["up", "-d", "--wait", "--wait-timeout", "120"]);
      verifyPersistence();
    });
    await t.test("container recreation preserves named-volume data", () => {
      compose(["down"]);
      compose(["up", "-d", "--wait", "--wait-timeout", "120"]);
      verifyPersistence();
    });
  } finally {
    try {
      if (started) compose(["down", "--volumes", "--remove-orphans"]);
    } finally {
      unlinkSync(envFile);
      rmdirSync(directory);
    }
  }
});

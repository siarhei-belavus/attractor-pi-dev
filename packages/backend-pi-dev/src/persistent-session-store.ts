import { SessionManager } from "@mariozechner/pi-coding-agent";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export interface PersistentSessionManifest {
  backendExecutionRef: string;
  provider: string;
  model: string;
  sessionPath: string;
  createdAt: string;
  updatedAt: string;
}

export type PersistentSessionResolutionMode = "open_or_create" | "open_required" | "recreate";

export interface ResolvePersistentSessionInput {
  sessionRoot: string;
  backendExecutionRef: string;
  cwd: string;
  mode: PersistentSessionResolutionMode;
  provider?: string;
  model?: string;
}

export interface PersistentSessionAccess {
  backendExecutionRef: string;
  sessionDir: string;
  sessionManager: SessionManager;
  manifest: PersistentSessionManifest;
}

const MANIFEST_FILE = "manifest.json";

export class PersistentSessionStore {
  resolve(input: ResolvePersistentSessionInput): PersistentSessionAccess {
    mkdirSync(input.sessionRoot, { recursive: true });

    const sessionDir = this.resolveSessionDir(input.sessionRoot, input.backendExecutionRef);
    const manifestPath = path.join(sessionDir, MANIFEST_FILE);

    let existingManifest: PersistentSessionManifest | null = null;
    let manifestLoadError: Error | null = null;
    try {
      existingManifest = this.loadManifestIfPresent(manifestPath);
    } catch (error) {
      manifestLoadError = error instanceof Error ? error : new Error(String(error));
    }

    if (manifestLoadError) {
      if (input.mode !== "recreate" || !existsSync(sessionDir)) {
        throw manifestLoadError;
      }
      this.quarantineSessionDir(sessionDir);
      existingManifest = null;
    }

    if (existingManifest) {
      this.assertProviderModelConsistency(existingManifest, input.provider, input.model);
    }

    if (input.mode === "recreate" && existsSync(sessionDir)) {
      const provider = input.provider ?? existingManifest?.provider;
      const model = input.model ?? existingManifest?.model;
      if (!provider || !model) {
        throw new Error(
          `Persistent session '${input.backendExecutionRef}' cannot be recreated without provider and model`,
        );
      }
      this.quarantineSessionDir(sessionDir);
      return this.createFreshAccess(sessionDir, input.backendExecutionRef, input.cwd, provider, model);
    }

    if (existingManifest) {
      if (!existingManifest.sessionPath || !existsSync(existingManifest.sessionPath)) {
        throw new Error(
          `Persistent session artifact is missing for '${input.backendExecutionRef}' at ${existingManifest.sessionPath}`,
        );
      }
      return {
        backendExecutionRef: input.backendExecutionRef,
        sessionDir,
        sessionManager: SessionManager.open(existingManifest.sessionPath, sessionDir),
        manifest: existingManifest,
      };
    }

    if (input.mode === "open_required") {
      throw new Error(
        `Persistent session manifest is missing for '${input.backendExecutionRef}' at ${manifestPath}`,
      );
    }

    if (!input.provider || !input.model) {
      throw new Error(
        `Persistent session '${input.backendExecutionRef}' cannot be created without provider and model`,
      );
    }

    return this.createFreshAccess(
      sessionDir,
      input.backendExecutionRef,
      input.cwd,
      input.provider,
      input.model,
    );
  }

  commitAccess(access: PersistentSessionAccess): PersistentSessionManifest {
    mkdirSync(access.sessionDir, { recursive: true });
    const now = new Date().toISOString();
    const sessionPath = access.sessionManager.getSessionFile();
    if (!sessionPath) {
      throw new Error(
        `Persistent session '${access.backendExecutionRef}' has no Pi session artifact path`,
      );
    }

    const manifest: PersistentSessionManifest = {
      ...access.manifest,
      sessionPath,
      updatedAt: now,
      createdAt: access.manifest.createdAt || now,
    };

    writeFileSync(
      path.join(access.sessionDir, MANIFEST_FILE),
      JSON.stringify(manifest, null, 2) + "\n",
      "utf-8",
    );
    return manifest;
  }

  private createFreshAccess(
    sessionDir: string,
    backendExecutionRef: string,
    cwd: string,
    provider: string,
    model: string,
  ): PersistentSessionAccess {
    const sessionManager = SessionManager.create(cwd, sessionDir);
    const now = new Date().toISOString();
    const sessionPath = sessionManager.getSessionFile();
    if (!sessionPath) {
      throw new Error(
        `Pi session manager did not create an artifact path for '${backendExecutionRef}'`,
      );
    }

    return {
      backendExecutionRef,
      sessionDir,
      sessionManager,
      manifest: {
        backendExecutionRef,
        provider,
        model,
        sessionPath,
        createdAt: now,
        updatedAt: now,
      },
    };
  }

  private resolveSessionDir(sessionRoot: string, backendExecutionRef: string): string {
    const safeName = this.sanitizeName(backendExecutionRef);
    const hash = createHash("sha256").update(backendExecutionRef).digest("hex").slice(0, 12);
    return path.join(sessionRoot, `${safeName}-${hash}`);
  }

  private sanitizeName(value: string): string {
    const normalized = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-");
    const trimmed = normalized.replace(/^-|-$/g, "");
    return (trimmed || "session").slice(0, 64);
  }

  private loadManifestIfPresent(manifestPath: string): PersistentSessionManifest | null {
    if (!existsSync(manifestPath)) {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
    } catch (error) {
      throw new Error(`Persistent session manifest at ${manifestPath} is unreadable: ${error}`);
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Persistent session manifest at ${manifestPath} is malformed`);
    }

    const manifest = parsed as Record<string, unknown>;
    const backendExecutionRef = manifest["backendExecutionRef"];
    const provider = manifest["provider"];
    const model = manifest["model"];
    const sessionPath = manifest["sessionPath"];
    const createdAt = manifest["createdAt"];
    const updatedAt = manifest["updatedAt"];

    if (
      typeof backendExecutionRef !== "string" ||
      typeof provider !== "string" ||
      typeof model !== "string" ||
      typeof sessionPath !== "string" ||
      typeof createdAt !== "string" ||
      typeof updatedAt !== "string"
    ) {
      throw new Error(`Persistent session manifest at ${manifestPath} is incomplete`);
    }

    return {
      backendExecutionRef,
      provider,
      model,
      sessionPath,
      createdAt,
      updatedAt,
    };
  }

  private assertProviderModelConsistency(
    manifest: PersistentSessionManifest,
    provider?: string,
    model?: string,
  ): void {
    if (provider && manifest.provider !== provider) {
      throw new Error(
        `Persistent session '${manifest.backendExecutionRef}' is locked to provider '${manifest.provider}', not '${provider}'`,
      );
    }
    if (model && manifest.model !== model) {
      throw new Error(
        `Persistent session '${manifest.backendExecutionRef}' is locked to model '${manifest.model}', not '${model}'`,
      );
    }
  }

  private quarantineSessionDir(sessionDir: string): void {
    const quarantinePath = `${sessionDir}.quarantine.${Date.now()}`;
    renameSync(sessionDir, quarantinePath);
    mkdirSync(path.dirname(sessionDir), { recursive: true });
  }
}

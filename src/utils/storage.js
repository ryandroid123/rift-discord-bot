const fs = require("fs");
const path = require("path");

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

let cachedDataDirInfo = null;
const migratedFiles = new Set();

function resolveDataDirInfo() {
  if (cachedDataDirInfo) return cachedDataDirInfo;

  const envDataDir = String(process.env.DATA_DIR || "").trim();
  const envRailwayMount = String(process.env.RAILWAY_VOLUME_MOUNT_PATH || "").trim();

  if (envDataDir) {
    cachedDataDirInfo = {
      dataDir: path.resolve(envDataDir),
      source: "DATA_DIR"
    };
    return cachedDataDirInfo;
  }

  if (envRailwayMount) {
    cachedDataDirInfo = {
      dataDir: path.resolve(envRailwayMount, "data"),
      source: "RAILWAY_VOLUME_MOUNT_PATH"
    };
    return cachedDataDirInfo;
  }

  cachedDataDirInfo = {
    dataDir: path.resolve(__dirname, "../data"),
    source: "local-default"
  };
  return cachedDataDirInfo;
}

function getDataDirInfo() {
  const info = resolveDataDirInfo();
  if (!fs.existsSync(info.dataDir)) {
    fs.mkdirSync(info.dataDir, { recursive: true });
  }
  return info;
}

function resolveDataPath(...parts) {
  const { dataDir } = getDataDirInfo();
  return path.join(dataDir, ...parts);
}

function coerceFilePath(filePath) {
  if (path.isAbsolute(filePath)) return filePath;
  return resolveDataPath(filePath);
}

function maybeMigrateFromLegacy(filePath) {
  const info = resolveDataDirInfo();
  if (info.source !== "DATA_DIR") return false;
  if (fs.existsSync(filePath)) return false;

  const legacyPath = path.resolve(__dirname, "../data", path.basename(filePath));
  if (legacyPath === filePath || !fs.existsSync(legacyPath)) return false;

  ensureDir(filePath);
  fs.copyFileSync(legacyPath, filePath);

  if (!migratedFiles.has(filePath)) {
    console.log(`[storage] migrated ${path.basename(filePath)} from ${legacyPath} -> ${filePath}`);
    migratedFiles.add(filePath);
  }

  return true;
}

function ensureDataFile(fileName, defaultValue) {
  const filePath = resolveDataPath(fileName);
  ensureDir(filePath);
  maybeMigrateFromLegacy(filePath);

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2), "utf8");
  }

  return filePath;
}

function readJson(filePath, defaultValue) {
  try {
    const targetPath = coerceFilePath(filePath);
    ensureDir(targetPath);
    maybeMigrateFromLegacy(targetPath);
    if (!fs.existsSync(targetPath)) {
      fs.writeFileSync(targetPath, JSON.stringify(defaultValue, null, 2), "utf8");
      return defaultValue;
    }
    const raw = fs.readFileSync(targetPath, "utf8");
    return raw.trim() ? JSON.parse(raw) : defaultValue;
  } catch {
    return defaultValue;
  }
}

function writeJson(filePath, value) {
  const targetPath = coerceFilePath(filePath);
  ensureDir(targetPath);

  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify(value, null, 2);

  fs.writeFileSync(tempPath, payload, "utf8");
  try {
    fs.renameSync(tempPath, targetPath);
  } catch {
    if (fs.existsSync(targetPath)) {
      fs.unlinkSync(targetPath);
    }
    fs.renameSync(tempPath, targetPath);
  }
}

module.exports = {
  readJson,
  writeJson,
  ensureDataFile,
  resolveDataPath,
  getDataDirInfo
};

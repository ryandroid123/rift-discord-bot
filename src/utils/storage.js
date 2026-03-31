const fs = require("fs");
const path = require("path");

function ensureFile(filePath, defaultValue) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2), "utf8");
  }
}

function readJson(filePath, defaultValue) {
  ensureFile(filePath, defaultValue);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return raw.trim() ? JSON.parse(raw) : defaultValue;
  } catch {
    return defaultValue;
  }
}

function writeJson(filePath, value) {
  ensureFile(filePath, value);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

module.exports = { readJson, writeJson };

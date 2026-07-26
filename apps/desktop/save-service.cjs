"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const MAX_OUTPUTS = 100;
const MAX_CONTENT_CHARACTERS = 1_000_000;

const WINDOWS_RESERVED = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

function validateOutputs(outputs) {
  if (!Array.isArray(outputs) || outputs.length === 0 || outputs.length > MAX_OUTPUTS) {
    throw new Error(`Expected between 1 and ${MAX_OUTPUTS} generated outputs.`);
  }
  const seen = new Set();
  return outputs.map((output, index) => {
    if (!output || typeof output !== "object") {
      throw new Error(`Output ${index + 1} is invalid.`);
    }
    const fileName = typeof output.file_name === "string" ? output.file_name.trim() : "";
    const stem = path.parse(fileName).name.toUpperCase();
    if (
      !fileName
      || path.basename(fileName) !== fileName
      || (!fileName.toLocaleLowerCase().endsWith(".txt") && !fileName.toLocaleLowerCase().endsWith(".docx"))
      || /[<>:"/\\|?*\u0000-\u001F]/.test(fileName)
      || WINDOWS_RESERVED.has(stem)
    ) {
      throw new Error(`Output ${index + 1} has an unsafe filename.`);
    }
    if (seen.has(fileName.toLocaleLowerCase())) {
      throw new Error(`Output filename “${fileName}” is duplicated.`);
    }
    seen.add(fileName.toLocaleLowerCase());
    if (typeof output.content !== "string" || output.content.length > MAX_CONTENT_CHARACTERS) {
      throw new Error(`Output “${fileName}” has invalid content.`);
    }
    return { fileName, content: output.content };
  });
}

async function existingOutputPaths(directory, outputs) {
  const validated = validateOutputs(outputs);
  const existing = [];
  for (const output of validated) {
    const target = path.join(directory, output.fileName);
    try {
      await fs.access(target);
      existing.push(target);
    } catch {
      // The target does not exist and is safe to create.
    }
  }
  return existing;
}

async function writeOutputs(directory, outputs) {
  const validated = validateOutputs(outputs);
  await fs.mkdir(directory, { recursive: true });
  const savedPaths = [];
  for (const output of validated) {
    const target = path.join(directory, output.fileName);
    await fs.writeFile(target, output.content, { encoding: "utf8" });
    savedPaths.push(target);
  }
  return savedPaths;
}

module.exports = { existingOutputPaths, validateOutputs, writeOutputs };

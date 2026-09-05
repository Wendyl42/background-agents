import { readFileSync } from "node:fs";

export function readText(path) {
  return readFileSync(path, "utf8");
}

export function readJson(path) {
  try {
    return JSON.parse(readText(path));
  } catch (error) {
    throw new Error(
      `Failed to parse JSON ${path}: ${error instanceof Error ? error.message : error}`
    );
  }
}

export function readJsonl(path) {
  const text = readText(path);
  if (text.trim() === "") return [];
  return text.split("\n").flatMap((line, index) => {
    if (line.trim() === "") return [];
    try {
      return [JSON.parse(line)];
    } catch (error) {
      throw new Error(
        `Failed to parse JSONL ${path}:${index + 1}: ${error instanceof Error ? error.message : error}`
      );
    }
  });
}

export function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function stableJsonl(values) {
  if (values.length === 0) return "";
  return `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
}

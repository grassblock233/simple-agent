import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

export const MAX_TEXT_BYTES = 64 * 1024;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export async function workspacePath(root: string, requested: string, forWrite = false): Promise<string> {
  if (!requested || requested.includes("\0")) throw new Error("路径无效");
  const resolved = path.resolve(root, requested);
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("拒绝访问工作区外的路径");
  if (relative.split(path.sep).some((part) => /^(?:\.env(?:\..*)?|\.npmrc|\.ssh|\.aws|id_(?:rsa|ed25519)|.*\.(?:pem|key))$/i.test(part))) throw new Error("拒绝访问凭据或密钥文件");
  let cursor = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    try {
      const item = await lstat(cursor);
      if (item.isSymbolicLink()) throw new Error("拒绝访问符号链接路径");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!forWrite) throw new Error("文件或目录不存在");
    }
  }
  if (!forWrite) {
    const canonical = await realpath(resolved);
    const checked = path.relative(root, canonical);
    if (checked === ".." || checked.startsWith(`..${path.sep}`) || path.isAbsolute(checked)) throw new Error("拒绝访问工作区外的路径");
  }
  return resolved;
}

export async function readText(root: string, requested: string): Promise<string> {
  const file = await workspacePath(root, requested);
  const info = await stat(file);
  if (!info.isFile()) throw new Error("目标不是文件");
  if (info.size > MAX_TEXT_BYTES) throw new Error("文件过大，请用内容检索定位");
  const content = await readFile(file);
  if (content.includes(0)) throw new Error("二进制文件不能作为文本读取");
  return new TextDecoder("utf-8", { fatal: true }).decode(content);
}

export async function writeText(root: string, requested: string, content: string): Promise<string> {
  if (Buffer.byteLength(content) > MAX_TEXT_BYTES) throw new Error("写入内容超过 64 KiB");
  const file = await workspacePath(root, requested, true);
  await mkdir(path.dirname(file), { recursive: true });
  await workspacePath(root, requested, true);
  await writeFile(file, content, "utf8");
  return path.relative(root, file);
}

export async function listDirectory(root: string, requested: string): Promise<string> {
  const directory = await workspacePath(root, requested || ".");
  if (!(await stat(directory)).isDirectory()) throw new Error("目标不是目录");
  const items = await readdir(directory, { withFileTypes: true });
  return items.slice(0, 200).map((item) => `${item.isDirectory() ? "dir" : item.isSymbolicLink() ? "link" : "file"}\t${item.name}`).join("\n") || "目录为空";
}

export async function searchText(root: string, query: string, requested = "."): Promise<string> {
  if (!query || query.length > 200) throw new Error("检索词长度必须在 1–200 字符内");
  const start = await workspacePath(root, requested);
  const hits: string[] = [];
  let inspected = 0;
  const visit = async (current: string, depth: number): Promise<void> => {
    if (depth > 8 || inspected >= 500 || hits.length >= 100) return;
    const info = await lstat(current);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      for (const item of await readdir(current, { withFileTypes: true })) {
        if ([".git", ".next", "node_modules", ".data"].includes(item.name) || /^(?:\.env(?:\..*)?|\.npmrc|\.ssh|\.aws|id_(?:rsa|ed25519)|.*\.(?:pem|key))$/i.test(item.name)) continue;
        await visit(path.join(current, item.name), depth + 1);
      }
    } else if (info.isFile() && info.size <= MAX_TEXT_BYTES) {
      inspected++;
      const bytes = await readFile(current);
      if (bytes.includes(0)) return;
      let content: string;
      try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return; }
      content.split("\n").forEach((line, index) => {
        if (line.toLowerCase().includes(query.toLowerCase()) && hits.length < 100) hits.push(`${path.relative(root, current)}:${index + 1}: ${line.slice(0, 300)}`);
      });
    }
  };
  await visit(start, 0);
  if (!hits.length) throw new Error(`未找到“${query}”（已检查 ${inspected} 个文件）`);
  return hits.join("\n");
}

export function detectImage(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "image/jpeg";
  if (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

export async function validateImage(bytes: Buffer): Promise<string> {
  const mime = detectImage(bytes);
  if (!mime) throw new Error("仅支持 PNG、JPEG、GIF、WebP 图片");
  try {
    const metadata = await sharp(bytes, { limitInputPixels: 8192 * 8192 }).metadata();
    const actual = metadata.format === "jpeg" ? "image/jpeg" : `image/${metadata.format}`;
    if (actual !== mime || !metadata.width || !metadata.height || metadata.width > 8192 || metadata.height > 8192) throw new Error("图片格式或尺寸无效");
  } catch { throw new Error("图片无法解码，或单边尺寸超过 8192 像素"); }
  return mime;
}

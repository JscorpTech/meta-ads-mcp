import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, sep } from "node:path";

export const MAX_LOCAL_IMAGE_BYTES = 8 * 1024 * 1024;

export async function readLocalImage(filePath: string) {
  const configuredRoot = process.env.META_LOCAL_MEDIA_ROOT;
  if (!configuredRoot) throw new Error("Local image upload is not enabled on this server.");
  if (!isAbsolute(filePath)) throw new Error("local_image_path must be an absolute path.");
  const root = await realpath(configuredRoot);
  const resolved = await realpath(filePath);
  const rel = relative(root, resolved);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Image must be inside the configured media directory.");
  }
  if (![".jpg", ".jpeg"].includes(extname(resolved).toLowerCase())) {
    throw new Error("Local Instagram image upload accepts JPEG (.jpg/.jpeg) only.");
  }
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 4 || info.size > MAX_LOCAL_IMAGE_BYTES) {
      throw new Error("Local JPEG must be a regular file between 4 bytes and 8 MiB.");
    }
    const buffer = await handle.readFile();
    if (buffer.length > MAX_LOCAL_IMAGE_BYTES || buffer.length < 4) {
      throw new Error("Local JPEG must be between 4 bytes and 8 MiB.");
    }
    if (buffer[0] !== 0xff || buffer[1] !== 0xd8 ||
        buffer[buffer.length - 2] !== 0xff || buffer[buffer.length - 1] !== 0xd9) {
      throw new Error("File header/trailer does not match a JPEG image.");
    }
    return { buffer, contentType: "image/jpeg", extension: ".jpg" };
  } finally {
    await handle.close();
  }
}

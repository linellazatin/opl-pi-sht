import { errorMessage } from "./utils.js";

export async function extractPdfBuffer(buffer: ArrayBuffer | Uint8Array): Promise<string> {
  const { getDocumentProxy, extractText } = await import("unpdf");
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return text ?? "";
}

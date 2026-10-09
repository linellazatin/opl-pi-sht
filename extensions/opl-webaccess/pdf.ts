export async function extractPdfBuffer(buffer: ArrayBuffer | Uint8Array): Promise<string> {
  const { getDocumentProxy, extractText } = await import("unpdf");
  // Buffer extends Uint8Array, but PDF.js rejects it; copy into the accepted type.
  const bytes = new Uint8Array(buffer);
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return text ?? "";
}

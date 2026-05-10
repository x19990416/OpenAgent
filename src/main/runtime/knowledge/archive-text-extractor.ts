import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

interface ZipEntry {
  name: string;
  compression: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export function extractOfficeText(filePath: string): string {
  const data = readFileSync(filePath);
  const entries = readZipEntries(data);
  const wanted = entries.filter((entry) => isOfficeXmlTextEntry(entry.name));
  const parts: string[] = [];
  for (const entry of wanted) {
    const bytes = readZipEntryData(data, entry);
    const text = xmlToText(bytes.toString('utf8'));
    if (text.trim()) parts.push(`## ${entry.name}\n\n${text.trim()}`);
  }
  return parts.join('\n\n');
}

export function extractPdfText(filePath: string): string {
  const data = readFileSync(filePath);
  const binary = data.toString('latin1');
  const literalStrings = [...binary.matchAll(/\((?:\\.|[^\\)]){2,}\)/g)]
    .map((match) => decodePdfLiteral(match[0].slice(1, -1)))
    .filter((value) => looksLikeText(value));
  const tjArrays = [...binary.matchAll(/\[((?:\s*\((?:\\.|[^\\)]*)\)\s*-?\d*)+)\]\s*TJ/g)]
    .flatMap((match) => [...match[1].matchAll(/\((?:\\.|[^\\)]*)\)/g)].map((part) => decodePdfLiteral(part[0].slice(1, -1))))
    .filter((value) => looksLikeText(value));
  return [...literalStrings, ...tjArrays].join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function readZipEntries(data: Buffer): ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(data);
  if (eocdOffset < 0) return [];
  const centralDirSize = data.readUInt32LE(eocdOffset + 12);
  const centralDirOffset = data.readUInt32LE(eocdOffset + 16);
  const entries: ZipEntry[] = [];
  let offset = centralDirOffset;
  const end = centralDirOffset + centralDirSize;
  while (offset < end && data.readUInt32LE(offset) === 0x02014b50) {
    const compression = data.readUInt16LE(offset + 10);
    const compressedSize = data.readUInt32LE(offset + 20);
    const uncompressedSize = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const localHeaderOffset = data.readUInt32LE(offset + 42);
    const name = data.slice(offset + 46, offset + 46 + nameLength).toString('utf8');
    entries.push({ name, compression, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readZipEntryData(data: Buffer, entry: ZipEntry): Buffer {
  const offset = entry.localHeaderOffset;
  if (data.readUInt32LE(offset) !== 0x04034b50) return Buffer.alloc(0);
  const nameLength = data.readUInt16LE(offset + 26);
  const extraLength = data.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  const compressed = data.slice(dataStart, dataStart + entry.compressedSize);
  if (entry.compression === 0) return compressed;
  if (entry.compression === 8) return inflateRawSync(compressed, { finishFlush: 2 }).slice(0, entry.uncompressedSize || undefined);
  return Buffer.alloc(0);
}

function findEndOfCentralDirectory(data: Buffer) {
  const min = Math.max(0, data.length - 0xffff - 22);
  for (let offset = data.length - 22; offset >= min; offset -= 1) {
    if (data.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function isOfficeXmlTextEntry(name: string) {
  return (
    name === 'word/document.xml' ||
    name.startsWith('word/header') ||
    name.startsWith('word/footer') ||
    name.startsWith('ppt/slides/slide') ||
    name.startsWith('xl/worksheets/sheet') ||
    name === 'xl/sharedStrings.xml'
  ) && name.endsWith('.xml');
}

function xmlToText(xml: string) {
  return xml
    .replace(/<\/?(w:p|a:p|row|xdr:row)[^>]*>/g, '\n')
    .replace(/<\/?(w:tab|a:tab)[^>]*>/g, '\t')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodePdfLiteral(value: string) {
  return value
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\')
    .replace(/\\([0-7]{1,3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)))
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .trim();
}

function looksLikeText(value: string) {
  if (value.length < 2) return false;
  const printable = [...value].filter((char) => /[\p{L}\p{N}\p{P}\p{Zs}\n]/u.test(char)).length;
  return printable / value.length > 0.75;
}

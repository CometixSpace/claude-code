import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import lief from 'node-lief';

const BUN_TRAILER = Buffer.from('\n---- Bun! ----\n');
const OFFSETS_SIZE = 32; // 8(size_t) + 8(SP) + 4(u32) + 8(SP) + 4(padding) = 32 on 64-bit
const MODULE_V1 = 36;
const MODULE_V2 = 52;
const MODULE_VERSIONS = [
  { name: 'v2', size: MODULE_V2 },
  { name: 'v1', size: MODULE_V1 },
];

const LOADERS = [
  'jsx','js','ts','tsx','css','file','json','jsonc',
  'toml','wasm','napi','base64','dataurl','text',
  'bunsh','sqlite','sqlite_embedded','html','yaml'
];
const ENCODINGS = ['binary','latin1','utf8'];
const FORMATS  = ['none','esm','cjs'];
export const BASE_PATH_POSIX   = '/$bunfs/';
export const BASE_PATH_WINDOWS = 'B:/~BUN/';

// Both virtual-filesystem roots Bun embeds. POSIX builds carry /$bunfs/root/,
// Windows builds B:/~BUN/root/ — a rewriter that only knows the first leaves
// every win32 path untouched.
export const BUNFS_ROOTS = [BASE_PATH_POSIX, BASE_PATH_WINDOWS].map((b) => `${b}root/`);
const BASE_PUBLIC_PATH  = 'root/';

// ──────────────────────────────────────────────
//  Section prefix detection (mirrors _detect_section_prefix)
// ──────────────────────────────────────────────

function detectSectionPrefix(sectionData) {
  const len = sectionData.length;
  if (len >= 8) {
    const sizeU64 = Number(sectionData.readBigUInt64LE(0));
    if (sizeU64 + 8 === len) return { prefixSize: 8, dataSize: sizeU64 };
  }
  if (len >= 4) {
    const sizeU32 = sectionData.readUInt32LE(0);
    if (sizeU32 + 4 === len) return { prefixSize: 4, dataSize: sizeU32 };
  }
  return null;
}

// ──────────────────────────────────────────────
//  Module struct detection (mirrors _detect_module_struct)
// ──────────────────────────────────────────────

function detectModuleStruct(modulesDataLen) {
  for (const v of MODULE_VERSIONS) {
    if (modulesDataLen > 0 && modulesDataLen % v.size === 0)
      return { version: v.name, size: v.size, count: modulesDataLen / v.size };
  }
  return null;
}

// ──────────────────────────────────────────────
//  Struct parsers
// ──────────────────────────────────────────────

function parseOffsets(buf, pos) {
  return {
    byteCount:    Number(buf.readBigUInt64LE(pos)),
    modulesPtr:   { offset: buf.readUInt32LE(pos + 8), length: buf.readUInt32LE(pos + 12) },
    entryPointId: buf.readUInt32LE(pos + 16),
  };
}

function parseModuleEntry(bunData, offset, entrySize) {
  const readSP = (o) => ({ offset: bunData.readUInt32LE(o), length: bunData.readUInt32LE(o + 4) });
  const extract = (sp) => sp.length > 0 ? bunData.subarray(sp.offset, sp.offset + sp.length) : null;

  const namePtr     = readSP(offset);
  const contentsPtr = readSP(offset + 8);
  const sourcemapPtr= readSP(offset + 16);

  const metaOffset = entrySize === MODULE_V2 ? offset + 48 : offset + 32;

  return {
    name:       extract(namePtr)?.toString('utf8') ?? '',
    contents:   extract(contentsPtr),
    sourcemap:  extract(sourcemapPtr),
    encoding:   ENCODINGS[bunData[metaOffset]]     ?? 'binary',
    loader:     LOADERS[bunData[metaOffset + 1]]    ?? 'unknown',
    format:     FORMATS[bunData[metaOffset + 2]]    ?? 'none',
    side:       bunData[metaOffset + 3] === 0 ? 'server' : 'client'
  };
}

// ──────────────────────────────────────────────
//  Parse bun data from section content
// ──────────────────────────────────────────────

function parseBunDataFromSection(sectionContent) {
  const prefix = detectSectionPrefix(sectionContent);
  if (!prefix) throw new Error('Section size prefix not recognized');

  const bunData = sectionContent.subarray(prefix.prefixSize, prefix.prefixSize + prefix.dataSize);

  if (bunData.length < OFFSETS_SIZE + BUN_TRAILER.length)
    throw new Error('Bun data too small');

  const trailerBytes = bunData.subarray(bunData.length - BUN_TRAILER.length);
  if (!trailerBytes.equals(BUN_TRAILER))
    throw new Error('Bun trailer mismatch');

  const offsetsStart = bunData.length - OFFSETS_SIZE - BUN_TRAILER.length;
  const offsets = parseOffsets(bunData, offsetsStart);

  return { prefixSize: prefix.prefixSize, offsets, bunData };
}

// ──────────────────────────────────────────────
//  Parse modules
// ──────────────────────────────────────────────

function parseModules(offsets, bunData) {
  const modulesRaw = bunData.subarray(offsets.modulesPtr.offset, offsets.modulesPtr.offset + offsets.modulesPtr.length);
  const info = detectModuleStruct(modulesRaw.length);
  if (!info) {
    const tried = MODULE_VERSIONS.map(v => `${v.name}=${v.size}`).join(', ');
    throw new Error(`Module struct not recognized (data=${modulesRaw.length} bytes, tried ${tried})`);
  }

  const modules = [];
  for (let i = 0; i < info.count; i++) {
    const entryOffset = offsets.modulesPtr.offset + i * info.size;
    modules.push(parseModuleEntry(bunData, entryOffset, info.size));
  }

  return { version: info.version, structSize: info.size, modules };
}

// ──────────────────────────────────────────────
//  Unified extraction via node-lief
//  Supports MachO (__BUN/__bun), PE (.bun), ELF (.bun)
// ──────────────────────────────────────────────

import { closeSync, openSync, readSync } from 'node:fs';

// Only the first four bytes decide the format, and lief re-reads the file
// itself. Slurping all of it — 345MB per platform on 2.1.242 — just to read
// a magic number doubles peak memory for no gain.
function readMagic(binaryPath) {
  const head = Buffer.alloc(4);
  const fd = openSync(binaryPath, 'r');
  try {
    readSync(fd, head, 0, 4, 0);
  } finally {
    closeSync(fd);
  }
  return head;
}

function findBunSection(binaryPath) {
  lief.logging.disable();

  const rawBuf = readMagic(binaryPath);
  const magic = rawBuf.readUInt32LE(0);
  let binFormat, basePath;

  if (magic === 0xFEEDFACF || magic === 0xCEFAEDFE) {
    binFormat = 'MachO';
    basePath = BASE_PATH_POSIX;
    const fat = lief.MachO.parse(binaryPath);
    const bin = fat.at(0);
    const seg = bin.getSegment('__BUN');
    if (!seg) throw new Error('MachO: __BUN segment not found');
    const sec = seg.getSection('__bun');
    if (!sec) throw new Error('MachO: __bun section not found');
    return { content: Buffer.from(sec.content), binFormat, basePath };
  }

  if (rawBuf.readUInt16LE(0) === 0x5A4D) {
    binFormat = 'PE';
    basePath = BASE_PATH_WINDOWS;
    const bin = lief.parse(binaryPath);
    const sec = bin.getSection('.bun');
    if (!sec) throw new Error('PE: .bun section not found');
    return { content: Buffer.from(sec.content), binFormat, basePath };
  }

  if (rawBuf.readUInt32BE(0) === 0x7F454C46) {
    binFormat = 'ELF';
    basePath = BASE_PATH_POSIX;
    const bin = lief.parse(binaryPath);
    const sec = bin.getSection('.bun');
    if (!sec) throw new Error('ELF: .bun section not found');
    return { content: Buffer.from(sec.content), binFormat, basePath };
  }

  throw new Error('Unsupported binary format');
}

// ──────────────────────────────────────────────
//  Main extraction
// ──────────────────────────────────────────────

export async function extractBunSEA(binaryPath) {
  const { content, binFormat, basePath } = findBunSection(binaryPath);
  const parsed = parseBunDataFromSection(content);
  const { offsets, bunData } = parsed;
  const { version, structSize, modules } = parseModules(offsets, bunData);

  return {
    binFormat,
    basePath,
    prefixSize: parsed.prefixSize,
    version,
    structSize,
    moduleCount: modules.length,
    entryPointId: offsets.entryPointId,
    entryPointName: modules[offsets.entryPointId]?.name ?? null,
    dataSize: bunData.length,
    modules
  };
}

// ──────────────────────────────────────────────
//  Extract to directory
// ──────────────────────────────────────────────

export async function extractToDir(binaryPath, outputDir) {
  const info = await extractBunSEA(binaryPath);

  console.log('='.repeat(50));
  console.log(' Phase 1: Inspecting binary');
  console.log('='.repeat(50));
  console.log(`Binary:          ${binaryPath}`);
  console.log(`Format:          ${info.binFormat}`);
  console.log(`Size prefix:     ${info.prefixSize} bytes`);
  console.log(`Module struct:   ${info.version} (${info.structSize} bytes/entry)`);
  console.log(`Base path:       ${info.basePath}`);
  console.log(`Data size:       ${info.dataSize} bytes`);
  console.log(`Module count:    ${info.moduleCount}`);
  console.log(`Entry point ID:  ${info.entryPointId}`);
  console.log();
  console.log('='.repeat(50));
  console.log(' Phase 2: Extracting modules');
  console.log('='.repeat(50));

  await mkdir(outputDir, { recursive: true });
  let extracted = 0;

  for (let idx = 0; idx < info.modules.length; idx++) {
    const mod = info.modules[idx];
    let name = mod.name;

    if (name.startsWith(info.basePath)) name = name.slice(info.basePath.length);
    if (name.startsWith(BASE_PUBLIC_PATH)) name = name.slice(BASE_PUBLIC_PATH.length);

    if (idx === info.entryPointId) {
      const ext = name.lastIndexOf('.');
      name = (ext > 0 ? name.slice(0, ext) : name) + '.' + mod.loader;
    }

    if (!mod.contents || mod.contents.length === 0) {
      console.log(`  [skip] ${name} (empty)`);
      continue;
    }

    const outPath = join(outputDir, name);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, mod.contents);
    console.log(`  [dump] ${name}`);
    extracted++;
  }

  console.log();
  console.log(`Done: ${extracted}/${info.moduleCount} modules extracted to ${outputDir}/`);
  return info;
}

// ──────────────────────────────────────────────
//  CLI
// ──────────────────────────────────────────────

const isMain = process.argv[1]?.endsWith('bun-sea-extract.mjs');
if (isMain) {
  const [binaryPath, outputDir] = process.argv.slice(2);
  if (!binaryPath) {
    console.error('Usage: node bun-sea-extract.mjs <binary> [outdir]');
    process.exit(1);
  }
  await extractToDir(binaryPath, outputDir ?? 'out');
}

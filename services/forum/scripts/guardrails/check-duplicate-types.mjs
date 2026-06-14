import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const ROOT = process.cwd();
const SHARED_DIRS = [
  path.join(ROOT, 'packages', 'core', 'src'),
  path.join(ROOT, 'packages', 'contracts', 'src'),
];
const SCAN_DIRS = [
  path.join(ROOT, 'packages'),
  path.join(ROOT, 'apps'),
];

const EXCLUDE_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.turbo',
  '.pnpm',
  '.worktrees',
  '.workspaces',
]);

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

function isDescendant(dir, candidate) {
  const rel = path.relative(dir, candidate);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function collectFiles(dir) {
  const files = [];
  if (!fs.existsSync(dir)) {
    return files;
  }
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDE_DIRS.has(entry.name)) {
          continue;
        }
        stack.push(path.join(current, entry.name));
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      if (!SOURCE_EXTENSIONS.has(path.extname(fullPath))) {
        continue;
      }
      files.push(fullPath);
    }
  }
  return files;
}

function getDeclarationName(node) {
  if (!node || !node.name) {
    return null;
  }
  if (ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  return null;
}

function isExported(node) {
  return Boolean(node.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword));
}

function collectDeclarations(filePath, { onlyExported }) {
  const sourceText = fs.readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const declarations = [];

  function visit(node) {
    if (
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isClassDeclaration(node)
    ) {
      const name = getDeclarationName(node);
      if (name && (!onlyExported || isExported(node))) {
        declarations.push({ name, kind: ts.SyntaxKind[node.kind] });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return declarations;
}

function collectSharedNames() {
  const shared = new Map();
  for (const dir of SHARED_DIRS) {
    const files = collectFiles(dir);
    for (const file of files) {
      const declarations = collectDeclarations(file, { onlyExported: true });
      for (const decl of declarations) {
        if (!shared.has(decl.name)) {
          shared.set(decl.name, []);
        }
        shared.get(decl.name).push({ file, kind: decl.kind });
      }
    }
  }
  return shared;
}

function collectDuplicates(shared) {
  const duplicates = [];
  const sharedDirs = SHARED_DIRS.map((dir) => path.resolve(dir));

  for (const dir of SCAN_DIRS) {
    const files = collectFiles(dir);
    for (const file of files) {
      const resolved = path.resolve(file);
      if (sharedDirs.some((sharedDir) => isDescendant(sharedDir, resolved))) {
        continue;
      }
      const declarations = collectDeclarations(file, { onlyExported: false });
      for (const decl of declarations) {
        if (shared.has(decl.name)) {
          duplicates.push({
            name: decl.name,
            kind: decl.kind,
            file,
            sharedFrom: shared.get(decl.name),
          });
        }
      }
    }
  }

  return duplicates;
}

const shared = collectSharedNames();
const duplicates = collectDuplicates(shared);

if (duplicates.length === 0) {
  console.log('guardrails: no duplicate core/contracts type declarations found.');
  process.exit(0);
}

console.error('guardrails: duplicate type declarations detected outside core/contracts:');
for (const dup of duplicates) {
  const sharedList = dup.sharedFrom
    .map((entry) => `${path.relative(ROOT, entry.file)} (${entry.kind})`)
    .join(', ');
  console.error(`- ${dup.name} (${dup.kind}) in ${path.relative(ROOT, dup.file)}; shared in ${sharedList}`);
}
process.exit(1);

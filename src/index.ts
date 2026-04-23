#!/usr/bin/env bun

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import readlineCore from "node:readline";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

type PackageJson = {
  name?: string;
  scripts?: Record<string, string>;
};

type DoitJson = {
  description?: string;
  instructions?: string;
  scripts?: Record<string, ScriptMetadata>;
};

type ScriptMetadata = {
  description?: string;
};

type PackageInfo = {
  dir: string;
  displayName: string;
  relativeDir: string;
  description?: string;
  scripts: string[];
  scriptMetadata: Record<string, ScriptMetadata>;
  tree: MenuNode;
};

type MenuNode = {
  label: string;
  scriptName?: string;
  children: Map<string, MenuNode>;
};

type CliOptions = {
  depth: number;
  init: boolean;
  root: string;
};

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".expo",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "out",
]);

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  magenta: "\x1b[35m",
  yellow: "\x1b[33m",
  gray: "\x1b[90m",
  inverse: "\x1b[7m",
};

function printHelp() {
  console.log(`JustDoIt

Usage:
  bunx doit [options]

Options:
  -d, --depth <number>  Maximum directory depth to scan for package.json files (default: 3)
  --init                Initialize or refresh package.doit.json files, then print a short agent prompt
  -r, --root <path>     Root directory to scan (default: current working directory)
  -h, --help            Show this help message

Behavior:
  - Discovers package.json files up to the configured depth.
  - Reads optional package.doit.json files next to package.json for package and script descriptions.
  - --init creates or refreshes package.doit.json files with placeholder descriptions and agent instructions.
  - Groups scripts by ":" into navigable submenus with no nesting limit.
  - Runs selected entries with "bun run <script-name>" in the owning package directory.

Controls:
  - Enter or [a-z] to select an item
  - 0, Left, or Backspace to go back
  - x to quit
`);
}

function parseArgs(argv: string[]): CliOptions | null {
  let depth = 3;
  let init = false;
  let root = process.cwd();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "-h" || arg === "--help") {
      printHelp();
      return null;
    }

    if (arg === "-d" || arg === "--depth") {
      const value = argv[index + 1];
      const parsed = Number(value);
      if (!value || Number.isNaN(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
        throw new Error(`Invalid depth: ${value ?? "(missing)"}`);
      }

      depth = parsed;
      index += 1;
      continue;
    }

    if (arg.startsWith("--depth=")) {
      const parsed = Number(arg.slice("--depth=".length));
      if (Number.isNaN(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
        throw new Error(`Invalid depth: ${arg.slice("--depth=".length)}`);
      }

      depth = parsed;
      continue;
    }

    if (arg === "-r" || arg === "--root") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing root path");
      }

      root = path.resolve(value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--root=")) {
      root = path.resolve(arg.slice("--root=".length));
      continue;
    }

    if (arg === "--init") {
      init = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { depth, init, root };
}

export async function scanForPackages(root: string, maxDepth: number): Promise<PackageInfo[]> {
  const results: PackageInfo[] = [];

  async function visit(currentDir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    const packageEntry = entries.find((entry) => entry.isFile() && entry.name === "package.json");
    if (packageEntry) {
      const packagePath = path.join(currentDir, packageEntry.name);
      const packageInfo = await loadPackage(packagePath, root);
      if (packageInfo) {
        results.push(packageInfo);
      }
    }

    if (depth >= maxDepth) {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      if (SKIPPED_DIRECTORIES.has(entry.name)) {
        continue;
      }

      await visit(path.join(currentDir, entry.name), depth + 1);
    }
  }

  await visit(root, 0);

  return results.sort((left, right) => left.relativeDir.localeCompare(right.relativeDir));
}

async function loadPackage(packagePath: string, root: string): Promise<PackageInfo | null> {
  try {
    const raw = await readFile(packagePath, "utf8");
    const parsed = JSON.parse(raw) as PackageJson;
    const scripts = Object.keys(parsed.scripts ?? {}).sort((left, right) => left.localeCompare(right));

    if (scripts.length === 0) {
      return null;
    }

    const dir = path.dirname(packagePath);
    const relativeDir = path.relative(root, dir) || ".";
    const displayName = parsed.name?.trim() || relativeDir;
    const metadata = await loadDoitMetadata(dir);

    return {
      dir,
      displayName,
      relativeDir,
      description: metadata.description,
      scripts,
      scriptMetadata: metadata.scripts ?? {},
      tree: buildTree(scripts),
    };
  } catch {
    return null;
  }
}

async function loadDoitMetadata(dir: string): Promise<DoitJson> {
  try {
    const raw = await readFile(path.join(dir, "package.doit.json"), "utf8");
    return JSON.parse(raw) as DoitJson;
  } catch {
    return {};
  }
}

export function buildTree(scripts: string[]): MenuNode {
  const root: MenuNode = {
    label: "root",
    children: new Map<string, MenuNode>(),
  };

  for (const script of scripts) {
    const parts = script.split(":");
    let current = root;

    for (const part of parts) {
      let next = current.children.get(part);
      if (!next) {
        next = {
          label: part,
          children: new Map<string, MenuNode>(),
        };
        current.children.set(part, next);
      }
      current = next;
    }

    current.scriptName = script;
  }

  return root;
}

function clearScreen() {
  if (output.isTTY) {
    output.write("\x1Bc");
  }
}

function paint(text: string, ...styles: string[]): string {
  if (!output.isTTY) {
    return text;
  }

  return `${styles.join("")}${text}${ANSI.reset}`;
}

function relativeLabel(pkg: PackageInfo): string {
  if (pkg.relativeDir === ".") {
    return `${pkg.displayName} (.)`;
  }

  return `${pkg.displayName} (${pkg.relativeDir})`;
}

async function promptSelection(rl: readline.Interface, max: number): Promise<string> {
  let answer: string;

  try {
    answer = (await rl.question("> ")).trim();
  } catch {
    return "q";
  }

  if (answer === "" && input.readableEnded) {
    return "q";
  }

  if (answer === "x" || answer === "b") {
    return answer;
  }

  if (answer === "0") {
    return answer;
  }

  if (/^[a-z]$/i.test(answer)) {
    const selected = answer.toLowerCase().charCodeAt(0) - 97;
    if (selected >= 0 && selected < max) {
      return answer.toLowerCase();
    }
    return "";
  }

  const selected = Number(answer);
  if (!Number.isInteger(selected) || selected < 1 || selected > max) {
    return "";
  }

  return answer;
}

function getScriptDescription(pkg: PackageInfo, scriptName?: string): string | undefined {
  if (!scriptName) {
    return undefined;
  }

  return pkg.scriptMetadata[scriptName]?.description?.trim() || undefined;
}

function formatOptionLabel(label: string, description?: string): string {
  if (!description) {
    return label;
  }

  return `${label} - ${description}`;
}

type MenuOption = {
  label: string;
  action: "open-package" | "run" | "navigate";
  description?: string;
  node?: MenuNode;
  pkg?: PackageInfo;
  scriptName?: string;
};

type MenuSection = {
  title: string;
  items: MenuOption[];
};

function buildNodeOptions(pkg: PackageInfo, current: MenuNode): MenuOption[] {
  const childNodes = [...current.children.values()];
  const options: MenuOption[] = [];

  if (current.scriptName) {
    options.push({
      label: `Run ${current.scriptName}`,
      action: "run",
      scriptName: current.scriptName,
      description: getScriptDescription(pkg, current.scriptName),
    });
  }

  for (const node of childNodes) {
    options.push({
      label: `${node.label}${node.children.size > 0 ? "/" : ""}`,
      action: node.children.size > 0 ? "navigate" : "run",
      node: node.children.size > 0 ? node : undefined,
      scriptName: node.children.size === 0 ? node.scriptName : undefined,
      description: getScriptDescription(pkg, node.scriptName),
    });
  }

  return options.sort((left, right) => {
    const leftRank = left.action === "run" ? 0 : left.action === "navigate" ? 1 : 2;
    const rightRank = right.action === "run" ? 0 : right.action === "navigate" ? 1 : 2;

    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    return left.label.localeCompare(right.label);
  });
}

function printSection(title: string) {
  console.log(paint(title, ANSI.bold, ANSI.yellow));
  console.log(paint("-".repeat(title.length), ANSI.gray));
}

function printOption(index: number, option: MenuOption) {
  console.log(`${index}. ${option.label}`);
  if (option.description) {
    console.log(`   ${option.description}`);
  }
}

function printHeader(title: string, description?: string, pathLabel?: string) {
  console.log(paint(title, ANSI.bold, ANSI.cyan));
  console.log(paint("=".repeat(title.length), ANSI.gray));
  if (description) {
    console.log(paint(description, ANSI.dim));
  }
  if (pathLabel) {
    console.log(paint(`Path: ${pathLabel}`, ANSI.gray));
  }
  console.log("");
}

function getOptionTint(option: MenuOption): string {
  if (option.action === "run") {
    return ANSI.green;
  }

  if (option.action === "navigate") {
    return ANSI.cyan;
  }

  return ANSI.magenta;
}

function getAlphaLabel(index: number): string {
  if (index < 0 || index > 25) {
    return "?";
  }

  return String.fromCharCode(97 + index);
}

function renderMenu(
  title: string,
  description: string | undefined,
  pathLabel: string | undefined,
  sections: MenuSection[],
  selectedIndex: number,
  backLabel: string,
) {
  clearScreen();
  if (pathLabel) {
    console.log(paint(`Path: ${pathLabel}`, ANSI.gray));
    console.log("");
  }

  const flatOptions = sections.flatMap((section) => section.items);
  let currentIndex = 0;

  for (const section of sections) {
    if (section.items.length === 0) {
      continue;
    }

    printSection(section.title);
    console.log("");

    for (const option of section.items) {
      const selected = currentIndex === selectedIndex;
      const marker = selected ? paint(">", ANSI.bold, ANSI.cyan) : " ";
      const indexLabel = paint(`[${getAlphaLabel(currentIndex)}]`, ANSI.gray);
      const label = paint(
        option.label,
        selected ? ANSI.inverse : "",
        selected ? ANSI.bold : "",
        getOptionTint(option),
      );
      const descriptionSuffix = option.description ? ` ${paint(option.description, ANSI.dim)}` : "";

      console.log(`${marker} ${indexLabel} ${label}${descriptionSuffix}`);
      currentIndex += 1;
    }

    console.log("");
  }

  const legend = `${backLabel}: 0 / Left / Backspace    Select: Enter or [a-z]    Move: Up/Down    Quit: x`;
  console.log(paint(legend, ANSI.gray));
  if (!input.isTTY || !output.isTTY || flatOptions.length === 0) {
    console.log("");
    console.log(paint("Type a letter and press Enter.", ANSI.gray));
  }
}

async function selectFromSections(
  rl: readline.Interface,
  title: string,
  description: string | undefined,
  pathLabel: string | undefined,
  sections: MenuSection[],
  backLabel: string,
): Promise<{ type: "back" | "quit" | "select"; option?: MenuOption }> {
  const flatOptions = sections.flatMap((section) => section.items);

  if (flatOptions.length === 0) {
    renderMenu(title, description, pathLabel, sections, 0, backLabel);
    return { type: "back" };
  }

  if (!input.isTTY || !output.isTTY) {
    renderMenu(title, description, pathLabel, sections, 0, backLabel);
    const answer = await promptSelection(rl, flatOptions.length);
    if (answer === "x") {
      return { type: "quit" };
    }
    if (answer === "0" || answer === "b") {
      return { type: "back" };
    }
    if (!answer) {
      return { type: "back" };
    }
    if (/^[a-z]$/.test(answer)) {
      return { type: "select", option: flatOptions[answer.charCodeAt(0) - 97] };
    }
    return { type: "select", option: flatOptions[Number(answer) - 1] };
  }

  return await new Promise((resolve) => {
    readlineCore.emitKeypressEvents(input);
    input.setRawMode?.(true);

    let selectedIndex = 0;
    let digitBuffer = "";
    let digitTimer: NodeJS.Timeout | undefined;

    const render = () => renderMenu(title, description, pathLabel, sections, selectedIndex, backLabel);
    const clearDigitBuffer = () => {
      digitBuffer = "";
      if (digitTimer) {
        clearTimeout(digitTimer);
        digitTimer = undefined;
      }
    };
    const cleanup = () => {
      clearDigitBuffer();
      input.off("keypress", onKeypress);
      input.setRawMode?.(false);
    };

    const onKeypress = (value: string, key: readlineCore.Key) => {
      if (key.sequence === "\u0003" || value === "x") {
        cleanup();
        resolve({ type: "quit" });
        return;
      }

      if (key.name === "up" || value === "k") {
        clearDigitBuffer();
        selectedIndex = (selectedIndex - 1 + flatOptions.length) % flatOptions.length;
        render();
        return;
      }

      if (key.name === "down" || value === "j") {
        clearDigitBuffer();
        selectedIndex = (selectedIndex + 1) % flatOptions.length;
        render();
        return;
      }

      if (key.name === "home" || value === "g") {
        clearDigitBuffer();
        selectedIndex = 0;
        render();
        return;
      }

      if (key.name === "end" || value === "G") {
        clearDigitBuffer();
        selectedIndex = flatOptions.length - 1;
        render();
        return;
      }

      if (key.name === "left" || key.name === "backspace" || value === "0" || key.name === "escape") {
        cleanup();
        resolve({ type: "back" });
        return;
      }

      if (key.name === "return" || key.name === "space") {
        cleanup();
        resolve({ type: "select", option: flatOptions[selectedIndex] });
        return;
      }

      if (/^[a-z]$/i.test(value)) {
        const alphaSelection = value.toLowerCase().charCodeAt(0) - 97;
        if (alphaSelection >= 0 && alphaSelection < flatOptions.length) {
          clearDigitBuffer();
          selectedIndex = alphaSelection;
          render();
          cleanup();
          resolve({ type: "select", option: flatOptions[alphaSelection] });
          return;
        }
      }
    };

    input.on("keypress", onKeypress);
    render();
  });
}

function buildInitPrompt(): string {
  return [
    "Copy this to your agent:",
    "Update the `package.doit.json` files in this repo. Fill in the package and script `description` fields with short, specific, user-facing text. Keep the `instructions` field, and only describe scripts that already exist in each `package.json`.",
  ].join("\n");
}

function buildInitializedMetadata(pkg: PackageInfo, existing: DoitJson): DoitJson {
  return {
    description: existing.description ?? "",
    instructions:
      existing.instructions ??
      "Fill in the package description and each script description. Keep them short, specific, and user-facing. Only document scripts that exist in package.json.",
    scripts: Object.fromEntries(
      pkg.scripts.map((script) => [
        script,
        {
          description: existing.scripts?.[script]?.description ?? "",
        },
      ]),
    ),
  };
}

async function initializeDoitFiles(packages: PackageInfo[]): Promise<string[]> {
  const writtenFiles: string[] = [];

  for (const pkg of packages) {
    const metadataPath = path.join(pkg.dir, "package.doit.json");
    const existing = await loadDoitMetadata(pkg.dir);
    const initialized = buildInitializedMetadata(pkg, existing);

    await writeFile(metadataPath, `${JSON.stringify(initialized, null, 2)}\n`, "utf8");
    writtenFiles.push(metadataPath);
  }

  return writtenFiles;
}

async function runScript(pkg: PackageInfo, scriptName: string): Promise<void> {
  console.log(`\nRunning bun run ${scriptName} in ${pkg.dir}\n`);

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("bun", ["run", scriptName], {
        cwd: pkg.dir,
        stdio: "inherit",
        shell: false,
      });

      child.on("exit", () => resolve());
      child.on("error", (error) => reject(error));
    });
  } catch (error) {
    console.error(`Failed to start bun: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!input.isTTY) {
    return;
  }

  console.log("\nPress Enter to return to the menu.");

  await new Promise<void>((resolve) => {
    input.once("data", () => resolve());
  });
}

async function browsePackage(rl: readline.Interface, pkg: PackageInfo): Promise<void> {
  await browsePackageNode(rl, pkg, pkg.tree, [pkg.displayName]);
}

async function browsePackageNode(
  rl: readline.Interface,
  pkg: PackageInfo,
  initialNode: MenuNode,
  initialBreadcrumbs: string[],
): Promise<void> {
  const stack: MenuNode[] = [initialNode];
  const breadcrumbs: string[] = [...initialBreadcrumbs];

  while (true) {
    const current = stack[stack.length - 1];
    const options = buildNodeOptions(pkg, current);

    const choice = await selectFromSections(
      rl,
      `Package: ${relativeLabel(pkg)}`,
      pkg.description,
      breadcrumbs.join(" / "),
      [{ title: "Commands", items: options }],
      "Back",
    );

    if (choice.type === "quit") {
      process.exit(0);
    }

    if (choice.type === "back") {
      if (stack.length === 1) {
        return;
      }

      stack.pop();
      breadcrumbs.pop();
      continue;
    }

    const option = choice.option;
    if (!option) {
      continue;
    }

    if (option.action === "run" && option.scriptName) {
      clearScreen();
      await runScript(pkg, option.scriptName);
      continue;
    }

    if (option.node) {
      stack.push(option.node);
      breadcrumbs.push(option.node.label);
    }
  }
}

async function runMenu(packages: PackageInfo[]) {
  const rl = readline.createInterface({
    input,
    output,
    terminal: Boolean(input.isTTY && output.isTTY),
  });
  const rootPackage = packages.find((pkg) => pkg.relativeDir === ".");
  const workspacePackages = packages.filter((pkg) => pkg.relativeDir !== ".");

  try {
    while (true) {
      const rootOptions = rootPackage ? buildNodeOptions(rootPackage, rootPackage.tree) : [];
      const workspaceOptions: MenuOption[] = workspacePackages.map((pkg) => ({
        label: relativeLabel(pkg),
        action: "open-package",
        description: pkg.description,
        pkg,
      }));
      const options = [...rootOptions, ...workspaceOptions];

      const choice = await selectFromSections(
        rl,
        "JustDoIt",
        rootPackage?.description,
        rootPackage?.dir ?? process.cwd(),
        [
          { title: "Root Commands", items: rootOptions },
          { title: "Workspaces", items: workspaceOptions },
        ],
        "Quit",
      );

      if (choice.type === "back" || choice.type === "quit") {
        return;
      }

      const selected = choice.option ?? options[0];
      if (!selected) {
        continue;
      }

      if (selected.action === "open-package" && selected.pkg) {
        await browsePackage(rl, selected.pkg);
        continue;
      }

      if (selected.action === "run" && selected.scriptName && rootPackage) {
        clearScreen();
        await runScript(rootPackage, selected.scriptName);
        continue;
      }

      if (selected.action === "navigate" && selected.node && rootPackage) {
        await browsePackageNode(rl, rootPackage, selected.node, [rootPackage.displayName, selected.node.label]);
      }
    }
  } finally {
    rl.close();
  }
}

async function main() {
  let options: CliOptions | null;

  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
    return;
  }

  if (!options) {
    return;
  }

  const packages = await scanForPackages(options.root, options.depth);

  if (packages.length === 0) {
    console.log(`No package.json files with scripts found under ${options.root}`);
    return;
  }

  if (options.init) {
    const writtenFiles = await initializeDoitFiles(packages);
    console.log("Initialized package.doit.json files:");
    writtenFiles.forEach((file) => {
      console.log(`- ${file}`);
    });
    console.log("");
    console.log(buildInitPrompt());
    return;
  }

  await runMenu(packages);
}

const entrypoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;

if (entrypoint === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

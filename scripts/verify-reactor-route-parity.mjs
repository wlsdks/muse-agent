#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const reactorRoot = readOption("--reactor") ?? process.env.REACTOR_SOURCE_DIR;
const museRoot = readOption("--muse") ?? process.cwd();

if (!reactorRoot) {
  console.error("Usage: REACTOR_SOURCE_DIR=/path/to/reactor pnpm verify:reactor-routes");
  console.error("   or: node scripts/verify-reactor-route-parity.mjs --reactor /path/to/reactor");
  process.exit(2);
}

const resolvedReactorRoot = path.resolve(reactorRoot);
const resolvedMuseRoot = path.resolve(museRoot);

if (!fs.existsSync(path.join(resolvedReactorRoot, "settings.gradle.kts"))) {
  console.error(`Reactor source directory is invalid: ${reactorRoot}`);
  process.exit(2);
}

if (!fs.existsSync(path.join(resolvedMuseRoot, "apps/api/src"))) {
  console.error(`Muse source directory is invalid: ${museRoot}`);
  process.exit(2);
}

const reactorRoutes = extractReactorRoutes(resolvedReactorRoot);
const museRoutes = extractMuseRoutes(resolvedMuseRoot);
const museRouteKeys = new Set(museRoutes.map((route) => `${route.method} ${route.genericPath}`));
const reactorRouteKeys = new Set(reactorRoutes.map((route) => `${route.method} ${route.genericPath}`));
const missingRoutes = reactorRoutes.filter((route) => !museRouteKeys.has(`${route.method} ${route.genericPath}`));
const extraApiRoutes = museRoutes.filter(
  (route) => route.path.startsWith("/api") && !reactorRouteKeys.has(`${route.method} ${route.genericPath}`)
);

console.log(`Reactor routes: ${reactorRoutes.length}`);
console.log(`Muse routes: ${museRoutes.length}`);
console.log(`Missing Reactor routes in Muse: ${missingRoutes.length}`);
console.log(`Extra Muse /api routes: ${extraApiRoutes.length}`);

if (missingRoutes.length > 0) {
  console.log("\nMissing routes:");

  for (const route of missingRoutes) {
    const sourceRef = `${path.relative(resolvedReactorRoot, route.file)}:${route.line}`;

    console.log(
      `${route.method} ${route.path} :: ${sourceRef} ${route.className}`
    );
  }

  process.exit(1);
}

if (extraApiRoutes.length > 0) {
  console.log("\nExtra Muse /api routes:");

  for (const route of extraApiRoutes) {
    console.log(`${route.method} ${route.path} :: ${path.relative(resolvedMuseRoot, route.file)}:${route.line}`);
  }
}

function readOption(name) {
  const index = args.indexOf(name);

  if (index === -1) {
    return undefined;
  }

  return args[index + 1];
}

function walk(directory, extension) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const paths = [];

  for (const entry of entries) {
    const target = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      paths.push(...walk(target, extension));
      continue;
    }

    if (entry.isFile() && target.endsWith(extension)) {
      paths.push(target);
    }
  }

  return paths;
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

function readAnnotation(source, index) {
  const nameMatch = source
    .slice(index)
    .match(/^@(RequestMapping|GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping)\b/);

  if (!nameMatch) {
    return undefined;
  }

  const name = nameMatch[1];
  let cursor = index + nameMatch[0].length;

  while (/\s/.test(source[cursor] ?? "")) {
    cursor += 1;
  }

  if (source[cursor] !== "(") {
    return { args: "", end: cursor, name };
  }

  const start = cursor;
  let depth = 0;
  let escaped = false;
  let inString = false;

  for (; cursor < source.length; cursor += 1) {
    const char = source[cursor];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }

      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;

      if (depth === 0) {
        return { args: source.slice(start + 1, cursor), end: cursor + 1, name };
      }
    }
  }

  return { args: source.slice(start + 1), end: source.length, name };
}

function extractStringLiterals(argsText) {
  const values = [];
  const literalPattern = /"((?:\\.|[^"\\])*)"/g;
  let match;

  while ((match = literalPattern.exec(argsText)) !== null) {
    values.push(match[1].replace(/\\"/g, "\""));
  }

  return values;
}

function extractPaths(argsText) {
  if (!argsText.trim()) {
    return [""];
  }

  const values = extractStringLiterals(argsText).filter((value) => value === "" || value.startsWith("/"));
  return values.length > 0 ? values : [""];
}

function extractMethods(name, argsText) {
  if (name === "GetMapping") {
    return ["GET"];
  }

  if (name === "PostMapping") {
    return ["POST"];
  }

  if (name === "PutMapping") {
    return ["PUT"];
  }

  if (name === "PatchMapping") {
    return ["PATCH"];
  }

  if (name === "DeleteMapping") {
    return ["DELETE"];
  }

  const methods = [...argsText.matchAll(/RequestMethod\.(GET|POST|PUT|PATCH|DELETE)/g)].map((match) => match[1]);
  return methods.length > 0 ? methods : ["ANY"];
}

function joinPaths(prefix, suffix) {
  const joined = `${prefix.replace(/\/+$/g, "")}/${suffix.replace(/^\/+/, "")}`.replace(/\/+/g, "/");
  return joined.replace(/\/$/u, "") || "/";
}

function normalizePath(routePath, generic = false) {
  const normalized = routePath
    .replace(/\{([^}/]+)\}/g, ":$1")
    .replace(/\/+/g, "/")
    .replace(/\/$/u, "") || "/";

  return generic ? normalized.replace(/:[^/]+/g, ":param") : normalized;
}

function uniqueRoutes(routes) {
  const seen = new Map();

  for (const route of routes) {
    const key = `${route.method} ${route.path}`;

    if (!seen.has(key)) {
      seen.set(key, route);
    }
  }

  return [...seen.values()].sort((left, right) =>
    `${left.path} ${left.method}`.localeCompare(`${right.path} ${right.method}`)
  );
}

function extractReactorRoutes(root) {
  const sourceDirs = ["app", "modules"]
    .map((directory) => path.join(root, directory))
    .filter((directory) => fs.existsSync(directory));
  const files = sourceDirs.flatMap((directory) => walk(directory, ".kt"));
  const routes = [];

  for (const file of files) {
    const rawSource = fs.readFileSync(file, "utf8");

    if (!rawSource.includes("@RestController") && !rawSource.includes("@Controller")) {
      continue;
    }

    const source = stripComments(rawSource);

    if (!source.includes("@RestController") && !source.includes("@Controller")) {
      continue;
    }

    const classes = [];
    const classPattern = /\b(?:open\s+)?class\s+([A-Za-z0-9_]+)/g;
    let classMatch;

    while ((classMatch = classPattern.exec(source)) !== null) {
      const beforeClass = source.slice(0, classMatch.index);
      const controllerIndex = Math.max(
        beforeClass.lastIndexOf("@RestController"),
        beforeClass.lastIndexOf("@Controller")
      );
      const requestMappingIndex = beforeClass.lastIndexOf("@RequestMapping");

      if (controllerIndex === -1 || requestMappingIndex < controllerIndex) {
        continue;
      }

      const annotation = readAnnotation(source, requestMappingIndex);

      classes.push({
        className: classMatch[1],
        end: source.length,
        prefixes: extractPaths(annotation?.args ?? ""),
        start: classMatch.index
      });
    }

    classes.sort((left, right) => left.start - right.start);

    for (let index = 0; index < classes.length; index += 1) {
      classes[index].end = classes[index + 1]?.start ?? source.length;
    }

    for (const controllerClass of classes) {
      const body = source.slice(controllerClass.start, controllerClass.end);
      const annotationPattern = /@(RequestMapping|GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping)\b/g;
      let annotationMatch;

      while ((annotationMatch = annotationPattern.exec(body)) !== null) {
        const annotationIndex = controllerClass.start + annotationMatch.index;
        const annotation = readAnnotation(source, annotationIndex);

        if (!annotation) {
          continue;
        }

        annotationPattern.lastIndex = annotation.end - controllerClass.start;

        const nextBlock = source.slice(annotation.end, Math.min(source.length, annotation.end + 1000));
        const nextDeclaration = nextBlock.match(/\b(fun|class|open\s+class)\b/);

        if (!nextDeclaration || nextDeclaration[1] !== "fun") {
          continue;
        }

        for (const prefix of controllerClass.prefixes) {
          for (const suffix of extractPaths(annotation.args)) {
            for (const method of extractMethods(annotation.name, annotation.args)) {
              const routePath = normalizePath(joinPaths(prefix, suffix));

              routes.push({
                className: controllerClass.className,
                file,
                genericPath: normalizePath(routePath, true),
                line: lineOf(source, annotationIndex),
                method,
                path: routePath
              });
            }
          }
        }
      }
    }
  }

  return uniqueRoutes(routes);
}

function extractMuseRoutes(root) {
  const apiSourceDir = path.join(root, "apps/api/src");
  const files = walk(apiSourceDir, ".ts");
  const routes = [];
  const routePattern = /server\.(get|post|put|patch|delete)\s*\(\s*([`'"])([\s\S]*?)\2/g;

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const prefixes = extractLoopValues(source, "prefix");
    const dynamicRoutes = extractLoopValues(source, "route");
    let match;

    while ((match = routePattern.exec(source)) !== null) {
      const method = match[1].toUpperCase();
      const expression = match[3];
      let expanded = [expression];

      if (expression.includes("${prefix}")) {
        expanded = prefixes.map((prefix) => expression.replace(/\$\{prefix\}/g, prefix));
      }

      if (expression.includes("${route}")) {
        expanded = dynamicRoutes.map((route) => expression.replace(/\$\{route\}/g, route));
      }

      if (expression.includes("${") && !expression.includes("${prefix}") && !expression.includes("${route}")) {
        continue;
      }

      for (const routePath of expanded) {
        const normalized = normalizePath(routePath);

        routes.push({
          file,
          genericPath: normalizePath(normalized, true),
          line: lineOf(source, match.index),
          method,
          path: normalized
        });
      }
    }
  }

  return uniqueRoutes(routes);
}

function extractLoopValues(source, variableName) {
  const loopPattern = new RegExp(`for\\s*\\(\\s*const\\s+${variableName}\\s+of\\s+\\[([^\\]]+)\\]\\s*\\)`, "g");
  const values = [];
  let loopMatch;

  while ((loopMatch = loopPattern.exec(source)) !== null) {
    values.push(...[...loopMatch[1].matchAll(/"([^"]*)"|'([^']*)'/g)].map((match) => match[1] ?? match[2]));
  }

  return values.length > 0 ? values : [""];
}

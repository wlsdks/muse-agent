import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

function isInside(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === ""
    || (
      pathFromRoot !== ".."
      && !pathFromRoot.startsWith(`..${sep}`)
      && !isAbsolute(pathFromRoot)
    );
}

export function bindCapabilityArtifactRoot(repoRoot, requestedRoot) {
  if (typeof requestedRoot !== "string" || requestedRoot.length === 0) {
    throw new Error("capability-artifact-root-required");
  }
  if (
    requestedRoot.trim() !== requestedRoot
    || requestedRoot.includes("\0")
    || !isAbsolute(requestedRoot)
  ) {
    throw new Error("capability-artifact-root-unsafe");
  }

  const repository = realpathSync(resolve(repoRoot));
  const rootInput = resolve(requestedRoot);
  if (rootInput !== requestedRoot) {
    throw new Error("capability-artifact-root-unsafe");
  }
  const inputStat = lstatSync(rootInput);
  const root = realpathSync(rootInput);
  const rootStat = lstatSync(root);
  if (
    root !== rootInput
    || !inputStat.isDirectory()
    || inputStat.isSymbolicLink()
    || !rootStat.isDirectory()
    || rootStat.isSymbolicLink()
    || inputStat.dev !== rootStat.dev
    || inputStat.ino !== rootStat.ino
  ) {
    throw new Error("capability-artifact-root-unsafe");
  }
  if (isInside(repository, root) || isInside(root, repository)) {
    throw new Error("capability-artifact-root-outside-repository");
  }
  return Object.freeze({ dev: rootStat.dev, ino: rootStat.ino, root });
}

export function assertCapabilityArtifactRoot(binding) {
  if (
    !binding
    || typeof binding.root !== "string"
    || !Number.isSafeInteger(binding.dev)
    || !Number.isSafeInteger(binding.ino)
  ) {
    throw new Error("capability-artifact-root-changed");
  }
  const root = realpathSync(binding.root);
  const stat = lstatSync(root);
  if (
    root !== binding.root
    || !stat.isDirectory()
    || stat.isSymbolicLink()
    || stat.dev !== binding.dev
    || stat.ino !== binding.ino
  ) {
    throw new Error("capability-artifact-root-changed");
  }
  return binding.root;
}

export function capabilityReportPath(binding) {
  return join(assertCapabilityArtifactRoot(binding), "latest.json");
}

export function capabilityRunnerPath(binding) {
  const executable = process.platform === "win32" ? "muse-runner.exe" : "muse-runner";
  return join(assertCapabilityArtifactRoot(binding), executable);
}

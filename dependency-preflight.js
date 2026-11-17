'use strict';

const ALLOWED_REGISTRY_HOSTS = new Set(['registry.npmjs.org']);
const LIFECYCLE_SCRIPTS = new Set(['preinstall', 'install', 'postinstall', 'prepare']);

function validateDependencyPreflight({ packageData, lockData }) {
  const errors = [];
  if (!packageData || typeof packageData !== 'object' || Array.isArray(packageData)) {
    return { passed: false, errors: ['package.json must contain an object.'] };
  }
  if (!lockData || typeof lockData !== 'object' || Array.isArray(lockData)) {
    return { passed: false, errors: ['package-lock.json must contain an object.'] };
  }
  if (![2, 3].includes(lockData.lockfileVersion) || !lockData.packages || typeof lockData.packages !== 'object') {
    errors.push('A package-lock v2 or v3 with a packages map is required.');
  }
  const scripts = packageData.scripts || {};
  for (const name of LIFECYCLE_SCRIPTS) {
    if (Object.prototype.hasOwnProperty.call(scripts, name)) {
      errors.push('Project lifecycle script is not allowed: ' + name);
    }
  }
  const deps = {
    ...(packageData.dependencies || {}),
    ...(packageData.optionalDependencies || {})
  };
  for (const [name, spec] of Object.entries(deps)) {
    if (typeof spec !== 'string' || /^(git\+|git:|https?:|file:|link:|workspace:)/i.test(spec)) {
      errors.push('Non-registry dependency spec is not allowed: ' + name);
    }
  }
  if (lockData.packages && typeof lockData.packages === 'object') {
    for (const [path, entry] of Object.entries(lockData.packages)) {
      if (!path || path === '') continue;
      if (!entry || typeof entry !== 'object' || entry.link === true) {
        errors.push('Invalid or linked lockfile package: ' + path);
        continue;
      }
      if (entry.dev === true) continue;
      if (entry.optional === true && !entry.resolved) continue;
      if (typeof entry.resolved !== 'string') {
        errors.push('Missing resolved registry URL: ' + path);
        continue;
      }
      let url;
      try { url = new URL(entry.resolved); } catch {
        errors.push('Invalid package URL: ' + path);
        continue;
      }
      if (url.protocol !== 'https:' || !ALLOWED_REGISTRY_HOSTS.has(url.hostname) || url.username || url.password) {
        errors.push('Package URL is outside the approved HTTPS npm registry: ' + path);
      }
      if (typeof entry.integrity !== 'string' || !/^sha(?:256|384|512)-[A-Za-z0-9+/]+=*$/.test(entry.integrity)) {
        errors.push('Missing supported integrity hash: ' + path);
      }
    }
  }
  return { passed: errors.length === 0, errors };
}

module.exports = { validateDependencyPreflight };

'use strict';

const crypto = require('node:crypto');

const MAX_TEXT_LENGTH = 3500;
const MAX_COMMANDS = 30;

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ':' + stableJson(value[key])
    ).join(',') + '}';
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function cleanText(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TEXT_LENGTH) {
    throw new Error(field + ' must be a non-empty string no longer than ' + MAX_TEXT_LENGTH + ' characters.');
  }
  return value.trim();
}

function validateCustomerBotConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('boss-telegram.json must contain an object.');
  }

  const allowedKeys = new Set(['schemaVersion', 'welcomeText', 'helpText', 'commands']);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) throw new Error('Unsupported Telegram runtime config field: ' + key);
  }
  if (input.schemaVersion !== 1) throw new Error('Unsupported Telegram runtime config schemaVersion.');

  if (!Array.isArray(input.commands) || input.commands.length > MAX_COMMANDS) {
    throw new Error('commands must be an array with no more than ' + MAX_COMMANDS + ' entries.');
  }

  const seen = new Set(['start', 'help']);
  const commands = input.commands.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('commands[' + index + '] must be an object.');
    }
    const keys = Object.keys(item);
    if (keys.some(key => !['command', 'description', 'text'].includes(key))) {
      throw new Error('commands[' + index + '] contains an unsupported field.');
    }
    const command = item.command;
    if (typeof command !== 'string' || !/^[a-z0-9_]{1,32}$/.test(command)) {
      throw new Error('commands[' + index + '].command is invalid.');
    }
    if (seen.has(command)) throw new Error('Duplicate or reserved Telegram command: ' + command);
    seen.add(command);
    const description = cleanText(item.description, 'commands[' + index + '].description');
    if (description.length > 256) throw new Error('Telegram command descriptions cannot exceed 256 characters.');
    return {
      command,
      description,
      text: cleanText(item.text, 'commands[' + index + '].text')
    };
  });

  return {
    schemaVersion: 1,
    welcomeText: cleanText(input.welcomeText, 'welcomeText'),
    helpText: cleanText(input.helpText, 'helpText'),
    commands
  };
}

async function loadApprovedCustomerBotConfig({ pool, record } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('PostgreSQL pool is required.');
  if (!record || !/^\\d+$/.test(String(record.project_id || '')) ||
      !/^\\d+$/.test(String(record.client_id || ''))) {
    return null;
  }

  const result = await pool.query(`
    SELECT r.id, r.release_version, r.artifact, r.artifact_sha256
    FROM project_release_candidates r
    JOIN project_deployment_authorizations a
      ON a.release_id = r.id AND a.status = 'authorized'
    JOIN client_projects p
      ON p.id = r.project_id AND p.client_id = $2
    WHERE r.project_id = $1
      AND r.status = 'approved'
    ORDER BY r.release_version DESC, r.id DESC
    LIMIT 1
  `, [record.project_id, record.client_id]);

  if (!result.rowCount) {
    throw new Error('No approved and manager-authorized release is available for this customer bot.');
  }

  const release = result.rows[0];
  if (!release.artifact || !/^[a-f0-9]{64}$/.test(String(release.artifact_sha256 || '')) ||
      sha256(stableJson(release.artifact)) !== release.artifact_sha256) {
    throw new Error('Approved customer bot release failed its integrity check.');
  }

  const files = release.artifact.bundle?.files;
  if (!Array.isArray(files)) throw new Error('Approved customer bot release has no bundle files.');
  const configFile = files.find(file => file && file.path === 'boss-telegram.json');
  if (!configFile || typeof configFile.content !== 'string') {
    throw new Error('Approved release is missing boss-telegram.json.');
  }

  let parsed;
  try {
    parsed = JSON.parse(configFile.content);
  } catch (error) {
    throw new Error('boss-telegram.json is invalid JSON: ' + error.message);
  }

  return {
    ...validateCustomerBotConfig(parsed),
    releaseId: String(release.id),
    releaseVersion: Number(release.release_version),
    artifactSha256: release.artifact_sha256
  };
}

module.exports = {
  validateCustomerBotConfig,
  loadApprovedCustomerBotConfig,
  stableJson,
  sha256
};

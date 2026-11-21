'use strict';

const crypto = require('node:crypto');

const MAX_TEXT_LENGTH = 3500;
const MAX_COMMANDS = 30;
const MAX_BUTTONS_PER_COMMAND = 8;

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
  const seenCallbacks = new Set();
  const commands = input.commands.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('commands[' + index + '] must be an object.');
    }
    const keys = Object.keys(item);
    if (keys.some(key => !['command', 'description', 'text', 'buttons'].includes(key))) {
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
    const buttons = item.buttons === undefined ? [] : item.buttons;
    if (!Array.isArray(buttons) || buttons.length > MAX_BUTTONS_PER_COMMAND) {
      throw new Error('commands[' + index + '].buttons must contain no more than ' + MAX_BUTTONS_PER_COMMAND + ' buttons.');
    }
    const validatedButtons = buttons.map((button, buttonIndex) => {
      if (!button || typeof button !== 'object' || Array.isArray(button)) {
        throw new Error('commands[' + index + '].buttons[' + buttonIndex + '] must be an object.');
      }
      if (Object.keys(button).some(key => !['text', 'callbackData', 'responseText'].includes(key))) {
        throw new Error('commands[' + index + '].buttons[' + buttonIndex + '] contains an unsupported field.');
      }
      const text = cleanText(button.text, 'commands[' + index + '].buttons[' + buttonIndex + '].text');
      if (Buffer.byteLength(text, 'utf8') > 64) {
        throw new Error('Telegram inline button labels cannot exceed 64 UTF-8 bytes.');
      }
      if (typeof button.callbackData !== 'string' ||
          !/^[A-Za-z0-9:_-]{1,64}$/.test(button.callbackData)) {
        throw new Error('Telegram callback data must use 1-64 safe ASCII characters.');
      }
      if (seenCallbacks.has(button.callbackData)) {
        throw new Error('Duplicate Telegram callback data: ' + button.callbackData);
      }
      seenCallbacks.add(button.callbackData);
      return {
        text,
        callbackData: button.callbackData,
        responseText: cleanText(
          button.responseText,
          'commands[' + index + '].buttons[' + buttonIndex + '].responseText'
        )
      };
    });
    return {
      command,
      description,
      text: cleanText(item.text, 'commands[' + index + '].text'),
      buttons: validatedButtons
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
  if (!record || !/^\d+$/.test(String(record.project_id || '')) ||
      !/^\d+$/.test(String(record.client_id || ''))) {
    return null;
  }

  const result = await pool.query(`
    SELECT r.id, r.project_id, r.release_version, r.spec_version,
           r.artifact, r.artifact_sha256,
           a.authorized_by, a.authorization_sha256
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
  const authorizationPayload = {
    releaseId: String(release.id),
    projectId: String(release.project_id),
    releaseVersion: Number(release.release_version),
    specVersion: Number(release.spec_version),
    artifactSha256: String(release.artifact_sha256 || ''),
    authorizedBy: String(release.authorized_by || '')
  };
  if (!/^[a-f0-9]{64}$/.test(String(release.authorization_sha256 || '')) ||
      sha256(stableJson(authorizationPayload)) !== release.authorization_sha256) {
    throw new Error('Approved customer bot deployment authorization failed its integrity check.');
  }

  if (!release.artifact || !/^[a-f0-9]{64}$/.test(String(release.artifact_sha256 || '')) ||
      sha256(stableJson(release.artifact)) !== release.artifact_sha256) {
    throw new Error('Approved customer bot release failed its integrity check.');
  }
  if (String(release.artifact.report?.project?.id || '') !== String(record.project_id)) {
    throw new Error('Approved customer bot release belongs to a different project.');
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
